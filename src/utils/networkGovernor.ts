import { availableParallelism, freemem } from 'node:os';

export type NetworkPolicyMode = 'adaptive' | 'fixed';
export type TransferPriority =
    | 'interactive'
    | 'writeback'
    | 'full-sync'
    | 'metadata'
    | 'maintenance';
export type TransferDirection = 'upload' | 'download' | 'metadata';

export interface NetworkPolicy {
    mode: NetworkPolicyMode;
    maxFileTransfers: number;
    maxConnections: number;
    maxInFlightBytes: number;
    maxUploadBps: number;
    maxDownloadBps: number;
    metadataConcurrency: number;
}

export interface NetworkSnapshot {
    state: 'online' | 'degraded' | 'offline' | 'rate_limited';
    policy: NetworkPolicy;
    effectiveFileTransfers: number;
    activeTransfers: number;
    queuedTransfers: number;
    inFlightBytes: number;
    uploadBps: number;
    downloadBps: number;
    errorRate: number;
    retryAfter: number | null;
}

interface QueueEntry<T> {
    priority: TransferPriority;
    estimatedBytes: number;
    signal?: AbortSignal;
    task: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
}

const PRIORITY_WEIGHTS: Record<TransferPriority, number> = {
    interactive: 8,
    writeback: 6,
    'full-sync': 5,
    metadata: 3,
    maintenance: 1,
};

const DEFAULT_MAX_IN_FLIGHT = Math.max(
    32 * 1024 * 1024,
    Math.min(256 * 1024 * 1024, Math.floor(freemem() * 0.1)),
);

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
    mode: 'adaptive',
    maxFileTransfers: Math.max(1, Math.min(5, availableParallelism())),
    maxConnections: 16,
    maxInFlightBytes: DEFAULT_MAX_IN_FLIGHT,
    maxUploadBps: 0,
    maxDownloadBps: 0,
    metadataConcurrency: 4,
};

/**
 * Shared bounded scheduler and aggregate token bucket for all application
 * traffic. The SDK retains ownership of its internal block scheduling and
 * integrity retries.
 */
export class NetworkGovernor {
    private policy: NetworkPolicy;
    private effectiveFileTransfers: number;
    private activeTransfers = 0;
    private activeMetadata = 0;
    private inFlightBytes = 0;
    private queues = new Map<TransferPriority, QueueEntry<any>[]>();
    private roundRobinCredits = new Map<TransferPriority, number>();
    private state: NetworkSnapshot['state'] = 'online';
    private retryAfter: number | null = null;
    private healthyWindows = 0;
    private windowBytes = { upload: 0, download: 0 };
    private lastRates = { upload: 0, download: 0 };
    private windowSuccesses = 0;
    private windowErrors = 0;
    private lastWindowAt = Date.now();
    private tokens = { upload: 0, download: 0 };
    private tokenUpdatedAt = { upload: Date.now(), download: Date.now() };
    private readonly adaptiveTimer: ReturnType<typeof setInterval> | null;

    constructor(policy: Partial<NetworkPolicy> = {}, startAdaptiveTimer = true) {
        this.policy = this.normalizePolicy({ ...DEFAULT_NETWORK_POLICY, ...policy });
        this.effectiveFileTransfers = this.policy.mode === 'adaptive'
            ? Math.min(2, this.policy.maxFileTransfers)
            : this.policy.maxFileTransfers;
        for (const priority of Object.keys(PRIORITY_WEIGHTS) as TransferPriority[]) {
            this.queues.set(priority, []);
            this.roundRobinCredits.set(priority, PRIORITY_WEIGHTS[priority]);
        }
        this.adaptiveTimer = startAdaptiveTimer
            ? setInterval(() => this.evaluateWindow(), 5_000)
            : null;
        this.adaptiveTimer?.unref();
    }

    configure(update: Partial<NetworkPolicy>): NetworkPolicy {
        const rateChanged =
            (update.maxUploadBps !== undefined &&
                update.maxUploadBps !== this.policy.maxUploadBps) ||
            (update.maxDownloadBps !== undefined &&
                update.maxDownloadBps !== this.policy.maxDownloadBps);
        this.policy = this.normalizePolicy({ ...this.policy, ...update });
        if (rateChanged) {
            this.tokens = { upload: 0, download: 0 };
            this.tokenUpdatedAt = { upload: Date.now(), download: Date.now() };
        }
        if (this.policy.mode === 'fixed') {
            this.effectiveFileTransfers = this.policy.maxFileTransfers;
        } else {
            this.effectiveFileTransfers = Math.min(
                this.effectiveFileTransfers,
                this.policy.maxFileTransfers,
            );
        }
        this.dispatch();
        return this.policy;
    }

    schedule<T>(
        priority: TransferPriority,
        estimatedBytes: number,
        task: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new DOMException('Transfer aborted', 'AbortError'));
        }
        if (this.getQueueDepth() >= 10_000) {
            return Promise.reject(new Error('Network governor queue capacity exceeded'));
        }
        return new Promise<T>((resolve, reject) => {
            this.queues.get(priority)!.push({
                priority,
                estimatedBytes: Math.max(0, estimatedBytes),
                signal,
                task,
                resolve,
                reject,
            });
            this.dispatch();
        });
    }

    async throttle(direction: Exclude<TransferDirection, 'metadata'>, bytes: number): Promise<void> {
        if (bytes <= 0) return;
        this.windowBytes[direction] += bytes;
        const limit = direction === 'upload'
            ? this.policy.maxUploadBps
            : this.policy.maxDownloadBps;
        if (limit <= 0) return;

        let remaining = bytes;
        while (remaining > 0) {
            this.refillTokens(direction, limit);
            const available = Math.min(remaining, this.tokens[direction]);
            if (available > 0) {
                this.tokens[direction] -= available;
                remaining -= available;
            }
            if (remaining <= 0) return;
            const missing = Math.min(remaining, limit) - this.tokens[direction];
            const delayMs = Math.max(1, Math.ceil((missing / limit) * 1_000));
            await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 1_000)));
        }
    }

    reportSuccess(): void {
        this.windowSuccesses++;
        if (this.state !== 'rate_limited') this.state = 'online';
    }

    reportFailure(error: any): void {
        this.windowErrors++;
        const retryAfterMs = parseRetryAfter(error);
        if (retryAfterMs !== null) {
            this.retryAfter = Date.now() + retryAfterMs;
            this.state = 'rate_limited';
            this.decreaseCapacity();
        } else if (isLikelyNetworkError(error)) {
            this.state = 'offline';
            this.decreaseCapacity();
        } else if ((error?.status ?? 0) >= 500) {
            this.state = 'degraded';
            this.decreaseCapacity();
        }
    }

    getSnapshot(): NetworkSnapshot {
        const total = this.windowSuccesses + this.windowErrors;
        return {
            state: this.retryAfter && this.retryAfter > Date.now() ? 'rate_limited' : this.state,
            policy: { ...this.policy },
            effectiveFileTransfers: this.effectiveFileTransfers,
            activeTransfers: this.activeTransfers,
            queuedTransfers: this.getQueueDepth(),
            inFlightBytes: this.inFlightBytes,
            uploadBps: this.lastRates.upload,
            downloadBps: this.lastRates.download,
            errorRate: total > 0 ? this.windowErrors / total : 0,
            retryAfter: this.retryAfter,
        };
    }

    getQueueDepth(): number {
        let total = 0;
        for (const queue of this.queues.values()) total += queue.length;
        return total;
    }

    close(): void {
        if (this.adaptiveTimer) clearInterval(this.adaptiveTimer);
        for (const queue of this.queues.values()) {
            for (const entry of queue.splice(0)) {
                entry.reject(new DOMException('Network governor closed', 'AbortError'));
            }
        }
    }

    /** Exposed for deterministic tests and diagnostics. */
    evaluateWindow(now = Date.now()): void {
        const elapsedSeconds = Math.max(0.001, (now - this.lastWindowAt) / 1_000);
        this.lastRates.upload = Math.round(this.windowBytes.upload / elapsedSeconds);
        this.lastRates.download = Math.round(this.windowBytes.download / elapsedSeconds);
        const total = this.windowSuccesses + this.windowErrors;
        const errorRate = total > 0 ? this.windowErrors / total : 0;
        const memoryPressure = this.inFlightBytes > this.policy.maxInFlightBytes;
        const rateLimited = Boolean(this.retryAfter && this.retryAfter > now);

        if (this.policy.mode === 'adaptive') {
            if (rateLimited || errorRate >= 0.1 || memoryPressure) {
                this.healthyWindows = 0;
                this.decreaseCapacity();
            } else {
                this.healthyWindows++;
                if (
                    this.healthyWindows >= 2 &&
                    this.effectiveFileTransfers < this.policy.maxFileTransfers
                ) {
                    this.effectiveFileTransfers++;
                    this.healthyWindows = 0;
                }
            }
        }

        if (this.retryAfter && this.retryAfter <= now) {
            this.retryAfter = null;
            this.state = errorRate > 0 ? 'degraded' : 'online';
        } else if (!rateLimited && errorRate === 0) {
            this.state = 'online';
        }

        this.windowBytes = { upload: 0, download: 0 };
        this.windowSuccesses = 0;
        this.windowErrors = 0;
        this.lastWindowAt = now;
        this.dispatch();
    }

    private normalizePolicy(policy: NetworkPolicy): NetworkPolicy {
        return {
            mode: policy.mode === 'fixed' ? 'fixed' : 'adaptive',
            maxFileTransfers: clampInteger(policy.maxFileTransfers, 1, 5),
            maxConnections: clampInteger(policy.maxConnections, 2, 64),
            maxInFlightBytes: Math.min(
                DEFAULT_MAX_IN_FLIGHT,
                Math.max(8 * 1024 * 1024, Math.floor(policy.maxInFlightBytes)),
            ),
            maxUploadBps: Math.max(0, Math.floor(policy.maxUploadBps)),
            maxDownloadBps: Math.max(0, Math.floor(policy.maxDownloadBps)),
            metadataConcurrency: clampInteger(policy.metadataConcurrency, 1, 8),
        };
    }

    private decreaseCapacity(): void {
        this.effectiveFileTransfers = Math.max(1, Math.floor(this.effectiveFileTransfers / 2));
    }

    private dispatch(): void {
        while (this.activeTransfers < this.effectiveFileTransfers) {
            const entry = this.takeNextEligible();
            if (!entry) return;
            if (entry.signal?.aborted) {
                entry.reject(entry.signal.reason ?? new DOMException('Transfer aborted', 'AbortError'));
                continue;
            }
            this.activeTransfers++;
            if (entry.priority === 'metadata') this.activeMetadata++;
            this.inFlightBytes += entry.estimatedBytes;
            void entry.task()
                .then((value) => {
                    this.reportSuccess();
                    entry.resolve(value);
                })
                .catch((error) => {
                    this.reportFailure(error);
                    entry.reject(error);
                })
                .finally(() => {
                    this.activeTransfers--;
                    if (entry.priority === 'metadata') this.activeMetadata--;
                    this.inFlightBytes = Math.max(0, this.inFlightBytes - entry.estimatedBytes);
                    this.dispatch();
                });
        }
    }

    private takeNextEligible(): QueueEntry<any> | null {
        if (this.retryAfter && this.retryAfter > Date.now()) return null;
        for (let pass = 0; pass < 2; pass++) {
            for (const priority of Object.keys(PRIORITY_WEIGHTS) as TransferPriority[]) {
                const queue = this.queues.get(priority)!;
                const credits = this.roundRobinCredits.get(priority) ?? 0;
                if (queue.length === 0 || credits <= 0) continue;
                if (priority === 'metadata' && this.activeMetadata >= this.policy.metadataConcurrency) {
                    continue;
                }
                const candidate = queue[0];
                if (
                    this.activeTransfers > 0 &&
                    candidate.estimatedBytes > 0 &&
                    this.inFlightBytes + candidate.estimatedBytes > this.policy.maxInFlightBytes
                ) {
                    continue;
                }
                this.roundRobinCredits.set(priority, credits - 1);
                return queue.shift()!;
            }
            for (const priority of Object.keys(PRIORITY_WEIGHTS) as TransferPriority[]) {
                this.roundRobinCredits.set(priority, PRIORITY_WEIGHTS[priority]);
            }
        }
        return null;
    }

    private refillTokens(direction: 'upload' | 'download', limit: number): void {
        const now = Date.now();
        const elapsed = Math.max(0, now - this.tokenUpdatedAt[direction]) / 1_000;
        this.tokenUpdatedAt[direction] = now;
        const capacity = limit;
        this.tokens[direction] = Math.min(capacity, this.tokens[direction] + elapsed * limit);
    }
}

function clampInteger(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));
}

function parseRetryAfter(error: any): number | null {
    const raw = error?.response?.headers?.get?.('retry-after') ?? error?.retryAfter;
    if (raw === undefined || raw === null) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const timestamp = Date.parse(String(raw));
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function isLikelyNetworkError(error: any): boolean {
    return (
        error?.name === 'TypeError' ||
        error?.code === 'ECONNRESET' ||
        error?.code === 'ECONNREFUSED' ||
        error?.code === 'ENETUNREACH' ||
        error?.code === 'ETIMEDOUT'
    );
}

let sharedGovernor: NetworkGovernor | null = null;

export function getNetworkGovernor(): NetworkGovernor {
    sharedGovernor ??= new NetworkGovernor();
    return sharedGovernor;
}

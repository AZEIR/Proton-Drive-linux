import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SyncDatabase } from '../sync/db';
import { MAX_PARALLEL_FILE_TRANSFERS } from '../utils/httpAgent';

export interface CachedFileItem {
    nodeUid: string;
    relativePath: string;
    size: number;
    isPinned: boolean;
    lastAccessed: number;
}

export interface ActiveTransferInfo {
    nodeUid: string;
    filePath: string;
    localPath?: string;
    transferred: number;
    size: number;
    percent: number;
    type: 'download' | 'upload';
}

export class FodHydrator extends EventEmitter {
    private cacheDir: string;
    private pinnedNodeUids: Set<string> = new Set();
    private activeHydrations: Map<string, ActiveTransferInfo> = new Map();
    private inFlightHydrations: Map<string, Promise<string>> = new Map();
    private activeHydrationSlots = 0;
    private hydrationSlotWaiters: Array<() => void> = [];
    private isPaused = false;

    constructor(
        private db: SyncDatabase,
        private sdk: any,
        private logger: any,
    ) {
        super();
        const home = process.env.HOME || '/tmp';
        this.cacheDir = path.join(home, '.cache', 'proton-drive-sync', 'fod-cache');
        if (!existsSync(this.cacheDir)) {
            mkdirSync(this.cacheDir, { recursive: true });
        }
        this.loadPinnedState();
    }

    private loadPinnedState(): void {
        try {
            const raw = this.db.getConfig('fod_pinned_nodes', '[]');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                this.pinnedNodeUids = new Set(parsed);
            }
        } catch {
            this.pinnedNodeUids = new Set();
        }
    }

    private savePinnedState(): void {
        try {
            this.db.setConfig('fod_pinned_nodes', JSON.stringify(Array.from(this.pinnedNodeUids)));
        } catch (err) {
            this.logger.warn('Failed to save pinned nodes state:', err);
        }
    }

    getCacheDir(): string {
        return this.cacheDir;
    }

    setPaused(paused: boolean): void {
        this.isPaused = paused;
    }

    getCachePath(nodeUid: string): string {
        return path.join(this.cacheDir, nodeUid);
    }

    async rekeyCachedFile(oldNodeUid: string, newNodeUid: string): Promise<string> {
        const oldPath = this.getCachePath(oldNodeUid);
        const newPath = this.getCachePath(newNodeUid);
        if (oldPath !== newPath && existsSync(oldPath)) {
            await rename(oldPath, newPath);
        }
        if (this.pinnedNodeUids.delete(oldNodeUid)) {
            this.pinnedNodeUids.add(newNodeUid);
            this.savePinnedState();
        }
        return newPath;
    }

    isHydrated(nodeUid: string): boolean {
        const cachePath = this.getCachePath(nodeUid);
        return existsSync(cachePath);
    }

    isPinned(nodeUid: string): boolean {
        return this.pinnedNodeUids.has(nodeUid);
    }

    getActiveTransfers(): ActiveTransferInfo[] {
        return Array.from(this.activeHydrations.values());
    }

    async pinFile(nodeUid: string): Promise<boolean> {
        this.pinnedNodeUids.add(nodeUid);
        this.savePinnedState();
        if (!this.isHydrated(nodeUid)) {
            const mapping = this.db.getMappingByNodeUid(nodeUid);
            if (mapping) {
                try {
                    await this.hydrateNode(nodeUid, mapping.local_path);
                } catch (err) {
                    this.logger.error(`Failed to hydrate pinned file ${nodeUid}:`, err);
                    return false;
                }
            }
        }
        return true;
    }

    async evictFile(nodeUid: string): Promise<boolean> {
        this.pinnedNodeUids.delete(nodeUid);
        this.savePinnedState();
        const cachePath = this.getCachePath(nodeUid);
        if (existsSync(cachePath)) {
            try {
                await unlink(cachePath);
                return true;
            } catch (err) {
                this.logger.warn(`Failed to evict file ${nodeUid}:`, err);
                return false;
            }
        }
        return true;
    }

    async hydrateNode(nodeUid: string, relativePath: string): Promise<string> {
        const cachePath = this.getCachePath(nodeUid);
        if (existsSync(cachePath)) {
            return cachePath;
        }
        if (this.isPaused) {
            throw new Error('FUSE transfers are paused');
        }

        // Deduplicate in-flight hydration requests for the same nodeUid
        if (this.inFlightHydrations.has(nodeUid)) {
            return this.inFlightHydrations.get(nodeUid)!;
        }

        const hydrationPromise = this.performHydrationWithSlot(nodeUid, relativePath, cachePath);
        this.inFlightHydrations.set(nodeUid, hydrationPromise);

        try {
            const result = await hydrationPromise;
            return result;
        } finally {
            this.inFlightHydrations.delete(nodeUid);
        }
    }

    private async performHydrationWithSlot(nodeUid: string, relativePath: string, cachePath: string): Promise<string> {
        await this.acquireHydrationSlot();
        try {
            if (this.isPaused) throw new Error('FUSE transfers are paused');
            return await this.performHydration(nodeUid, relativePath, cachePath);
        } finally {
            this.activeHydrationSlots--;
            for (const wake of this.hydrationSlotWaiters.splice(0)) wake();
        }
    }

    private async acquireHydrationSlot(): Promise<void> {
        while (this.activeHydrationSlots >= this.getHydrationConcurrency()) {
            await new Promise<void>((resolve) => this.hydrationSlotWaiters.push(resolve));
        }
        this.activeHydrationSlots++;
    }

    private getHydrationConcurrency(): number {
        if (this.db.getConfig('sync_wifi_safe_mode', '0') === '1') return 1;
        const configured = Number(this.db.getConfig('sync_concurrency', '2'));
        return Number.isInteger(configured)
            ? Math.max(1, Math.min(MAX_PARALLEL_FILE_TRANSFERS, configured))
            : 2;
    }

    private async performHydration(nodeUid: string, relativePath: string, cachePath: string): Promise<string> {
        const tmpCachePath = `${cachePath}.tmp-${Date.now()}`;
        this.logger.info(`Hydrating on-demand file for FUSE: ${relativePath} (${nodeUid})...`);

        const mapping = this.db.getMappingByNodeUid(nodeUid);
        const totalSize = mapping?.size || 0;

        const activeItem: ActiveTransferInfo = {
            nodeUid,
            filePath: relativePath,
            localPath: relativePath,
            transferred: 0,
            size: totalSize,
            percent: 0,
            type: 'download',
        };

        this.activeHydrations.set(nodeUid, activeItem);
        this.emit('start', activeItem);
        this.db.log(relativePath, 'download', 'syncing', `Starting hydration download for ${relativePath}`);

        try {
            const node = await this.sdk.getNode(nodeUid);
            const size = node?.activeRevision?.ok ? (node.activeRevision.value.size || totalSize) : (node?.size || totalSize);
            activeItem.size = size;

            const fsWriteStream = createWriteStream(tmpCachePath, { highWaterMark: 1024 * 1024 });
            let transferred = 0;
            let lastProgressEmit = 0;

            const writableStream = new WritableStream({
                write: (chunk: any) => {
                    const buf = Buffer.isBuffer(chunk)
                        ? chunk
                        : (chunk instanceof Uint8Array
                            ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                            : (chunk instanceof ArrayBuffer ? Buffer.from(chunk) : Buffer.from(chunk)));

                    if (buf && buf.length) {
                        transferred += buf.length;
                        activeItem.transferred = transferred;
                        activeItem.percent = size > 0 ? Math.min(100, Math.round((transferred / size) * 100)) : 100;
                        const now = Date.now();
                        if (now - lastProgressEmit >= 200 || transferred >= size) {
                            this.emit('progress', activeItem);
                            lastProgressEmit = now;
                        }
                    }

                    return new Promise<void>((resolve, reject) => {
                        const ok = fsWriteStream.write(buf, (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                        if (!ok) {
                            fsWriteStream.once('drain', resolve);
                        }
                    });
                },
                close: () => {
                    return new Promise<void>((resolve) => {
                        fsWriteStream.end(() => resolve());
                    });
                },
                abort: () => {
                    fsWriteStream.destroy();
                },
            });

            const downloader = await this.sdk.getFileDownloader(node);
            const downloadController = downloader.downloadToStream(writableStream as any);
            await downloadController.completion();
            if (!writableStream.locked) {
                await writableStream.close().catch(() => {});
            }

            await rename(tmpCachePath, cachePath);
            await this.enforceCacheLimit(nodeUid);

            activeItem.transferred = size;
            activeItem.percent = 100;
            this.emit('complete', activeItem);
            this.logger.info(`Hydration complete: ${relativePath}`);
            this.db.log(relativePath, 'download', 'completed', `Hydration complete for ${relativePath}`);
            return cachePath;
        } catch (err: any) {
            await unlink(tmpCachePath).catch(() => {});
            this.logger.error(`Hydration failed for ${relativePath}:`, err);
            this.db.log(relativePath, 'download', 'failed', `Hydration failed for ${relativePath}: ${err?.message || err}`);
            this.emit('error', { nodeUid, error: err });
            throw err;
        } finally {
            this.activeHydrations.delete(nodeUid);
        }
    }

    getCachedFiles(): CachedFileItem[] {
        const result: CachedFileItem[] = [];
        if (!existsSync(this.cacheDir)) return result;

        try {
            const entries = readdirSync(this.cacheDir, { withFileTypes: true });
            for (const entry of entries) {
                if (
                    entry.isFile() &&
                    !entry.name.includes('.tmp-') &&
                    !entry.name.includes('.upload-')
                ) {
                    const nodeUid = entry.name;
                    const fullPath = path.join(this.cacheDir, nodeUid);
                    try {
                        const st = statSync(fullPath);
                        const mapping = this.db.getMappingByNodeUid(nodeUid);
                        result.push({
                            nodeUid,
                            relativePath: mapping?.local_path || nodeUid,
                            size: st.size,
                            isPinned: this.pinnedNodeUids.has(nodeUid),
                            lastAccessed: st.atimeMs || st.mtimeMs,
                        });
                    } catch {}
                }
            }
        } catch (err) {
            this.logger.warn('Failed to list cached files:', err);
        }

        return result;
    }

    getCacheStats(): { totalFiles: number; totalBytes: number } {
        const files = this.getCachedFiles();
        let totalBytes = 0;
        for (const f of files) {
            totalBytes += f.size;
        }
        return { totalFiles: files.length, totalBytes };
    }

    private async enforceCacheLimit(protectedNodeUid: string): Promise<void> {
        const configured = Number(this.db.getConfig('fod_cache_max_bytes', String(10 * 1024 * 1024 * 1024)));
        if (!Number.isFinite(configured) || configured <= 0) return;
        const files = this.getCachedFiles().sort((a, b) => a.lastAccessed - b.lastAccessed);
        let total = files.reduce((sum, file) => sum + file.size, 0);
        for (const file of files) {
            if (total <= configured) break;
            if (
                file.nodeUid === protectedNodeUid ||
                file.isPinned ||
                this.db.hasPendingFodUpload(file.relativePath)
            ) {
                continue;
            }
            try {
                await unlink(this.getCachePath(file.nodeUid));
                total -= file.size;
            } catch (error) {
                this.logger.warn(`Failed to evict cache entry ${file.nodeUid}:`, error);
            }
        }
    }
}

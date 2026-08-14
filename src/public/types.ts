import type { NetworkPolicy, NetworkSnapshot } from '../utils/networkGovernor';
import type { JournalOperation } from '../sync/journal';

export type SyncMode = 'full' | 'fuse';
export type SyncPhase =
    | 'auth_required'
    | 'starting'
    | 'scanning'
    | 'syncing'
    | 'synced'
    | 'paused'
    | 'degraded'
    | 'offline'
    | 'blocked'
    | 'error';

export interface SyncStatus {
    phase: SyncPhase;
    mode: SyncMode;
    reason: string | null;
    lastSuccessfulSyncAt: number | null;
    pendingOperations: number;
    pendingEvents: number;
    activeTransfers: number;
    network: NetworkSnapshot;
}

export interface FuseBackend {
    readonly mountPoint: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    health(): Promise<{ healthy: boolean; backend: string; reason?: string }>;
    abort(reason: string): Promise<void>;
    getCacheStats(): { totalFiles: number; totalBytes: number };
}

export type {
    JournalOperation,
    NetworkPolicy,
    NetworkSnapshot,
};

import { SyncDatabase } from '../db';

export class MassDeleteGuard {
    private massDeletionThreshold = 0.5; // 50% threshold
    private minimumFileCountForGuard = 20;

    constructor(
        private db: SyncDatabase,
        private logger: any,
    ) {}

    public shouldTriggerGuard(deletedCount: number, totalCount: number): boolean {
        if (totalCount < this.minimumFileCountForGuard) {
            return false;
        }
        const ratio = deletedCount / totalCount;
        return ratio >= this.massDeletionThreshold;
    }

    public logMassDeleteWarning(deletedCount: number, totalCount: number, source: 'local' | 'remote'): void {
        const msg = `Mass deletion safety guard triggered (${source}): ${deletedCount} of ${totalCount} files marked for deletion. Sync paused for safety.`;
        this.logger?.warn?.(msg);
        this.db.log('system', 'system', 'failed', msg);
    }
}

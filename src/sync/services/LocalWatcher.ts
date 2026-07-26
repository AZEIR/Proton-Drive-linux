import { EventEmitter } from 'node:events';
import chokidar, { FSWatcher } from 'chokidar';
import path from 'node:path';
import { IgnoreMatcher, PROTONIGNORE_FILENAME } from '../ignore';

export class LocalWatcher extends EventEmitter {
    private watcher: FSWatcher | null = null;
    private ignoreMatcher: IgnoreMatcher;
    private temporarilyIgnoredPaths = new Map<string, number>();

    constructor(
        private localSyncRoot: string,
        private logger: any,
    ) {
        super();
        this.ignoreMatcher = new IgnoreMatcher(localSyncRoot);
    }

    public getIgnoreMatcher(): IgnoreMatcher {
        return this.ignoreMatcher;
    }

    public ignorePathTemporarily(absolutePath: string, durationMs: number = 3000): void {
        const expiry = Date.now() + durationMs;
        this.temporarilyIgnoredPaths.set(absolutePath, expiry);
    }

    public isPathTemporarilyIgnored(absolutePath: string): boolean {
        const expiry = this.temporarilyIgnoredPaths.get(absolutePath);
        if (!expiry) return false;
        if (Date.now() > expiry) {
            this.temporarilyIgnoredPaths.delete(absolutePath);
            return false;
        }
        return true;
    }

    public startWatching(): void {
        if (this.watcher) return;

        this.watcher = chokidar.watch(this.localSyncRoot, {
            ignored: (targetPath: string) => {
                const basename = path.basename(targetPath);
                if (basename === PROTONIGNORE_FILENAME) return false;
                if (this.isPathTemporarilyIgnored(targetPath)) return true;
                return this.ignoreMatcher.isIgnored(targetPath);
            },
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100,
            },
        });

        this.watcher
            .on('add', (pathStr) => this.emit('fileAdded', pathStr))
            .on('change', (pathStr) => this.emit('fileChanged', pathStr))
            .on('unlink', (pathStr) => this.emit('fileUnlinked', pathStr))
            .on('unlinkDir', (pathStr) => this.emit('dirUnlinked', pathStr))
            .on('error', (error) => this.logger?.error?.('Chokidar local watcher error:', error));
    }

    public async stopWatching(): Promise<void> {
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }
    }
}

import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { mkdir, stat, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SyncDatabase } from '../sync/db';

export interface CachedFileItem {
    nodeUid: string;
    relativePath: string;
    size: number;
    isPinned: boolean;
    lastAccessed: number;
}

export class FodHydrator {
    private cacheDir: string;
    private pinnedNodeUids: Set<string> = new Set();

    constructor(
        private db: SyncDatabase,
        private sdk: any,
        private logger: any,
    ) {
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

    getCachePath(nodeUid: string): string {
        return path.join(this.cacheDir, nodeUid);
    }

    isHydrated(nodeUid: string): boolean {
        const cachePath = this.getCachePath(nodeUid);
        return existsSync(cachePath);
    }

    isPinned(nodeUid: string): boolean {
        return this.pinnedNodeUids.has(nodeUid);
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

        const tmpCachePath = `${cachePath}.tmp-${Date.now()}`;
        this.logger.info(`Hydrating on-demand file for FUSE: ${relativePath} (${nodeUid})...`);

        try {
            const node = await this.sdk.getNode(nodeUid);
            const bunFile = Bun.file(tmpCachePath);
            const writer = bunFile.writer();

            const writableStream = {
                getWriter: () => writer,
                close: async () => { await writer.end(); },
                abort: async () => {
                    try { await writer.end(); } catch {}
                    await unlink(tmpCachePath).catch(() => {});
                },
                locked: false,
            };

            const downloader = await this.sdk.getFileDownloader(node);
            const downloadController = downloader.downloadToStream(writableStream as any);
            await downloadController.completion();
            await writer.end();

            await Bun.write(cachePath, Bun.file(tmpCachePath));
            await unlink(tmpCachePath).catch(() => {});
            this.logger.info(`Hydration complete: ${relativePath}`);
            return cachePath;
        } catch (err) {
            await unlink(tmpCachePath).catch(() => {});
            this.logger.error(`Hydration failed for ${relativePath}:`, err);
            throw err;
        }
    }

    getCachedFiles(): CachedFileItem[] {
        const result: CachedFileItem[] = [];
        if (!existsSync(this.cacheDir)) return result;

        try {
            const entries = readdirSync(this.cacheDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && !entry.name.includes('.tmp-')) {
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
}

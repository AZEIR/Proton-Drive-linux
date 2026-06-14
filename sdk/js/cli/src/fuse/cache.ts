import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface CacheStats {
    totalFiles: number;
    totalBytes: number;
}

export class CacheManager {
    readonly cacheDir: string;

    constructor(cacheDir?: string) {
        this.cacheDir = cacheDir ?? path.join(
            process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'),
            'proton-drive-fod',
        );
        mkdirSync(this.cacheDir, { recursive: true });
    }

    /** Returns the local path where a file's content is/would be cached. */
    localPath(nodeUid: string): string {
        // Shard into 2-char subdirs to avoid huge flat dirs
        const shard = nodeUid.slice(0, 2);
        return path.join(this.cacheDir, shard, nodeUid);
    }

    /** Returns temp path used during download */
    tmpPath(nodeUid: string): string {
        return this.localPath(nodeUid) + '.tmp';
    }

    /** Returns true if the file content is cached locally. */
    isLocal(nodeUid: string): boolean {
        return existsSync(this.localPath(nodeUid));
    }

    /** Ensures the shard directory exists before writing. */
    ensureDir(nodeUid: string) {
        mkdirSync(path.dirname(this.localPath(nodeUid)), { recursive: true });
    }

    /** Remove cached file (evict to stub). */
    async evict(nodeUid: string): Promise<boolean> {
        const p = this.localPath(nodeUid);
        if (!existsSync(p)) return false;
        await unlink(p);
        return true;
    }

    /** Return size of a cached file, or 0 if not local. */
    async cachedSize(nodeUid: string): Promise<number> {
        try {
            const s = await stat(this.localPath(nodeUid));
            return s.size;
        } catch {
            return 0;
        }
    }

    /** Compute total cache disk usage. */
    getStats(): CacheStats {
        let totalFiles = 0;
        let totalBytes = 0;
        try {
            this._walkDir(this.cacheDir, (filePath) => {
                if (filePath.endsWith('.tmp')) return;
                totalFiles++;
                try { totalBytes += statSync(filePath).size; } catch {}
            });
        } catch {}
        return { totalFiles, totalBytes };
    }

    /**
     * LRU eviction: remove oldest cache files until we've freed at least
     * `bytesNeeded` bytes.  Returns number of files evicted.
     */
    evictLRU(bytesNeeded: number): number {
        type FileEntry = { path: string; mtime: number; size: number };
        const files: FileEntry[] = [];
        this._walkDir(this.cacheDir, (filePath) => {
            if (filePath.endsWith('.tmp')) return;
            try {
                const s = statSync(filePath);
                files.push({ path: filePath, mtime: s.mtimeMs, size: s.size });
            } catch {}
        });

        // Sort oldest first
        files.sort((a, b) => a.mtime - b.mtime);

        let freed = 0;
        let count = 0;
        for (const f of files) {
            if (freed >= bytesNeeded) break;
            try {
                unlinkSync(f.path);
                freed += f.size;
                count++;
            } catch {}
        }
        return count;
    }

    private _walkDir(dir: string, cb: (filePath: string) => void) {
        if (!existsSync(dir)) return;
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                this._walkDir(full, cb);
            } else if (ent.isFile()) {
                cb(full);
            }
        }
    }
}

import { Database } from './sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface SyncMapping {
    local_path: string;           // Relative path from local sync root (e.g. "folder/file.txt")
    node_uid: string;             // Remote Proton node UID
    is_dir: number;               // 1 if directory, 0 if file
    size: number;                 // Local file size in bytes
    mtime: number;                // Local file mtime in ms
    sha1: string;                 // Local file SHA-1 checksum (empty for directories)
    remote_revision_uid: string;  // Remote revision UID when last synced
    remote_mtime: number;         // Remote modification time in ms
}

export interface SyncLog {
    id: number;
    timestamp: number;
    file_path: string;
    direction: string;
    status: string;
    message: string;
}

export class SyncDatabase {
    private db: Database;
    private _logWriteCount: number = 0;

    /**
     * @param dbPath  Optional absolute path to the SQLite database file.
     *                Defaults to ~/.config/proton-drive-sync/sync_state.db
     */
    constructor(dbPath?: string) {
        let resolvedPath: string;
        if (dbPath) {
            resolvedPath = dbPath;
        } else {
            const configDir = path.join(homedir(), '.config', 'proton-drive-sync');
            mkdirSync(configDir, { recursive: true });
            resolvedPath = path.join(configDir, 'sync_state.db');
        }
        mkdirSync(path.dirname(resolvedPath), { recursive: true });
        this.db = new Database(resolvedPath);
        this.initTables();
    }

    private initTables() {
        // Config must exist before mapping migration so legacy rows can be
        // assigned to the mode that owned them.
        this.db.run(`
            CREATE TABLE IF NOT EXISTS sync_config (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);

        // Mappings are isolated by sync mode. A FUSE inode cache is not a
        // full-sync filesystem snapshot and must never drive full-sync deletes.
        this.db.run(`
            CREATE TABLE IF NOT EXISTS sync_mappings (
                sync_mode TEXT NOT NULL,
                local_path TEXT NOT NULL,
                node_uid TEXT NOT NULL,
                is_dir INTEGER,
                size INTEGER,
                mtime INTEGER,
                sha1 TEXT,
                remote_revision_uid TEXT,
                remote_mtime INTEGER,
                PRIMARY KEY (sync_mode, local_path)
            )
        `);
        const mappingColumns = this.db.prepare('PRAGMA table_info(sync_mappings)').all() as { name: string }[];
        if (!mappingColumns.some((column) => column.name === 'sync_mode')) {
            const legacyMode = this.getSyncMode();
            this.db.run('ALTER TABLE sync_mappings RENAME TO sync_mappings_legacy');
            this.db.run(`
                CREATE TABLE sync_mappings (
                    sync_mode TEXT NOT NULL,
                    local_path TEXT NOT NULL,
                    node_uid TEXT NOT NULL,
                    is_dir INTEGER,
                    size INTEGER,
                    mtime INTEGER,
                    sha1 TEXT,
                    remote_revision_uid TEXT,
                    remote_mtime INTEGER,
                    PRIMARY KEY (sync_mode, local_path)
                )
            `);
            this.db.prepare(`
                INSERT INTO sync_mappings
                    (sync_mode, local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime)
                SELECT ?, local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime
                FROM sync_mappings_legacy
            `).run(legacyMode);
            this.db.run('DROP TABLE sync_mappings_legacy');
        }
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_mappings_mode_uid ON sync_mappings(sync_mode, node_uid)`);

        // Create sync_logs
        this.db.run(`
            CREATE TABLE IF NOT EXISTS sync_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER,
                file_path TEXT,
                direction TEXT,
                status TEXT,
                message TEXT
            )
        `);

        // Persist pending local deletes across crashes/restarts
        this.db.run(`
            CREATE TABLE IF NOT EXISTS pending_deletes (
                sync_mode TEXT NOT NULL,
                local_path TEXT NOT NULL,
                node_uid TEXT NOT NULL,
                is_dir INTEGER NOT NULL,
                queued_at INTEGER NOT NULL,
                PRIMARY KEY (sync_mode, local_path)
            )
        `);
        const pendingColumns = this.db.prepare('PRAGMA table_info(pending_deletes)').all() as { name: string }[];
        if (!pendingColumns.some((column) => column.name === 'sync_mode')) {
            const legacyMode = this.getSyncMode();
            this.db.run('ALTER TABLE pending_deletes RENAME TO pending_deletes_legacy');
            this.db.run(`
                CREATE TABLE pending_deletes (
                    sync_mode TEXT NOT NULL,
                    local_path TEXT NOT NULL,
                    node_uid TEXT NOT NULL,
                    is_dir INTEGER NOT NULL,
                    queued_at INTEGER NOT NULL,
                    PRIMARY KEY (sync_mode, local_path)
                )
            `);
            this.db.prepare(`
                INSERT INTO pending_deletes
                    (sync_mode, local_path, node_uid, is_dir, queued_at)
                SELECT ?, local_path, node_uid, is_dir, queued_at
                FROM pending_deletes_legacy
            `).run(legacyMode);
            this.db.run('DROP TABLE pending_deletes_legacy');
        }

        // FUSE writes are acknowledged by the kernel before a cloud upload can
        // necessarily finish. Persist that writeback queue so a crash or network
        // outage cannot silently forget cache-only user data.
        this.db.run(`
            CREATE TABLE IF NOT EXISTS fod_pending_uploads (
                local_path TEXT PRIMARY KEY,
                node_uid TEXT NOT NULL,
                cache_path TEXT NOT NULL,
                queued_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT ''
            )
        `);
    }

    // Config Methods
    getConfig(key: string, defaultValue: string = ''): string {
        const row = this.db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key) as { value: string } | undefined;
        return row ? row.value : defaultValue;
    }

    setConfig(key: string, value: string): void {
        this.db.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)').run(key, value);
    }

    getAccountUid(): string {
        return this.getConfig("account_uid", "");
    }

    getAccountEmail(): string {
        return this.getConfig("account_email", "");
    }

    setAccountInfo(uid: string, email: string): void {
        this.setConfig("account_uid", uid);
        this.setConfig("account_email", email);
    }

    getSyncMode(): 'full' | 'fuse' {
        const mode = this.getConfig("sync_mode", "full");
        return mode === "fuse" ? "fuse" : "full";
    }

    setSyncMode(mode: 'full' | 'fuse'): void {
        this.setConfig("sync_mode", mode);
    }

    getFuseMountPoint(): string {
        const home = process.env.HOME || "/tmp";
        return this.getConfig("fuse_mount_point", `${home}/P-Drive-FUSE`);
    }

    setFuseMountPoint(mountPath: string): void {
        this.setConfig("fuse_mount_point", mountPath);
    }

    // Mapping Methods
    getMapping(localPath: string): SyncMapping | undefined {
        return this.db.prepare(
            'SELECT local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime FROM sync_mappings WHERE sync_mode = ? AND local_path = ?',
        ).get(this.getSyncMode(), localPath) as SyncMapping | undefined;
    }

    getMappingByNodeUid(nodeUid: string): SyncMapping | undefined {
        return this.db.prepare(
            'SELECT local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime FROM sync_mappings WHERE sync_mode = ? AND node_uid = ?',
        ).get(this.getSyncMode(), nodeUid) as SyncMapping | undefined;
    }

    setMapping(mapping: SyncMapping): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO sync_mappings (
                sync_mode, local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime
            ) VALUES ($sync_mode, $local_path, $node_uid, $is_dir, $size, $mtime, $sha1, $remote_revision_uid, $remote_mtime)
        `).run({
            $sync_mode: this.getSyncMode(),
            $local_path: mapping.local_path,
            $node_uid: mapping.node_uid,
            $is_dir: mapping.is_dir,
            $size: mapping.size,
            $mtime: mapping.mtime,
            $sha1: mapping.sha1,
            $remote_revision_uid: mapping.remote_revision_uid,
            $remote_mtime: mapping.remote_mtime,
        });
    }

    deleteMapping(localPath: string): void {
        this.db.prepare('DELETE FROM sync_mappings WHERE sync_mode = ? AND local_path = ?').run(this.getSyncMode(), localPath);
    }

    deleteMappingByNodeUid(nodeUid: string): void {
        this.db.prepare('DELETE FROM sync_mappings WHERE sync_mode = ? AND node_uid = ?').run(this.getSyncMode(), nodeUid);
    }

    getAllMappings(): SyncMapping[] {
        return this.db.prepare(
            'SELECT local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime FROM sync_mappings WHERE sync_mode = ?',
        ).all(this.getSyncMode()) as SyncMapping[];
    }

    getMappingCount(): number {
        return (this.db.prepare('SELECT COUNT(*) as c FROM sync_mappings WHERE sync_mode = ?').get(this.getSyncMode()) as { c: number }).c;
    }

    getMappingsByPrefix(pathPrefix: string): SyncMapping[] {
        return this.db.prepare(
            'SELECT local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime FROM sync_mappings WHERE sync_mode = ? AND local_path LIKE ? ESCAPE \'\\\'',
        ).all(this.getSyncMode(), pathPrefix.replace(/[%_\\]/g, '\\$&') + '/%') as SyncMapping[];
    }

    getDirectChildren(parentPath: string): SyncMapping[] {
        if (!parentPath) {
            return this.db.prepare(`
                SELECT local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime
                FROM sync_mappings
                WHERE sync_mode = ? AND INSTR(local_path, '/') = 0
                ORDER BY local_path
            `).all(this.getSyncMode()) as SyncMapping[];
        }
        const escaped = parentPath.replace(/[%_\\]/g, '\\$&');
        return this.db.prepare(`
            SELECT local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime
            FROM sync_mappings
            WHERE sync_mode = ?
              AND local_path LIKE ? ESCAPE '\\'
              AND INSTR(SUBSTR(local_path, ?), '/') = 0
            ORDER BY local_path
        `).all(
            this.getSyncMode(),
            `${escaped}/%`,
            parentPath.length + 2,
        ) as SyncMapping[];
    }

    hasMappingsByPrefix(pathPrefix: string): boolean {
        return Boolean(
            this.db.prepare(`
                SELECT 1 AS found
                FROM sync_mappings
                WHERE sync_mode = ? AND local_path LIKE ? ESCAPE '\\'
                LIMIT 1
            `).get(
                this.getSyncMode(),
                pathPrefix.replace(/[%_\\]/g, '\\$&') + '/%',
            ),
        );
    }

    /**
     * Bulk-rename all mappings under oldPrefix to newPrefix in a single SQL UPDATE.
     * Returns the renamed rows so callers can do any in-memory post-processing.
     * ~100× faster than N individual deleteMapping + setMapping calls.
     */
    renameMappingsByPrefix(oldPrefix: string, newPrefix: string): SyncMapping[] {
        const escaped = oldPrefix.replace(/[%_\\]/g, '\\$&');
        // Fetch children before rename so callers get the old paths
        const children = this.db.prepare(
            "SELECT local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime FROM sync_mappings WHERE sync_mode = ? AND local_path LIKE ? ESCAPE '\\'",
        ).all(this.getSyncMode(), escaped + '/%') as SyncMapping[];
        if (children.length === 0) return [];
        // Single UPDATE: replace the prefix in-place using SUBSTR
        this.db.prepare(
            "UPDATE sync_mappings SET local_path = ? || SUBSTR(local_path, ?) WHERE sync_mode = ? AND local_path LIKE ? ESCAPE '\\'",
        ).run(newPrefix, oldPrefix.length + 1, this.getSyncMode(), escaped + '/%');
        return children;
    }

    deleteMappingsByPrefix(pathPrefix: string): void {
        this.db.prepare(
            'DELETE FROM sync_mappings WHERE sync_mode = ? AND local_path LIKE ? ESCAPE \'\\\'',
        ).run(this.getSyncMode(), pathPrefix.replace(/[%_\\]/g, '\\$&') + '/%');
    }

    clearMappings(): void {
        this.db.prepare('DELETE FROM sync_mappings WHERE sync_mode = ?').run(this.getSyncMode());
        this.setConfig("full_sync_completed", "0");
    }

    // Pending delete persistence — survives crashes/restarts
    setPendingDelete(localPath: string, nodeUid: string, isDir: boolean): void {
        this.db.prepare(
            'INSERT OR REPLACE INTO pending_deletes (sync_mode, local_path, node_uid, is_dir, queued_at) VALUES (?, ?, ?, ?, ?)',
        ).run(this.getSyncMode(), localPath, nodeUid, isDir ? 1 : 0, Date.now());
    }

    deletePendingDelete(localPath: string): void {
        this.db.prepare('DELETE FROM pending_deletes WHERE sync_mode = ? AND local_path = ?').run(this.getSyncMode(), localPath);
    }

    deletePendingDeletesByPrefix(pathPrefix: string): void {
        this.db.prepare(
            "DELETE FROM pending_deletes WHERE sync_mode = ? AND local_path LIKE ? ESCAPE '\\'",
        ).run(this.getSyncMode(), pathPrefix.replace(/[%_\\]/g, '\\$&') + '/%');
    }

    getPendingDeletes(): { local_path: string; node_uid: string; is_dir: number; queued_at: number }[] {
        return this.db.prepare(
            'SELECT local_path, node_uid, is_dir, queued_at FROM pending_deletes WHERE sync_mode = ? ORDER BY queued_at ASC',
        ).all(this.getSyncMode()) as {
            local_path: string;
            node_uid: string;
            is_dir: number;
            queued_at: number;
        }[];
    }

    clearPendingDeletes(): void {
        this.db.prepare('DELETE FROM pending_deletes WHERE sync_mode = ?').run(this.getSyncMode());
    }

    setPendingFodUpload(localPath: string, nodeUid: string, cachePath: string): void {
        this.db.prepare(`
            INSERT INTO fod_pending_uploads
                (local_path, node_uid, cache_path, queued_at, attempts, last_error)
            VALUES (?, ?, ?, ?, 0, '')
            ON CONFLICT(local_path) DO UPDATE SET
                node_uid = excluded.node_uid,
                cache_path = excluded.cache_path,
                queued_at = excluded.queued_at
        `).run(localPath, nodeUid, cachePath, Date.now());
    }

    markPendingFodUploadFailed(localPath: string, error: string): void {
        this.db.prepare(`
            UPDATE fod_pending_uploads
            SET attempts = attempts + 1, last_error = ?
            WHERE local_path = ?
        `).run(error, localPath);
    }

    deletePendingFodUpload(localPath: string): void {
        this.db.prepare('DELETE FROM fod_pending_uploads WHERE local_path = ?').run(localPath);
    }

    getPendingFodUploads(): {
        local_path: string;
        node_uid: string;
        cache_path: string;
        queued_at: number;
        attempts: number;
        last_error: string;
    }[] {
        return this.db.prepare(
            'SELECT * FROM fod_pending_uploads ORDER BY queued_at ASC',
        ).all() as {
            local_path: string;
            node_uid: string;
            cache_path: string;
            queued_at: number;
            attempts: number;
            last_error: string;
        }[];
    }

    hasPendingFodUpload(localPath: string): boolean {
        return Boolean(
            this.db.prepare('SELECT 1 AS found FROM fod_pending_uploads WHERE local_path = ?').get(localPath),
        );
    }

    getPendingFodUploadCount(): number {
        return (
            this.db.prepare('SELECT COUNT(*) AS count FROM fod_pending_uploads').get() as { count: number }
        ).count;
    }

    /**
     * Finds upload paths whose most recent upload attempt failed. This supports
     * upgrading from releases that logged failed FUSE writeback but did not
     * persist a durable retry queue.
     */
    getUnresolvedFailedUploadPaths(): string[] {
        const rows = this.db.prepare(`
            SELECT log.file_path
            FROM sync_logs AS log
            INNER JOIN (
                SELECT file_path, MAX(id) AS latest_id
                FROM sync_logs
                WHERE direction = 'upload'
                GROUP BY file_path
            ) AS latest ON latest.latest_id = log.id
            WHERE log.status = 'failed'
            ORDER BY log.id ASC
        `).all() as { file_path: string }[];
        return rows.map((row) => row.file_path);
    }

    // Logging Methods
    log(
        filePath: string,
        direction: 'upload' | 'download' | 'delete_local' | 'delete_remote' | 'rename_local' | 'rename_remote' | 'system',
        status: 'syncing' | 'completed' | 'failed',
        message: string = ''
    ): void {
        this.db.prepare(`
            INSERT INTO sync_logs (timestamp, file_path, direction, status, message)
            VALUES (?, ?, ?, ?, ?)
        `).run(Date.now(), filePath, direction, status, message);

        // Prune lazily every 100 writes using an index-friendly range delete (O(1) via PK B-tree),
        // then checkpoint the WAL to prevent unbounded WAL file growth.
        this._logWriteCount++;
        if (this._logWriteCount % 100 === 0) {
            this.db.run(`
                DELETE FROM sync_logs
                WHERE id NOT IN (SELECT id FROM sync_logs ORDER BY id DESC LIMIT 1000)
            `);
            this.checkpoint();
        }
    }

    getRecentLogs(limit: number = 50): SyncLog[] {
        return this.db.prepare('SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?').all(limit) as SyncLog[];
    }

    pruneOldLogs(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): void {
        this.db.prepare('DELETE FROM sync_logs WHERE timestamp < ?').run(Date.now() - maxAgeMs);
    }

    /**
     * Compact the WAL file back into the main database.
     * Safe to call at any time — PASSIVE mode never blocks readers or writers.
     */
    checkpoint(): void {
        try {
            this.db.run('PRAGMA wal_checkpoint(PASSIVE)');
        } catch (err) {
            // Ignore — e.g. read-only database
        }
    }

    close() {
        this.db.close();
    }
}

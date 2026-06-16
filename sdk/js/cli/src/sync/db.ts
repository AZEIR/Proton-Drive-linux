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
        // Create sync_mappings
        this.db.run(`
            CREATE TABLE IF NOT EXISTS sync_mappings (
                local_path TEXT PRIMARY KEY,
                node_uid TEXT NOT NULL,
                is_dir INTEGER,
                size INTEGER,
                mtime INTEGER,
                sha1 TEXT,
                remote_revision_uid TEXT,
                remote_mtime INTEGER
            )
        `);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_mappings_uid ON sync_mappings(node_uid)`);

        // Create sync_config
        this.db.run(`
            CREATE TABLE IF NOT EXISTS sync_config (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);

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
    }

    // Config Methods
    getConfig(key: string, defaultValue: string = ''): string {
        const row = this.db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key) as { value: string } | undefined;
        return row ? row.value : defaultValue;
    }

    setConfig(key: string, value: string): void {
        this.db.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)').run(key, value);
    }

    // Mapping Methods
    getMapping(localPath: string): SyncMapping | undefined {
        return this.db.prepare('SELECT * FROM sync_mappings WHERE local_path = ?').get(localPath) as SyncMapping | undefined;
    }

    getMappingByNodeUid(nodeUid: string): SyncMapping | undefined {
        return this.db.prepare('SELECT * FROM sync_mappings WHERE node_uid = ?').get(nodeUid) as SyncMapping | undefined;
    }

    setMapping(mapping: SyncMapping): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO sync_mappings (
                local_path, node_uid, is_dir, size, mtime, sha1, remote_revision_uid, remote_mtime
            ) VALUES ($local_path, $node_uid, $is_dir, $size, $mtime, $sha1, $remote_revision_uid, $remote_mtime)
        `).run({
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
        this.db.prepare('DELETE FROM sync_mappings WHERE local_path = ?').run(localPath);
    }

    deleteMappingByNodeUid(nodeUid: string): void {
        this.db.prepare('DELETE FROM sync_mappings WHERE node_uid = ?').run(nodeUid);
    }

    getAllMappings(): SyncMapping[] {
        return this.db.prepare('SELECT * FROM sync_mappings').all() as SyncMapping[];
    }

    clearMappings(): void {
        this.db.run('DELETE FROM sync_mappings');
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
                WHERE id < (SELECT MAX(id) FROM sync_logs) - 1000
            `);
            this.checkpoint();
        }
    }

    getRecentLogs(limit: number = 50): SyncLog[] {
        return this.db.prepare('SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?').all(limit) as SyncLog[];
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

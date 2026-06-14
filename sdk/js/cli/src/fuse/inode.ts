import { Database } from '../sync/sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface InodeEntry {
    ino: number;
    node_uid: string;
    parent_ino: number;
    name: string;           // basename
    local_path: string;     // full relative path from mount root
    is_dir: number;         // 1 = directory, 0 = file
    size: number;
    remote_mtime: number;   // ms since epoch
    is_local: number;       // 1 = cached locally, 0 = stub only
    mode: number;           // unix permission bits
}

const ROOT_INO = 1;

export class InodeTable {
    private db: Database;
    private nextIno: number;

    constructor(dbPath: string) {
        mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.initSchema();
        this.nextIno = this.loadMaxIno() + 1;
    }

    private initSchema() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS inodes (
                ino          INTEGER PRIMARY KEY,
                node_uid     TEXT    NOT NULL DEFAULT '',
                parent_ino   INTEGER NOT NULL DEFAULT 0,
                name         TEXT    NOT NULL DEFAULT '',
                local_path   TEXT    NOT NULL DEFAULT '',
                is_dir       INTEGER NOT NULL DEFAULT 0,
                size         INTEGER NOT NULL DEFAULT 0,
                remote_mtime INTEGER NOT NULL DEFAULT 0,
                is_local     INTEGER NOT NULL DEFAULT 0,
                mode         INTEGER NOT NULL DEFAULT 33188
            )
        `);
        this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_uid  ON inodes(node_uid) WHERE node_uid != ''`);
        this.db.run(`CREATE        INDEX IF NOT EXISTS idx_par  ON inodes(parent_ino)`);
        this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_path ON inodes(local_path)`);

        // Ensure the root inode exists
        const root = this.db.prepare('SELECT ino FROM inodes WHERE ino = ?').get(ROOT_INO);
        if (!root) {
            this.db.prepare(`
                INSERT INTO inodes (ino, node_uid, parent_ino, name, local_path, is_dir, size, remote_mtime, is_local, mode)
                VALUES (?, '', 0, '', '', 1, 0, ?, 1, ?)
            `).run(ROOT_INO, Date.now(), 16877); // 0o40755
        }
    }

    private loadMaxIno(): number {
        const row = this.db.prepare('SELECT MAX(ino) as m FROM inodes').get() as { m: number | null };
        return row?.m ?? ROOT_INO;
    }

    allocIno(): number {
        return this.nextIno++;
    }

    get rootIno(): number {
        return ROOT_INO;
    }

    // ─── Lookups ────────────────────────────────────────────────────────

    getByIno(ino: number): InodeEntry | undefined {
        return this.db.prepare('SELECT * FROM inodes WHERE ino = ?').get(ino) as InodeEntry | undefined;
    }

    getByUid(nodeUid: string): InodeEntry | undefined {
        return this.db.prepare('SELECT * FROM inodes WHERE node_uid = ?').get(nodeUid) as InodeEntry | undefined;
    }

    getByPath(localPath: string): InodeEntry | undefined {
        return this.db.prepare('SELECT * FROM inodes WHERE local_path = ?').get(localPath) as InodeEntry | undefined;
    }

    getChildren(parentIno: number): InodeEntry[] {
        return this.db.prepare('SELECT * FROM inodes WHERE parent_ino = ? AND ino != ?')
            .all(parentIno, ROOT_INO) as InodeEntry[];
    }

    // ─── Mutations ───────────────────────────────────────────────────────

    upsert(entry: Omit<InodeEntry, 'ino'> & { ino?: number }): number {
        const ino = entry.ino ?? this.allocIno();
        this.db.prepare(`
            INSERT INTO inodes (ino, node_uid, parent_ino, name, local_path, is_dir, size, remote_mtime, is_local, mode)
            VALUES ($ino, $node_uid, $parent_ino, $name, $local_path, $is_dir, $size, $remote_mtime, $is_local, $mode)
            ON CONFLICT(ino) DO UPDATE SET
                node_uid     = excluded.node_uid,
                parent_ino   = excluded.parent_ino,
                name         = excluded.name,
                local_path   = excluded.local_path,
                is_dir       = excluded.is_dir,
                size         = excluded.size,
                remote_mtime = excluded.remote_mtime,
                is_local     = excluded.is_local,
                mode         = excluded.mode
        `).run({
            $ino: ino,
            $node_uid: entry.node_uid,
            $parent_ino: entry.parent_ino,
            $name: entry.name,
            $local_path: entry.local_path,
            $is_dir: entry.is_dir,
            $size: entry.size,
            $remote_mtime: entry.remote_mtime,
            $is_local: entry.is_local,
            $mode: entry.mode,
        });
        return ino;
    }

    setLocal(ino: number, size: number, mtime: number) {
        this.db.prepare('UPDATE inodes SET is_local = 1, size = ?, remote_mtime = ? WHERE ino = ?')
            .run(size, mtime, ino);
    }

    setStub(ino: number) {
        this.db.prepare('UPDATE inodes SET is_local = 0 WHERE ino = ?').run(ino);
    }

    updateSize(ino: number, size: number) {
        this.db.prepare('UPDATE inodes SET size = ? WHERE ino = ?').run(size, ino);
    }

    updateMtime(ino: number, mtime: number) {
        this.db.prepare('UPDATE inodes SET remote_mtime = ? WHERE ino = ?').run(mtime, ino);
    }

    delete(ino: number) {
        this.db.prepare('DELETE FROM inodes WHERE ino = ?').run(ino);
    }

    deleteByUid(nodeUid: string) {
        this.db.prepare('DELETE FROM inodes WHERE node_uid = ?').run(nodeUid);
    }

    /** Returns all cached (is_local=1) file inodes */
    getCachedFiles(): InodeEntry[] {
        return this.db.prepare('SELECT * FROM inodes WHERE is_local = 1 AND is_dir = 0').all() as InodeEntry[];
    }

    /** Returns all inode entries (for diagnostics) */
    getAll(): InodeEntry[] {
        return this.db.prepare('SELECT * FROM inodes ORDER BY local_path').all() as InodeEntry[];
    }

    close() {
        this.db.close();
    }
}

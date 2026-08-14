import { randomUUID } from 'node:crypto';
import { Database } from './sqlite';

export type JournalOperationKind =
    | 'create_file'
    | 'update_file'
    | 'mkdir'
    | 'rename'
    | 'delete';

export type JournalOperationState =
    | 'queued'
    | 'running'
    | 'retry_wait'
    | 'conflict'
    | 'completed';

export interface JournalOperation {
    op_id: string;
    sync_mode: 'full' | 'fuse';
    stable_inode_id: string;
    kind: JournalOperationKind;
    local_path: string;
    node_uid: string;
    base_revision_uid: string;
    cache_path: string;
    payload_json: string;
    depends_on: string;
    dedupe_key: string;
    state: JournalOperationState;
    attempt_count: number;
    next_attempt_at: number;
    last_error: string;
    created_at: number;
    updated_at: number;
}

export interface RemoteEventInboxItem {
    scope_id: string;
    event_id: string;
    node_uid: string;
    event_type: string;
    payload_json: string;
    state: 'queued' | 'applying';
    attempt_count: number;
    next_attempt_at: number;
    last_error: string;
    created_at: number;
}

export interface EnqueueOperationInput {
    syncMode: 'full' | 'fuse';
    stableInodeId: string;
    kind: JournalOperationKind;
    localPath: string;
    nodeUid?: string;
    baseRevisionUid?: string;
    cachePath?: string;
    payload?: unknown;
    dependsOn?: string;
    dedupeKey?: string;
}

/**
 * Power-loss durable intent and event storage. This database is intentionally
 * separate from rebuildable sync indexes so only acknowledgement-critical
 * transactions pay SQLite's synchronous=FULL cost.
 */
export class DurableJournal {
    private readonly db: Database;

    constructor(filename: string) {
        this.db = new Database(filename, { synchronous: 'FULL' });
        this.db.run(`
            CREATE TABLE IF NOT EXISTS journal_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);
        this.db.run(`
            CREATE TABLE IF NOT EXISTS operations (
                op_id TEXT PRIMARY KEY,
                sync_mode TEXT NOT NULL,
                stable_inode_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                local_path TEXT NOT NULL,
                node_uid TEXT NOT NULL DEFAULT '',
                base_revision_uid TEXT NOT NULL DEFAULT '',
                cache_path TEXT NOT NULL DEFAULT '',
                payload_json TEXT NOT NULL DEFAULT '{}',
                depends_on TEXT NOT NULL DEFAULT '',
                dedupe_key TEXT NOT NULL DEFAULT '',
                state TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        `);
        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_operations_ready
                ON operations(state, next_attempt_at, created_at)
        `);
        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_operations_dedupe
                ON operations(dedupe_key, state)
        `);
        this.db.run(`
            CREATE TABLE IF NOT EXISTS remote_event_inbox (
                scope_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                node_uid TEXT NOT NULL DEFAULT '',
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'queued',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                PRIMARY KEY (scope_id, event_id)
            )
        `);
        this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_event_inbox_ready
                ON remote_event_inbox(scope_id, state, next_attempt_at, created_at)
        `);
        this.db.prepare(
            `INSERT OR REPLACE INTO journal_meta (key, value) VALUES ('schema_version', '1')`,
        ).run();
    }

    enqueueOperation(input: EnqueueOperationInput): string {
        const now = Date.now();
        const dedupeKey = input.dedupeKey ?? '';
        return this.db.transaction(() => {
            if (dedupeKey) {
                const existing = this.db.prepare(`
                    SELECT op_id FROM operations
                    WHERE dedupe_key = ? AND state IN ('queued', 'retry_wait')
                    ORDER BY created_at DESC LIMIT 1
                `).get(dedupeKey) as { op_id: string } | undefined;
                if (existing) {
                    this.db.prepare(`
                        UPDATE operations SET
                            stable_inode_id = ?, kind = ?, local_path = ?,
                            node_uid = ?, base_revision_uid = ?, cache_path = ?,
                            payload_json = ?, depends_on = ?, state = 'queued',
                            next_attempt_at = 0, last_error = '', updated_at = ?
                        WHERE op_id = ?
                    `).run(
                        input.stableInodeId,
                        input.kind,
                        input.localPath,
                        input.nodeUid ?? '',
                        input.baseRevisionUid ?? '',
                        input.cachePath ?? '',
                        JSON.stringify(input.payload ?? {}),
                        input.dependsOn ?? '',
                        now,
                        existing.op_id,
                    );
                    return existing.op_id;
                }
            }

            const opId = randomUUID();
            this.db.prepare(`
                INSERT INTO operations (
                    op_id, sync_mode, stable_inode_id, kind, local_path,
                    node_uid, base_revision_uid, cache_path, payload_json,
                    depends_on, dedupe_key, state, attempt_count,
                    next_attempt_at, last_error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, '', ?, ?)
            `).run(
                opId,
                input.syncMode,
                input.stableInodeId,
                input.kind,
                input.localPath,
                input.nodeUid ?? '',
                input.baseRevisionUid ?? '',
                input.cachePath ?? '',
                JSON.stringify(input.payload ?? {}),
                input.dependsOn ?? '',
                dedupeKey,
                now,
                now,
            );
            return opId;
        });
    }

    getReadyOperations(limit = 100): JournalOperation[] {
        return this.db.prepare(`
            SELECT * FROM operations AS operation
            WHERE state IN ('queued', 'retry_wait')
              AND next_attempt_at <= ?
              AND (
                depends_on = '' OR EXISTS (
                    SELECT 1 FROM operations AS dependency
                    WHERE dependency.op_id = operation.depends_on
                      AND dependency.state = 'completed'
                )
              )
            ORDER BY created_at ASC
            LIMIT ?
        `).all(Date.now(), limit) as JournalOperation[];
    }

    hasPendingDeleteForNode(nodeUid: string): boolean {
        return Boolean(this.db.prepare(`
            SELECT 1 AS found FROM operations
            WHERE kind = 'delete' AND node_uid = ?
              AND state NOT IN ('completed', 'conflict')
            LIMIT 1
        `).get(nodeUid));
    }

    markOperationRunning(opId: string): void {
        this.db.prepare(
            `UPDATE operations SET state = 'running', updated_at = ? WHERE op_id = ?`,
        ).run(Date.now(), opId);
    }

    markOperationCompleted(opId: string): void {
        this.db.prepare(`
            UPDATE operations
            SET state = 'completed', last_error = '', updated_at = ?
            WHERE op_id = ?
        `).run(Date.now(), opId);
    }

    markOperationRetry(opId: string, error: string, delayMs: number): void {
        this.db.prepare(`
            UPDATE operations
            SET state = 'retry_wait', attempt_count = attempt_count + 1,
                next_attempt_at = ?, last_error = ?, updated_at = ?
            WHERE op_id = ?
        `).run(Date.now() + Math.max(0, delayMs), error, Date.now(), opId);
    }

    markOperationConflict(opId: string, error: string): void {
        this.db.prepare(`
            UPDATE operations
            SET state = 'conflict', last_error = ?, updated_at = ?
            WHERE op_id = ?
        `).run(error, Date.now(), opId);
    }

    markDedupeKeyCompleted(dedupeKey: string): void {
        this.db.prepare(`
            UPDATE operations
            SET state = 'completed', last_error = '', updated_at = ?
            WHERE dedupe_key = ? AND state NOT IN ('completed', 'conflict')
        `).run(Date.now(), dedupeKey);
    }

    markDedupeKeyRetry(dedupeKey: string, error: string, delayMs: number): void {
        this.db.prepare(`
            UPDATE operations
            SET state = 'retry_wait', attempt_count = attempt_count + 1,
                next_attempt_at = ?, last_error = ?, updated_at = ?
            WHERE dedupe_key = ? AND state NOT IN ('completed', 'conflict')
        `).run(Date.now() + Math.max(0, delayMs), error, Date.now(), dedupeKey);
    }

    getPendingOperationCount(): number {
        return (this.db.prepare(`
            SELECT COUNT(*) AS count FROM operations
            WHERE state NOT IN ('completed')
        `).get() as { count: number }).count;
    }

    getPendingOperations(limit = 100): JournalOperation[] {
        return this.db.prepare(`
            SELECT * FROM operations
            WHERE state NOT IN ('completed')
            ORDER BY created_at ASC
            LIMIT ?
        `).all(Math.max(1, Math.min(1000, limit))) as JournalOperation[];
    }

    enqueueRemoteEvent(
        scopeId: string,
        eventId: string,
        nodeUid: string,
        eventType: string,
        payload: unknown,
    ): void {
        this.db.prepare(`
            INSERT INTO remote_event_inbox (
                scope_id, event_id, node_uid, event_type, payload_json,
                state, attempt_count, next_attempt_at, last_error, created_at
            ) VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, '', ?)
            ON CONFLICT(scope_id, event_id) DO NOTHING
        `).run(scopeId, eventId, nodeUid, eventType, JSON.stringify(payload), Date.now());
    }

    getReadyRemoteEvents(scopeId: string, limit = 100): RemoteEventInboxItem[] {
        return this.db.prepare(`
            SELECT * FROM remote_event_inbox
            WHERE scope_id = ? AND state = 'queued' AND next_attempt_at <= ?
            ORDER BY created_at ASC, event_id ASC
            LIMIT ?
        `).all(scopeId, Date.now(), limit) as RemoteEventInboxItem[];
    }

    markRemoteEventApplying(scopeId: string, eventId: string): void {
        this.db.prepare(`
            UPDATE remote_event_inbox SET state = 'applying'
            WHERE scope_id = ? AND event_id = ?
        `).run(scopeId, eventId);
    }

    markRemoteEventApplied(scopeId: string, eventId: string): void {
        this.db.prepare(
            `DELETE FROM remote_event_inbox WHERE scope_id = ? AND event_id = ?`,
        ).run(scopeId, eventId);
    }

    markRemoteEventRetry(scopeId: string, eventId: string, error: string, delayMs: number): void {
        this.db.prepare(`
            UPDATE remote_event_inbox
            SET state = 'queued', attempt_count = attempt_count + 1,
                next_attempt_at = ?, last_error = ?
            WHERE scope_id = ? AND event_id = ?
        `).run(Date.now() + Math.max(0, delayMs), error, scopeId, eventId);
    }

    getPendingRemoteEventCount(): number {
        return (this.db.prepare(
            `SELECT COUNT(*) AS count FROM remote_event_inbox`,
        ).get() as { count: number }).count;
    }

    resetInterruptedWork(): void {
        this.db.transaction(() => {
            this.db.run(`UPDATE operations SET state = 'queued' WHERE state = 'running'`);
            this.db.run(`UPDATE remote_event_inbox SET state = 'queued' WHERE state = 'applying'`);
        });
    }

    close(): void {
        this.db.close();
    }
}

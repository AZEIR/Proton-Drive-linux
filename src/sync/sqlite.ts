import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const isBun = Boolean(process.versions && (process.versions as any).bun);
const runtimeRequire = createRequire(import.meta.url);

export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    synchronous?: 'NORMAL' | 'FULL';
}

export class Database {
    private inner: any;

    constructor(filename: string, options?: DatabaseOptions) {
        mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        try {
            chmodSync(path.dirname(filename), 0o700);
        } catch {}
        if (isBun) {
            const BunDatabase = runtimeRequire('bun:sqlite').Database;
            const bunOptions = options?.readonly
                ? { readonly: true, create: options.create !== false }
                : undefined;
            this.inner = new BunDatabase(filename, bunOptions);
        } else {
            const BetterSqlite3 = runtimeRequire('better-sqlite3');
            const nodeOptions: any = {};
            if (options) {
                if (options.readonly) nodeOptions.readonly = true;
                if (options.create === false) nodeOptions.fileMustExist = true;
            }
            this.inner = new BetterSqlite3(filename, nodeOptions);
        }
        try {
            chmodSync(filename, 0o600);
        } catch {}
        try {
            this.run('PRAGMA journal_mode = WAL');
            this.run('PRAGMA busy_timeout = 5000');
            // NORMAL is appropriate for rebuildable indexes. The durable
            // operation journal explicitly opts into FULL so an acknowledged
            // FUSE mutation survives power loss, not only process crashes.
            this.run(`PRAGMA synchronous = ${options?.synchronous ?? 'NORMAL'}`);
            // 8 MB page cache (negative value = KiB units), reduces repeated block reads
            this.run('PRAGMA cache_size = -8000');
        } catch (err) {
            // Ignore errors (e.g. if database is read-only)
        }
    }

    run(sql: string, ...params: any[]) {
        if (isBun) {
            this.inner.run(sql, ...params);
            return;
        }
        if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null) {
            this.inner.prepare(sql).run(normalizeParams(params[0]));
        } else if (params.length > 0) {
            this.inner.prepare(sql).run(...params);
        } else {
            this.inner.exec(sql);
        }
    }

    prepare(sql: string) {
        if (isBun) return this.inner.prepare(sql);
        const stmt = this.inner.prepare(sql);
        return {
            get(...params: any[]) {
                const arg = params[0];
                if (params.length === 1 && typeof arg === 'object' && arg !== null) {
                    return stmt.get(normalizeParams(arg));
                }
                return stmt.get(...params);
            },
            all(...params: any[]) {
                const arg = params[0];
                if (params.length === 1 && typeof arg === 'object' && arg !== null) {
                    return stmt.all(normalizeParams(arg));
                }
                return stmt.all(...params);
            },
            run(...params: any[]) {
                const arg = params[0];
                if (params.length === 1 && typeof arg === 'object' && arg !== null) {
                    return stmt.run(normalizeParams(arg));
                }
                return stmt.run(...params);
            }
        };
    }

    query(sql: string) {
        if (isBun) return this.inner.query(sql);
        return this.prepare(sql);
    }

    close() {
        this.inner.close();
    }

    transaction<T>(fn: () => T): T {
        this.run('BEGIN IMMEDIATE');
        try {
            const value = fn();
            this.run('COMMIT');
            return value;
        } catch (error) {
            try {
                this.run('ROLLBACK');
            } catch {}
            throw error;
        }
    }
}

function normalizeParams(arg: any) {
    if (typeof arg === 'object' && arg !== null) {
        const newArg: any = {};
        for (const [key, value] of Object.entries(arg)) {
            const cleanKey = key.replace(/^[\$:@]/, '');
            newArg[cleanKey] = value;
            newArg['$' + cleanKey] = value;
            newArg[':' + cleanKey] = value;
            newArg['@' + cleanKey] = value;
        }
        return newArg;
    }
    return arg;
}

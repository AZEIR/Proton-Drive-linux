import { mkdirSync } from 'node:fs';
import path from 'node:path';

const isBun = typeof process !== 'undefined' && process.versions && (process.versions as any).bun;

export class Database {
    private inner: any;

    constructor(filename: string, options?: any) {
        if (isBun) {
            const BunDatabase = require('bun:sqlite').Database;
            this.inner = new BunDatabase(filename, options);
        } else {
            const BetterSqlite3 = require('better-sqlite3');
            mkdirSync(path.dirname(filename), { recursive: true });
            const nodeOptions: any = {};
            if (options) {
                if (options.readonly) nodeOptions.readonly = true;
                if (options.create === false) nodeOptions.fileMustExist = true;
            }
            this.inner = new BetterSqlite3(filename, nodeOptions);
        }
        try {
            this.run('PRAGMA journal_mode = WAL');
            this.run('PRAGMA busy_timeout = 5000');
            // WAL mode does not need FULL sync — NORMAL is crash-safe and ~2x faster
            this.run('PRAGMA synchronous = NORMAL');
            // 8 MB page cache (negative value = KiB units), reduces repeated block reads
            this.run('PRAGMA cache_size = -8000');
        } catch (err) {
            // Ignore errors (e.g. if database is read-only)
        }
    }

    run(sql: string, ...params: any[]) {
        if (isBun) {
            this.inner.run(sql, ...params);
        } else {
            if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null) {
                this.inner.prepare(sql).run(normalizeParams(params[0]));
            } else if (params.length > 0) {
                this.inner.prepare(sql).run(...params);
            } else {
                this.inner.exec(sql);
            }
        }
    }

    prepare(sql: string) {
        if (isBun) {
            return this.inner.prepare(sql);
        }
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
        if (isBun) {
            return this.inner.query(sql);
        }
        return this.prepare(sql);
    }

    close() {
        this.inner.close();
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

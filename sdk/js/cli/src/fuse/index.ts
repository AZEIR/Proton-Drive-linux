/**
 * Proton Drive File-On-Demand FUSE Daemon — Main Entry Point
 *
 * Mounts a virtual filesystem at ~/ProtonDrive (or configured path).
 * Files appear as stubs; content is downloaded transparently on first open.
 * Writes are uploaded back to Proton Drive on file close.
 *
 * Usage:
 *   proton-fuse [--mount-point /path/to/mount] [--port 8085]
 */
import '@protontech/drive-sdk/polyfill';

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { FeatureFlags } from '@protontech/drive-sdk';

import { init } from '../init';
import { SyncDatabase } from '../sync/db';
import { startDashboard } from '../sync/dashboard';
import { CacheManager } from './cache';
import { InodeTable } from './inode';
import { FuseOperations } from './operations';
import { RemoteEventHandler } from './remoteEvents';
import { Uploader } from './uploader';

declare const APP_VERSION: string;
declare const SDK_VERSION: string | undefined;

// ─── Parse CLI args ────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    let mountPoint = process.env.PROTON_MOUNT_POINT
        ?? path.join(homedir(), 'ProtonDrive');
    let port = parseInt(process.env.PROTON_SYNC_PORT ?? '8085', 10);

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--mount-point' && args[i + 1]) mountPoint = args[++i];
        if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
    }

    return { mountPoint, port };
}

// ─── Check FUSE availability ─────────────────────────────────────────────

function checkFuse() {
    try {
        execSync('fusermount3 --version', { stdio: 'pipe' });
    } catch {
        try {
            execSync('fusermount --version', { stdio: 'pipe' });
        } catch {
            console.error(
                '\n[proton-fuse] ERROR: FUSE3 is not available on this system.\n' +
                'Please install it with:\n' +
                '  Fedora/RHEL:   sudo dnf install fuse3 fuse3-devel\n' +
                '  Ubuntu/Debian: sudo apt install fuse3 libfuse3-dev\n' +
                '  Arch:          sudo pacman -S fuse3\n',
            );
            process.exit(1);
        }
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────

export async function runFuse(mountPoint: string, port: number) {
    checkFuse();

    // ── SDK Init ────────────────────────────────────────────────────────
    const session = await init({
        clientUidPrefix:     'sdk-js-cli',
        appVersion:          typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'external-drive-sdkclijs@0.0.0',
        sdkVersion:          typeof SDK_VERSION !== 'undefined' ? SDK_VERSION : 'js@0.0.0',
        enablePersistedEvents: true,
        enableConsoleLog:    false,
        enableMetrics:       false,
        flags: {
            [FeatureFlags.DriveCryptoEncryptBlocksWithPgpAead]: true,
            [FeatureFlags.DriveSmallFileUpload]: false,
        },
    });

    const logger = session.logger;
    logger.info('[proton-fuse] Initializing Proton Drive FOD daemon...');

    // ── Data paths ──────────────────────────────────────────────────────
    const xdgData  = process.env.XDG_DATA_HOME   ?? path.join(homedir(), '.local', 'share');
    const xdgCache = process.env.XDG_CACHE_HOME  ?? path.join(homedir(), '.cache');
    const inodeDbPath = path.join(xdgData, 'proton-drive-fod', 'inodes.db');
    const syncDbPath  = path.join(homedir(), '.config', 'proton-drive-sync', 'sync_state.db');

    // ── Core modules ────────────────────────────────────────────────────
    const inodes  = new InodeTable(inodeDbPath);
    const cache   = new CacheManager(path.join(xdgCache, 'proton-drive-fod'));
    const db      = new SyncDatabase(syncDbPath);
    const uploader = new Uploader(session.sdk, cache, inodes, logger);

    const fuseOps = new FuseOperations(session.sdk, inodes, cache, uploader, logger);

    // ── Auth check ──────────────────────────────────────────────────────
    if (!session.auth.isLoggedIn()) {
        logger.warn('[proton-fuse] Not logged in. Dashboard will be available at http://localhost:' + port);
        db.log('system', 'system', 'failed', 'Not logged in — run ./drive.sh login to authenticate');
    } else {
        // Get the remote root folder and set up events
        const rootFolder = await session.sdk.getMyFilesRootFolder();
        fuseOps.remoteRootUid = rootFolder.uid;

        // Seed root inode with the real remote UID
        inodes.upsert({
            ino:          inodes.rootIno,
            node_uid:     rootFolder.uid,
            parent_ino:   0,
            name:         '',
            local_path:   '',
            is_dir:       1,
            size:         0,
            remote_mtime: Date.now(),
            is_local:     1,
            mode:         16877, // 0o40755
        });

        // Start remote event subscription
        const remoteEvents = new RemoteEventHandler(
            session.sdk,
            inodes,
            cache,
            logger,
            undefined,
            session.eventsProvider,
        );
        await remoteEvents.start(rootFolder);

        db.log('system', 'system', 'completed', `FOD daemon started. Remote root UID: ${rootFolder.uid}`);
    }

    // ── Mount FUSE ──────────────────────────────────────────────────────
    mkdirSync(mountPoint, { recursive: true });

    // Lazy-load fuse-native so the binary can still start if native addon
    // is being compiled for the first time.
    let Fuse: any;
    try {
        Fuse = (await import('fuse-native')).default;
        if (Fuse && Fuse.prototype) {
            const origFuseOptions = Fuse.prototype._fuseOptions;
            if (typeof origFuseOptions === 'function') {
                Fuse.prototype._fuseOptions = function() {
                    let optsStr = origFuseOptions.call(this);
                    if (this.opts && this.opts.options && Array.isArray(this.opts.options)) {
                        const extra = this.opts.options.join(',');
                        if (optsStr) {
                            optsStr += ',' + extra;
                        } else {
                            optsStr = '-o' + extra;
                        }
                    }
                    return optsStr;
                };
            }
        }
    } catch (err: any) {
        logger.error('[proton-fuse] Failed to load fuse-native. Run: cd sdk/js/cli && bun add fuse-native', err);
        process.exit(1);
    }

    const ops = fuseOps.build();
    const fuse = new Fuse(mountPoint, ops, {
        debug:          false,
        allowOther:     false,
        autoUnmount:    true,
        displayFolder:  false,
        options:        ['nonempty'],
    });

    await new Promise<void>((resolve, reject) => {
        fuse.mount((err: Error | null) => {
            if (err) return reject(err);
            resolve();
        });
    });

    logger.info(`[proton-fuse] Mounted at ${mountPoint}`);
    db.log('system', 'system', 'completed', `FUSE filesystem mounted at ${mountPoint}`);

    // ── Start Dashboard ─────────────────────────────────────────────────
    const server = startDashboard(db, null as any, session, port, {
        isFuseMode:  true,
        mountPoint,
        getInodes:   () => inodes.getAll(),
        getCached:   () => inodes.getCachedFiles(),
        getCacheStats: () => cache.getStats(),
        evictFile:   async (nodeUid: string) => {
            const evicted = await cache.evict(nodeUid);
            if (evicted) {
                const ino = inodes.getByUid(nodeUid);
                if (ino) inodes.setStub(ino.ino);
            }
            return evicted;
        },
        pinFile:     async (nodeUid: string) => {
            const inode = inodes.getByUid(nodeUid);
            if (!inode || inode.is_dir) return false;
            try {
                const node = await session.sdk.getNode(nodeUid);
                await import('./uploader').then(m =>
                    m.downloadToCache(session.sdk, cache, inodes, node, logger));
                return true;
            } catch {
                return false;
            }
        },
        getUploads:  () => uploader.getActiveUploads(),
    });

    // ── Graceful shutdown ───────────────────────────────────────────────
    const shutdown = async () => {
        logger.info('[proton-fuse] Shutting down...');
        server.stop();
        db.log('system', 'system', 'completed', 'FOD daemon stopping');

        await new Promise<void>((resolve) => {
            fuse.unmount((err: any) => {
                if (err) logger.warn(`[proton-fuse] Unmount error: ${err}`);
                resolve();
            });
        });

        inodes.close();
        db.close();
        await session.dispose();
        logger.info('[proton-fuse] Shutdown complete.');
        process.exit(0);
    };

    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);

    console.log(`\n=======================================================`);
    console.log(` Proton Drive FOD (File-On-Demand) daemon is running!`);
    console.log(` Mount point : ${mountPoint}`);
    console.log(` Dashboard   : http://localhost:${port}`);
    console.log(`=======================================================\n`);
}

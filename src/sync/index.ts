import { FeatureFlags } from '@protontech/drive-sdk';
import { initSdk } from '../sdk/adapter';
import { SyncDatabase } from './db';
import { startDashboard } from './dashboard';
import { SyncEngine } from './engine';
import { ProtonFuseEngine } from '../fod/fuse';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { startControlSocket } from './controlSocket';
import { classifyStartupIssue, type StartupIssue } from './startupIssue';

const APP_VERSION = 'external-drive-azeir_proton_drive_linux@1.3.0-stable';
const SDK_VERSION = 'js@0.19.2';

export async function runSync(port: number = 8085) {
    const clientUidPrefix = 'sdk-js-cli';
    const db = new SyncDatabase();

    // Check requested mode from ENV or Database
    const requestedMode = (process.env.PROTON_SYNC_MODE as 'full' | 'fuse') || db.getSyncMode();
    if (requestedMode === 'fuse') {
        const requestedMount = process.env.PROTON_FUSE_MOUNT_POINT;
        if (requestedMount) db.setFuseMountPoint(path.resolve(requestedMount));
        const fullPath = db.getConfig('local_sync_path', '');
        if (fullPath && path.resolve(fullPath) === path.resolve(db.getFuseMountPoint())) {
            db.setConfig(
                'local_sync_path',
                db.getConfig('last_full_sync_path', path.join(homedir(), 'P-Drive')),
            );
        }
    } else if (process.env.PROTON_FULL_SYNC_PATH) {
        const fullPath = path.resolve(process.env.PROTON_FULL_SYNC_PATH);
        db.setConfig('local_sync_path', fullPath);
        db.setConfig('last_full_sync_path', fullPath);
    }
    db.setSyncMode(requestedMode);

    const initOptions = {
        clientUidPrefix,
        appVersion: APP_VERSION,
        sdkVersion: SDK_VERSION,
        enablePersistedEvents: true,
        enableConsoleLog: false,
        enableMetrics: false,
        // SyncEngine is the sole event subscription owner. It durably writes
        // each event to journal.sqlite before advancing the persisted cursor.
        startEventSubscriptions: false,
        flags: {
            [FeatureFlags.DriveCryptoEncryptBlocksWithPgpAead]: true,
            [FeatureFlags.DriveSmallFileUpload]: false,
        },
    };

    let session: any = null;
    let engine: SyncEngine | null = null;
    let fuseEngine: ProtonFuseEngine | null = null;
    let startupIssue: StartupIssue | null = null;

    try {
        session = await initSdk(initOptions);
    } catch (initErr: any) {
        startupIssue = classifyStartupIssue(initErr);
        console.error('Initialization error details:', initErr);
        console.warn(`${startupIssue.message}. Retrying initialization...`);
        db.log('system', 'system', 'failed', `${startupIssue.message}. Retrying initialization...`);
    }

    if (session) {
        const logger = session.logger;
        logger.info(`Initializing Proton Drive Sync Daemon in ${requestedMode.toUpperCase()} Mode...`);

        if (requestedMode === 'fuse') {
            fuseEngine = new ProtonFuseEngine(db, session.sdk, session.auth, logger, undefined, session.clientUid);
            engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider, session.clientUid);
            engine.setFodMetadataSync(async () => {
                await fuseEngine!.scanRemoteTree();
                const error = fuseEngine!.getLastError();
                if (error) throw new Error(error);
            });
        } else {
            engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider, session.clientUid);
            if (process.env.PROTON_SYNC_ONCE === 'true') {
                if (!session.auth.isLoggedIn()) {
                    logger.error('User is not logged in! One-time sync requires authentication.');
                    process.exit(1);
                }
                try {
                    await engine.syncOnce();
                    logger.info('One-time sync complete.');
                } catch (err) {
                    logger.error('One-time sync failed:', err);
                } finally {
                    db.close();
                    await session.dispose();
                    process.exit(0);
                }
            }
        }
    }

    // Start Dashboard HTTP Server immediately
    const server = startDashboard(
        db,
        engine,
        session,
        port,
        fuseEngine || undefined,
        startupIssue,
    );
    const controlSocket = startControlSocket({
        dashboardUrl: () => server.getAuthenticatedUrl(),
        status: () => ({
            status: fuseEngine?.getStatus() ?? engine?.getStatus() ?? (startupIssue ? 'error' : 'offline'),
            mode: db.getSyncMode(),
            isPaused: fuseEngine?.getIsPaused() ?? engine?.getStatus() === 'paused',
            pendingOperations: db.journal.getPendingOperationCount(),
            pendingEvents: db.journal.getPendingRemoteEventCount(),
        }),
        pause: async () => {
            if (fuseEngine) await fuseEngine.pause();
            else await engine?.pause();
        },
        resume: async () => {
            if (fuseEngine) await fuseEngine.resume();
            else await engine?.resume();
        },
        sync: async () => {
            if (fuseEngine) await fuseEngine.scanRemoteTree();
            else await engine?.forceSync();
        },
        openFolder: async () => {
            const target = fuseEngine?.mountPoint ?? engine?.getLocalSyncRoot();
            if (!target) throw new Error('No configured filesystem root');
            execFile('xdg-open', [target]);
        },
    });

    if (session && session.auth.isLoggedIn()) {
        if (fuseEngine && engine) {
            await fuseEngine.start();
            engine.startFodEventLoop().catch((err) => {
                session.logger.error('FUSE event loop error:', err);
            });
        } else if (engine) {
            engine.start().catch((err) => {
                session.logger.error('SyncEngine startup error:', err);
            });
        }
    } else if (session) {
        session.logger.warn('User is not logged in. Starting daemon dashboard for authentication...');
        db.log('system', 'system', 'failed', 'Authentication required. Please open the dashboard to sign in.');
    }

    // Retry local SDK initialization when a session service or another startup
    // dependency was not ready yet. Network connectivity is owned by the sync
    // engine after initialization and is never inferred from this path.
    let initializationRecoveryInterval: ReturnType<typeof setInterval> | null = null;
    let initializationRecoveryInProgress = false;
    if (!session) {
        initializationRecoveryInterval = setInterval(async () => {
            if (initializationRecoveryInProgress) return;
            initializationRecoveryInProgress = true;
            try {
                const newSession = await initSdk(initOptions);
                if (initializationRecoveryInterval) clearInterval(initializationRecoveryInterval);
                initializationRecoveryInterval = null;
                session = newSession;
                startupIssue = null;
                server.updateStartupIssue(null);
                const logger = session.logger;
                logger.info('Startup initialization recovered; initializing sync engine...');
                db.log('system', 'system', 'completed', 'Startup initialization recovered.');

                if (requestedMode === 'fuse') {
                    fuseEngine = new ProtonFuseEngine(
                        db,
                        session.sdk,
                        session.auth,
                        logger,
                        undefined,
                        session.clientUid,
                    );
                    engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider, session.clientUid);
                    engine.setFodMetadataSync(async () => {
                        await fuseEngine!.scanRemoteTree();
                        const error = fuseEngine!.getLastError();
                        if (error) throw new Error(error);
                    });
                    server.updateContext(engine, session, fuseEngine);
                    if (session.auth.isLoggedIn()) {
                        await fuseEngine.start();
                        engine.startFodEventLoop().catch((err) => {
                            logger.error('FUSE event loop error:', err);
                        });
                    } else {
                        db.log('system', 'system', 'failed', 'Authentication required. Please open the dashboard to sign in.');
                    }
                } else {
                    engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider, session.clientUid);
                    server.updateContext(engine, session);
                    if (session.auth.isLoggedIn()) {
                        await engine.start().catch((err) => {
                            logger.error('SyncEngine startup error:', err);
                        });
                    } else {
                        db.log('system', 'system', 'failed', 'Authentication required. Please open the dashboard to sign in.');
                    }
                }
            } catch (error) {
                if (!session) {
                    startupIssue = classifyStartupIssue(error);
                    server.updateStartupIssue(startupIssue);
                } else {
                    session.logger.error('Post-initialization sync startup failed:', error);
                    db.log(
                        'system',
                        'system',
                        'failed',
                        `Startup recovered, but the sync engine failed to start: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            } finally {
                initializationRecoveryInProgress = false;
            }
        }, 15000);
        initializationRecoveryInterval.unref();
    }

    // Keep-alive timer to prevent Node event loop from exiting when running in background
    const keepAliveInterval = setInterval(() => {}, 60000);

    // Handle shutdown signals
    let cleanupPromise: Promise<void> | null = null;
    const cleanup = () => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
            if (initializationRecoveryInterval) clearInterval(initializationRecoveryInterval);
            clearInterval(keepAliveInterval);
            server.stop();
            await controlSocket.stop().catch(() => {});

            // Unmount and cancel the FUSE metadata scan before disposing the
            // event loop or SDK session. This keeps shutdown bounded even when
            // a remote request is still in flight.
            if (fuseEngine) await fuseEngine.stop().catch(() => {});
            if (engine) await engine.stop().catch(() => {});
            if (session) await session.dispose().catch(() => {});
            db.close();
            process.exit(0);
        })();
        return cleanupPromise;
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);

    // Log the startup
    console.log(`\n======================================================`);
    console.log(` Proton Drive Sync Client is running!`);
    console.log(` Dashboard UI available at: http://localhost:${port}`);
    console.log(`======================================================\n`);
}

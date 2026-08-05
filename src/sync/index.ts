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

    try {
        session = await initSdk(initOptions);
    } catch (initErr: any) {
        console.error('Initialization error details:', initErr);
        console.warn('Network offline or initialization error on startup:', initErr?.message || initErr);
        db.log('system', 'system', 'failed', `Startup offline: ${initErr?.message || initErr}. Monitoring connection...`);
    }

    if (session) {
        const logger = session.logger;
        logger.info(`Initializing Proton Drive Sync Daemon in ${requestedMode.toUpperCase()} Mode...`);

        if (requestedMode === 'fuse') {
            fuseEngine = new ProtonFuseEngine(db, session.sdk, session.auth, logger, undefined, session.clientUid);
            engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider);
            engine.setFodMetadataSync(async () => {
                await fuseEngine!.scanRemoteTree();
                const error = fuseEngine!.getLastError();
                if (error) throw new Error(error);
            });
        } else {
            engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider);
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
    const server = startDashboard(db, engine, session, port, fuseEngine || undefined);
    const controlSocket = startControlSocket({
        dashboardUrl: () => server.getAuthenticatedUrl(),
        status: () => ({
            status: fuseEngine?.getStatus() ?? engine?.getStatus() ?? 'offline',
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

    // A desktop keychain can become available shortly after the systemd user
    // service starts. Retry the saved session quietly instead of treating that
    // boot-order race as a logout that requires opening the web sign-in flow.
    let credentialRecoveryInterval: ReturnType<typeof setInterval> | null = null;
    let credentialRecoveryInProgress = false;
    const startCredentialRecovery = () => {
        if (credentialRecoveryInterval || !session) return;
        credentialRecoveryInterval = setInterval(async () => {
            if (!session || credentialRecoveryInProgress) return;
            if (session.auth.isLoggedIn()) {
                clearInterval(credentialRecoveryInterval!);
                credentialRecoveryInterval = null;
                return;
            }

            credentialRecoveryInProgress = true;
            try {
                await session.auth.loadSession();
                if (!session.auth.isLoggedIn()) return;

                session.logger.info('Recovered saved authentication session after credential store became available');
                if (fuseEngine && engine) {
                    await fuseEngine.start();
                    engine.startFodEventLoop().catch((err) => {
                        session.logger.error('FUSE event loop error:', err);
                    });
                } else if (engine) {
                    await engine.start();
                }
                clearInterval(credentialRecoveryInterval!);
                credentialRecoveryInterval = null;
            } catch (error: any) {
                session.logger.debug(
                    `Saved session is not available yet; retrying without requesting login: ${error?.message || error}`,
                );
            } finally {
                credentialRecoveryInProgress = false;
            }
        }, 15000);
        credentialRecoveryInterval.unref();
    };

    if (session && !session.auth.isLoggedIn()) {
        startCredentialRecovery();
    }

    // Background reconnect loop if initialized offline on boot
    let reconnectInterval: ReturnType<typeof setInterval> | null = null;
    if (!session) {
        reconnectInterval = setInterval(async () => {
            try {
                const newSession = await initSdk(initOptions);
                if (reconnectInterval) clearInterval(reconnectInterval);
                session = newSession;
                const logger = session.logger;
                logger.info('Connection established! Initializing sync engine...');

                if (requestedMode === 'fuse') {
                    fuseEngine = new ProtonFuseEngine(
                        db,
                        session.sdk,
                        session.auth,
                        logger,
                        undefined,
                        session.clientUid,
                    );
                    engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider);
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
                        startCredentialRecovery();
                    }
                } else {
                    engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider);
                    server.updateContext(engine, session);
                    if (session.auth.isLoggedIn()) {
                        await engine.start().catch((err) => {
                            logger.error('SyncEngine startup error:', err);
                        });
                    } else {
                        startCredentialRecovery();
                    }
                }
            } catch {
                // Still offline
            }
        }, 15000);
    }

    // Keep-alive timer to prevent Node event loop from exiting when running in background
    const keepAliveInterval = setInterval(() => {}, 60000);

    // Handle shutdown signals
    let cleanupPromise: Promise<void> | null = null;
    const cleanup = () => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
            if (reconnectInterval) clearInterval(reconnectInterval);
            if (credentialRecoveryInterval) clearInterval(credentialRecoveryInterval);
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

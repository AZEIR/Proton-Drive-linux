import { FeatureFlags } from '@protontech/drive-sdk';
import { initSdk } from '../sdk/adapter';
import { SyncDatabase } from './db';
import { startDashboard } from './dashboard';
import { SyncEngine } from './engine';
import { ProtonFuseEngine } from '../fod/fuse';

declare const APP_VERSION: string;
declare const SDK_VERSION: string | undefined;

export async function runSync(port: number = 8085) {
    const clientUidPrefix = 'sdk-js-cli';
    const db = new SyncDatabase();

    // Check requested mode from ENV or Database
    const requestedMode = (process.env.PROTON_SYNC_MODE as 'full' | 'fuse') || db.getSyncMode();
    db.setSyncMode(requestedMode);

    const initOptions = {
        clientUidPrefix,
        appVersion: typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'external-drive-azeir_proton_drive_linux@1.0.0-stable',
        sdkVersion: typeof SDK_VERSION !== 'undefined' ? SDK_VERSION : 'js@0.0.0',
        enablePersistedEvents: true,
        enableConsoleLog: false,
        enableMetrics: false,
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
            fuseEngine = new ProtonFuseEngine(db, session.sdk, session.auth, logger);
            engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider);
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
                    fuseEngine = new ProtonFuseEngine(db, session.sdk, session.auth, logger);
                    engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider);
                    if (session.auth.isLoggedIn()) {
                        await fuseEngine.start();
                        engine.startFodEventLoop().catch((err) => {
                            logger.error('FUSE event loop error:', err);
                        });
                    }
                } else {
                    engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider);
                    if (session.auth.isLoggedIn()) {
                        await engine.start().catch((err) => {
                            logger.error('SyncEngine startup error:', err);
                        });
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
    const cleanup = async () => {
        if (reconnectInterval) clearInterval(reconnectInterval);
        clearInterval(keepAliveInterval);
        server.stop();
        if (engine) await engine.stop();
        if (fuseEngine) await fuseEngine.stop();
        db.close();
        if (session) await session.dispose();
        process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Log the startup
    console.log(`\n======================================================`);
    console.log(` Proton Drive Sync Client is running!`);
    console.log(` Dashboard UI available at: http://localhost:${port}`);
    console.log(`======================================================\n`);
}

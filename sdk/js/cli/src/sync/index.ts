import { FeatureFlags } from '@protontech/drive-sdk';
import { init } from '../init';
import { SyncDatabase } from './db';
import { startDashboard } from './dashboard';
import { SyncEngine } from './engine';

declare const APP_VERSION: string;
declare const SDK_VERSION: string | undefined;

export async function runSync(port: number = 8085) {
    const clientUidPrefix = 'sdk-js-cli';
    
    // Initialize session
    const session = await init({
        clientUidPrefix,
        appVersion: typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'external-drive-sdkclijs@0.0.0',
        sdkVersion: typeof SDK_VERSION !== 'undefined' ? SDK_VERSION : 'js@0.0.0',
        enablePersistedEvents: true,
        enableConsoleLog: false,
        enableMetrics: false,
        flags: {
            [FeatureFlags.DriveCryptoEncryptBlocksWithPgpAead]: true,
            [FeatureFlags.DriveSmallFileUpload]: false,
        },
    });

    const logger = session.logger;
    logger.info('Initializing Proton Drive Sync Daemon...');

    // Initialize Database and Sync Engine
    const db = new SyncDatabase();
    const engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider);

    // Start sync engine if logged in
    if (!session.auth.isLoggedIn()) {
        logger.error('User is not logged in! Please run auth login first.');
        db.log('system', 'system', 'failed', 'Authentication required. Open the dashboard or run login to connect.');
        process.exit(1);
    }

    if (process.env.PROTON_SYNC_ONCE === 'true') {
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

    await engine.start();

    // Start Dashboard
    const server = startDashboard(db, engine, session, port);

    // Handle shutdown signals
    const cleanup = async () => {
        logger.info('Shutting down sync daemon...');
        server.stop();
        await engine.stop();
        db.close();
        await session.dispose();
        logger.info('Sync daemon stopped.');
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

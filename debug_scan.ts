import fs from 'node:fs';
import path from 'node:path';
import { SyncDatabase } from './sdk/js/cli/src/sync/db.ts';
import { SyncEngine } from './sdk/js/cli/src/sync/engine.ts';
import { init } from './sdk/js/cli/src/init.ts';

async function run() {
    const session = await init({
        clientUidPrefix: 'debug',
        appVersion: 'debug-debug',
        sdkVersion: 'debug',
        enablePersistedEvents: false,
        enableConsoleLog: true,
        enableMetrics: false,
        flags: {},
    });

    const logger = session.logger;
    logger.info('Starting debug run...');

    if (!session.auth.isLoggedIn()) {
        logger.error('Not logged in!');
        process.exit(1);
    }

    const db = new SyncDatabase();
    const engine = new SyncEngine(db, session.sdk, session.auth, logger, session.eventsProvider);

    // Override scanRemoteDir to just log everything it finds
    const origScan = engine.scanRemoteDir.bind(engine);
    let total = 0;
    engine.scanRemoteDir = async (folderUid, relPath, result) => {
        console.log(`[DEBUG] Starting scan for folderUid=${folderUid} path=${relPath}`);
        try {
            await origScan(folderUid, relPath, result);
            console.log(`[DEBUG] Finished scan for folderUid=${folderUid} path=${relPath}, found ${result.size} items so far`);
        } catch (err) {
            console.error(`[DEBUG] Error in scanRemoteDir:`, err);
            throw err;
        }
    };

    try {
        console.log('[DEBUG] Calling forceSync()...');
        await engine.forceSync();
        console.log('[DEBUG] forceSync() completed successfully!');
    } catch (err) {
        console.error('[DEBUG] forceSync() failed:', err);
    } finally {
        process.exit(0);
    }
}

run();

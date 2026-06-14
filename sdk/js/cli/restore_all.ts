import { FeatureFlags } from '@protontech/drive-sdk';
import { init } from './src/init';

async function main() {
    console.log('Initializing SDK client...');
    const client = await init({
        clientUidPrefix: 'sdk-js-cli',
        appVersion: 'external-drive-sdkclijs@0.0.0',
        enablePersistedEvents: true,
        enableMetrics: false,
        flags: {
            [FeatureFlags.DriveCryptoEncryptBlocksWithPgpAead]: true,
            [FeatureFlags.DriveSmallFileUpload]: true,
        } as any
    });

    const { sdk } = client;

    try {
        console.log('Fetching all trashed nodes...');
        const trashedNodes = [];
        for await (const node of sdk.iterateTrashedNodes()) {
            if ('missingUid' in node) continue;
            const name = node.name.ok ? node.name.value : 'unknown';
            // Restoring items that have a trashTime and match our Test folder or are recently trashed
            console.log(`Found trashed item: ${name} (UID: ${node.uid})`);
            trashedNodes.push(node);
        }

        if (trashedNodes.length === 0) {
            console.log('No trashed items found.');
        } else {
            console.log(`Restoring ${trashedNodes.length} items...`);
            const results = sdk.restoreNodes(trashedNodes);
            for await (const res of results) {
                console.log(`Restore result for ${res.uid}: ok=${res.ok}`);
            }
            console.log('Restore complete!');
        }
    } catch (err) {
        console.error('Error during restoration:', err);
    } finally {
        await client.dispose();
    }
}

main().catch(console.error);

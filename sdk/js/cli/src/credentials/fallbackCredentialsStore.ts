import { Logger } from '@protontech/drive-sdk';
import type { Credentials, CredentialsStore } from './interface';

export class FallbackCredentialsStore implements CredentialsStore {
    private readonly primary: CredentialsStore;
    private readonly fallback: CredentialsStore;
    private useFallback: boolean = false;

    constructor(
        primary: CredentialsStore,
        fallback: CredentialsStore,
        private readonly logger: Logger
    ) {
        this.primary = primary;
        this.fallback = fallback;
    }

    async load(): Promise<Credentials | null> {
        if (this.useFallback) {
            return this.fallback.load();
        }
        try {
            this.logger.debug('Attempting to load credentials from primary secure store');
            const creds = await this.primary.load();
            if (creds) {
                this.logger.debug('Successfully loaded credentials from primary secure store');
                return creds;
            }
            // If primary is empty, also check fallback store just in case
            this.logger.debug('Primary secure store returned no credentials, checking fallback store');
            return await this.fallback.load();
        } catch (err: any) {
            this.logger.warn(
                `Primary secure credentials store failed to load. Falling back to plaintext file store. Error: ${err.message || err}`
            );
            this.useFallback = true;
            return this.fallback.load();
        }
    }

    async save(snapshot: Credentials): Promise<void> {
        // Always attempt primary first (keyring).
        try {
            this.logger.debug('Attempting to save credentials to primary secure store');
            await this.primary.save(snapshot);
            this.logger.debug('Successfully saved credentials to primary secure store');
        } catch (err: any) {
            this.logger.warn(
                `Primary secure credentials store failed to save. Error: ${err.message || err}`
            );
            this.useFallback = true;
        }
        // Always write to the file fallback so credentials survive a keyring
        // outage at service startup time (e.g. GNOME Keyring not yet unlocked).
        try {
            await this.fallback.save(snapshot);
        } catch (err: any) {
            this.logger.warn(`Failed to save credentials to fallback plaintext file store: ${err.message || err}`);
        }
    }

    async remove(): Promise<void> {
        this.logger.debug('Removing credentials from both primary and fallback stores');
        try {
            await this.primary.remove();
        } catch (err: any) {
            this.logger.warn(`Failed to remove credentials from primary secure store: ${err.message || err}`);
        }
        try {
            await this.fallback.remove();
        } catch (err: any) {
            this.logger.warn(`Failed to remove credentials from fallback plaintext file store: ${err.message || err}`);
        }
    }
}

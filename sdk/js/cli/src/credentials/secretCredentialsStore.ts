import { Logger } from '@protontech/drive-sdk';

import type { Credentials, CredentialsStore } from './interface';
import { parseStoredSnapshot } from './parseCredentials';

const SECRET_SERVICE = 'ch.proton.drive/drive-sdk-cli';
const SECRET_NAME = 'auth-session';
const KEYRING_TIMEOUT_MS = 5000;

// Rejects after `ms` so Promise.race() can bail out of a hanging D-Bus call.
function keyringTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Keyring operation timed out after ${ms}ms`)), ms)
    );
}

export class SecretsSessionStore implements CredentialsStore {
    constructor(private readonly logger: Logger) {}

    async load(): Promise<Credentials | null> {
        this.logger.debug(`Loading session ${SECRET_NAME} from secrets`);
        const raw = await Promise.race([
            Bun.secrets.get({ service: SECRET_SERVICE, name: SECRET_NAME }),
            keyringTimeout(KEYRING_TIMEOUT_MS),
        ]) as string | null;
        return parseStoredSnapshot(raw);
    }

    async save(snapshot: Credentials): Promise<void> {
        this.logger.debug(`Saving session ${SECRET_NAME} to secrets`);
        await Promise.race([
            Bun.secrets.set({ service: SECRET_SERVICE, name: SECRET_NAME, value: JSON.stringify(snapshot) }),
            keyringTimeout(KEYRING_TIMEOUT_MS),
        ]);
    }

    async remove(): Promise<void> {
        this.logger.debug(`Removing session ${SECRET_NAME} from secrets`);
        await Promise.race([
            Bun.secrets.delete({ service: SECRET_SERVICE, name: SECRET_NAME }),
            keyringTimeout(KEYRING_TIMEOUT_MS),
        ]);
    }
}

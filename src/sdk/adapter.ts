import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { init } from '../../sdk/cli/src/init';
import type { InitConfig } from '../../sdk/cli/src/config';
import type { EventsProvider } from '../../sdk/cli/src/events/interface';

export type { InitConfig, EventsProvider };

export interface AccountQuota {
    maxSpace: number;
    usedSpace: number;
}

export type SdkClientInstance = Awaited<ReturnType<typeof init>> & {
    getQuota: () => Promise<AccountQuota>;
};

/**
 * Initializes the Proton Drive SDK and attaches application-level helpers such as user quota querying.
 */
export async function initSdk(configOptions: InitConfig): Promise<SdkClientInstance> {
    const client = await init(configOptions);

    const getQuota = async (): Promise<AccountQuota> => {
        const apiClient = (client as any).apiClient;
        if (!apiClient) return { maxSpace: 0, usedSpace: 0 };
        const response = (await apiClient.authenticatedRequest
            .get(`${apiClient.baseUrlWithProtocol}/core/v4/users`)
            .json()) as { User?: { MaxSpace?: number; UsedSpace?: number } };
        return {
            maxSpace: response.User?.MaxSpace ?? 0,
            usedSpace: response.User?.UsedSpace ?? 0,
        };
    };

    return {
        ...client,
        getQuota,
    };
}

/**
 * Calculates SHA1 hash for a local file.
 */
export async function getSha1(localPath: string): Promise<string> {
    const hash = createHash('sha1');
    for await (const chunk of createReadStream(localPath)) {
        hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
}

/**
 * Opens `url` in the system default browser.
 */
export function openBrowserUrl(rawUrl: string): void {
    if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://'))) {
        return;
    }
    const child =
        process.platform === 'darwin'
            ? spawn('open', [rawUrl], { detached: true, stdio: 'ignore' })
            : process.platform === 'win32'
              ? spawn('start', ['', rawUrl], { detached: true, stdio: 'ignore', windowsHide: true })
              : spawn('xdg-open', [rawUrl], { detached: true, stdio: 'ignore' });

    child.on('error', () => {});
    child.unref();
}

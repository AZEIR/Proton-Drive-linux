import http from 'node:http';
import https from 'node:https';
import { Agent, setGlobalDispatcher } from 'undici';

let activeMaxSockets = 4;
let activeDispatcher: Agent | null = null;

export const MAX_PARALLEL_FILE_TRANSFERS = 5;

export type NetworkProfile = 'safe' | 'balanced' | 'performance' | 'custom';

export const NETWORK_PROFILE_SETTINGS = {
    safe: { concurrency: 1, maxSockets: 2, wifiSafeMode: true },
    balanced: { concurrency: 3, maxSockets: 8, wifiSafeMode: false },
    performance: { concurrency: 5, maxSockets: 16, wifiSafeMode: false },
} as const;

export function inferNetworkProfile(concurrency: number, wifiSafeMode: boolean): NetworkProfile {
    if (wifiSafeMode && concurrency === NETWORK_PROFILE_SETTINGS.safe.concurrency) return 'safe';
    if (!wifiSafeMode && concurrency === NETWORK_PROFILE_SETTINGS.balanced.concurrency) return 'balanced';
    if (!wifiSafeMode && concurrency === NETWORK_PROFILE_SETTINGS.performance.concurrency) return 'performance';
    return 'custom';
}

export function getRecommendedSocketLimit(concurrency: number, wifiSafeMode: boolean): number {
    if (wifiSafeMode) return NETWORK_PROFILE_SETTINGS.safe.maxSockets;
    if (concurrency >= 5) return NETWORK_PROFILE_SETTINGS.performance.maxSockets;
    if (concurrency === 4) return 12;
    if (concurrency === 3) return NETWORK_PROFILE_SETTINGS.balanced.maxSockets;
    if (concurrency === 2) return 6;
    return 4;
}

/**
 * Configures global HTTP/HTTPS agents and undici fetch dispatchers with conservative
 * connection pool limits to prevent TCP SYN flood, socket pool exhaustion, and router NAT overflows.
 */
export function setupNetworkSocketLimits(maxSockets = 4): void {
    activeMaxSockets = maxSockets;
    const defaultOptions = {
        keepAlive: true,
        keepAliveMsecs: 10000,
        maxSockets: activeMaxSockets,
        maxFreeSockets: 2,
        timeout: 60000,
    };

    http.globalAgent = new http.Agent(defaultOptions);
    https.globalAgent = new https.Agent(defaultOptions);

    replaceFetchDispatcher(maxSockets);
}

export function updateNetworkSocketLimits(maxSockets: number): void {
    if (maxSockets <= 0) return;
    activeMaxSockets = maxSockets;
    if (http.globalAgent) http.globalAgent.maxSockets = maxSockets;
    if (https.globalAgent) https.globalAgent.maxSockets = maxSockets;

    replaceFetchDispatcher(maxSockets);
}

function replaceFetchDispatcher(maxSockets: number): void {
    const previous = activeDispatcher;
    activeDispatcher = new Agent({
        connections: maxSockets,
        keepAliveTimeout: 15000,
        keepAliveMaxTimeout: 60000,
    });
    setGlobalDispatcher(activeDispatcher);
    if (previous && typeof previous.close === 'function') {
        void Promise.resolve(previous.close()).catch(() => {});
    }
}

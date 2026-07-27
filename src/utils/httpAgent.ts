import http from 'node:http';
import https from 'node:https';
import { Agent, setGlobalDispatcher } from 'undici';

let activeMaxSockets = 4;
let activeDispatcher: Agent | null = null;

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

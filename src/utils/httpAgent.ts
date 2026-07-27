import http from 'node:http';
import https from 'node:https';

let activeMaxSockets = 4;

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

    try {
        const req = typeof eval !== 'undefined' ? eval('require') : require;
        const undici = req('undici');
        if (undici && typeof undici.setGlobalDispatcher === 'function' && undici.Agent) {
            const dispatcher = new undici.Agent({
                connections: maxSockets,
                keepAliveTimeout: 15000,
                keepAliveMaxTimeout: 60000,
            });
            undici.setGlobalDispatcher(dispatcher);
        }
    } catch {}
}

export function updateNetworkSocketLimits(maxSockets: number): void {
    if (maxSockets <= 0) return;
    activeMaxSockets = maxSockets;
    if (http.globalAgent) http.globalAgent.maxSockets = maxSockets;
    if (https.globalAgent) https.globalAgent.maxSockets = maxSockets;

    try {
        const req = typeof eval !== 'undefined' ? eval('require') : require;
        const undici = req('undici');
        if (undici && typeof undici.setGlobalDispatcher === 'function' && undici.Agent) {
            const dispatcher = new undici.Agent({
                connections: maxSockets,
                keepAliveTimeout: 15000,
                keepAliveMaxTimeout: 60000,
            });
            undici.setGlobalDispatcher(dispatcher);
        }
    } catch {}
}

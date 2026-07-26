import http from 'node:http';
import https from 'node:https';

/**
 * Configures global HTTP and HTTPS agents with conservative connection pool limits
 * to prevent socket pool exhaustion and Wi-Fi access point / router NAT table overflows.
 */
export function setupNetworkSocketLimits(): void {
    const defaultOptions = {
        keepAlive: true,
        keepAliveMsecs: 10000,
        maxSockets: 6,
        maxFreeSockets: 3,
        timeout: 60000,
    };

    http.globalAgent = new http.Agent(defaultOptions);
    https.globalAgent = new https.Agent(defaultOptions);
}

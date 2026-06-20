import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SyncDatabase } from './db';
import { SyncEngine } from './engine';
import { openBrowserUrl } from '../cli/openBrowserUrl';
import { getHtmlContent } from './dashboard/template';

export interface FodHooks {
    isFuseMode:   boolean;
    mountPoint:   string;
    getInodes:    () => any[];
    getCached:    () => any[];
    getCacheStats: () => { totalFiles: number; totalBytes: number };
    evictFile:    (nodeUid: string) => Promise<boolean>;
    pinFile:      (nodeUid: string) => Promise<boolean>;
    getUploads:   () => any[];
}

export function startDashboard(
    db: SyncDatabase,
    engine: SyncEngine | null,
    session: any,
    port: number = 8085,
    fod?: FodHooks,
) {
    const logger = session.logger;
    let isAuthenticating = false;
    let cachedEmail = 'Not Logged In';

    const server = Bun.serve({
        port,
        async fetch(req) {
            const url = new URL(req.url);

            // API ENDPOINTS
            if (url.pathname === '/api/status') {
                let email = 'Not Logged In';
                try {
                    if (session.auth.isLoggedIn()) {
                        const primaryAddress = await session.addresses.getOwnPrimaryAddress();
                        email = primaryAddress.email;
                        cachedEmail = email;

                        // Legacy full-sync: auto-start if idle
                        if (engine && engine.getStatus() === 'idle') {
                            engine.start();
                        }
                    } else {
                        cachedEmail = 'Not Logged In';
                    }
                } catch {}

                if (fod?.isFuseMode) {
                    // FOD mode status
                    const uploads = fod.getUploads();
                    return Response.json({
                        status:          session.auth.isLoggedIn() ? 'synced' : 'auth_required',
                        mode:            'fod',
                        mountPoint:      fod.mountPoint,
                        activeTransfers: uploads.map((u: any) => ({ ...u, type: 'upload' })),
                        isPaused:        false,
                        bulkDeletionCount: 0,
                        email,
                        isAuthenticating,
                    }, {
                        headers: { 'Access-Control-Allow-Origin': '*' }
                    });
                }

                return Response.json({
                    status:            engine!.getStatus(),
                    mode:              'full',
                    activeTransfers:   engine!.getActiveTransfers(),
                    localSyncRoot:     engine!.getLocalSyncRoot(),
                    isPaused:          engine!.getStatus() === 'paused',
                    bulkDeletionCount: engine!.getBulkDeletionCount(),
                    email,
                    isAuthenticating,
                }, {
                    headers: { 'Access-Control-Allow-Origin': '*' }
                });
            }

            if (req.method === 'POST' && url.pathname === '/api/login') {
                if (session.auth.isLoggedIn()) {
                    return Response.json({ ok: false, error: 'Already logged in' }, { status: 400 });
                }
                if (isAuthenticating) {
                    return Response.json({ ok: false, error: 'Authentication already in progress' }, { status: 400 });
                }

                isAuthenticating = true;
                db.log('system', 'system', 'syncing', 'Starting web-based login process');
                if (engine) {
                    engine.emit('statusChanged');
                }

                try {
                    const signInUrlPromise = new Promise<string>((resolve, reject) => {
                        session.auth.authViaWeb((signInUrl: string) => {
                            resolve(signInUrl);
                            openBrowserUrl(signInUrl);
                        }).then(async () => {
                            isAuthenticating = false;
                            db.log('system', 'system', 'completed', 'Authentication successful. Starting sync engine...');
                            try {
                                if (session.auth.isLoggedIn()) {
                                    const primaryAddress = await session.addresses.getOwnPrimaryAddress();
                                    cachedEmail = primaryAddress.email;
                                }
                            } catch {}
                            if (engine) {
                                await engine.start();
                                engine.emit('statusChanged');
                            }
                        }).catch((err: any) => {
                            isAuthenticating = false;
                            db.log('system', 'system', 'failed', `Authentication failed: ${err.message || err}`);
                            logger.error('Web authentication failed:', err);
                            if (engine) {
                                engine.emit('statusChanged');
                            }
                        });
                    });

                    const signInUrl = await signInUrlPromise;
                    return Response.json({ ok: true, signInUrl });
                } catch (err: any) {
                    isAuthenticating = false;
                    if (engine) {
                        engine.emit('statusChanged');
                    }
                    return Response.json({ ok: false, error: err.message || String(err) }, { status: 500 });
                }
            }

            if (url.pathname === '/api/quota') {
                try {
                    if (session.auth.isLoggedIn()) {
                        const quota = await session.getQuota();
                        const percent = quota.maxSpace > 0 ? (quota.usedSpace / quota.maxSpace) * 100 : 0;
                        return Response.json({
                            usedSpace: quota.usedSpace,
                            maxSpace: quota.maxSpace,
                            usedSpaceFormatted: formatBytes(quota.usedSpace),
                            maxSpaceFormatted: formatBytes(quota.maxSpace),
                            percent: Math.round(percent * 100) / 100,
                        });
                    }
                } catch (err) {
                    logger.warn('Failed to load quota:', err);
                }
                return Response.json({ usedSpace: 0, maxSpace: 0, usedSpaceFormatted: '0 B', maxSpaceFormatted: '0 B', percent: 0 });
            }

            if (url.pathname === '/api/logs') {
                const limit = parseInt(url.searchParams.get('limit') || '500', 10) || 500;
                const logs = db.getRecentLogs(limit);
                return Response.json(logs);
            }

            // ── FOD-specific endpoints ──────────────────────────────────────
            if (fod?.isFuseMode) {
                if (url.pathname === '/api/cached-files') {
                    const cached = fod.getCached();
                    const stats  = fod.getCacheStats();
                    return Response.json({ files: cached, stats });
                }

                if (req.method === 'POST' && url.pathname === '/api/evict') {
                    const body = await req.json() as { nodeUid?: string };
                    if (!body?.nodeUid) return Response.json({ ok: false, error: 'nodeUid required' }, { status: 400 });
                    const ok = await fod.evictFile(body.nodeUid);
                    db.log(body.nodeUid, 'system', ok ? 'completed' : 'failed', ok ? 'Evicted from cache' : 'Evict failed');
                    return Response.json({ ok });
                }

                if (req.method === 'POST' && url.pathname === '/api/pin') {
                    const body = await req.json() as { nodeUid?: string };
                    if (!body?.nodeUid) return Response.json({ ok: false, error: 'nodeUid required' }, { status: 400 });
                    const ok = await fod.pinFile(body.nodeUid);
                    db.log(body.nodeUid, 'download', ok ? 'completed' : 'failed', ok ? 'Pinned to local cache' : 'Pin failed');
                    return Response.json({ ok });
                }

                if (req.method === 'POST' && url.pathname === '/api/open-folder') {
                    if (existsSync(fod.mountPoint)) {
                        exec(`xdg-open "${fod.mountPoint}"`);
                        return Response.json({ ok: true });
                    }
                    return Response.json({ ok: false, error: 'Mount point does not exist' }, { status: 404 });
                }

                if (req.method === 'POST' && url.pathname === '/api/logout') {
                    db.log('system', 'system', 'syncing', 'Logging out from Proton Drive');
                    await session.auth.logout();
                    return Response.json({ ok: true });
                }
            }

            // ── Legacy full-sync endpoints ──────────────────────────────────
            if (req.method === 'POST') {
                if (url.pathname === '/api/pause') {
                    await engine?.pause();
                    return Response.json({ ok: true });
                }

                if (url.pathname === '/api/resume') {
                    await engine?.resume();
                    return Response.json({ ok: true });
                }

                if (url.pathname === '/api/confirm-deletions') {
                    await engine?.confirmBulkDeletions();
                    return Response.json({ ok: true });
                }

                if (url.pathname === '/api/restore-deletions') {
                    await engine?.restoreBulkDeletions();
                    return Response.json({ ok: true });
                }

                if (url.pathname === '/api/sync') {
                    engine?.forceSync(); // Run async
                    return Response.json({ ok: true });
                }

                if (url.pathname === '/api/set-path') {
                    const body = await req.json() as { path?: string };
                    if (body && body.path) {
                        try {
                            await engine?.setLocalSyncRoot(body.path);
                            return Response.json({ ok: true });
                        } catch (err: any) {
                            return Response.json({ ok: false, error: err.message || String(err) }, { status: 400 });
                        }
                    }
                    return Response.json({ ok: false, error: 'Path parameter required' }, { status: 400 });
                }

                if (url.pathname === '/api/logout') {
                    logger.info('Logging out session');
                    db.log('system', 'system', 'syncing', 'Logging out from Proton Drive');
                    await engine?.stop();
                    await session.auth.logout();
                    return Response.json({ ok: true });
                }

                if (url.pathname === '/api/open-folder') {
                    const localPath = engine?.getLocalSyncRoot() ?? '';
                    if (localPath && existsSync(localPath)) {
                        exec(`xdg-open "${localPath}"`);
                        return Response.json({ ok: true });
                    }
                    return Response.json({ ok: false, error: 'Directory does not exist' }, { status: 404 });
                }

                if (url.pathname === '/api/daemon/stop') {
                    db.log('system', 'system', 'syncing', 'Daemon stop requested from dashboard');
                    setTimeout(() => {
                        exec('systemctl --user stop proton-sync.service 2>/dev/null', () => process.exit(0));
                    }, 300);
                    return Response.json({ ok: true });
                }

                if (url.pathname === '/api/daemon/restart') {
                    db.log('system', 'system', 'syncing', 'Daemon restart requested from dashboard');
                    setTimeout(() => {
                        exec('systemctl --user restart proton-sync.service 2>/dev/null', (err) => {
                            if (err) process.exit(1); // non-zero so systemd restarts us
                        });
                    }, 300);
                    return Response.json({ ok: true });
                }
            }

            // SSE PUSH STREAM — replaces client-side 1s polling for status updates
            if (url.pathname === '/api/events') {
                let cleanup: (() => void) | null = null;
                const stream = new ReadableStream({
                    start(controller) {
                        const encoder = new TextEncoder();
                        const send = async () => {
                            try {
                                if (cachedEmail === 'Not Logged In' && session.auth.isLoggedIn()) {
                                    try {
                                        const primaryAddress = await session.addresses.getOwnPrimaryAddress();
                                        cachedEmail = primaryAddress.email;
                                    } catch {}
                                } else if (!session.auth.isLoggedIn()) {
                                    cachedEmail = 'Not Logged In';
                                }

                                let payload: string;
                                if (fod?.isFuseMode) {
                                    const uploads = fod.getUploads();
                                    payload = JSON.stringify({
                                        status:          session.auth.isLoggedIn() ? 'synced' : 'auth_required',
                                        mode:            'fod',
                                        mountPoint:      fod.mountPoint,
                                        activeTransfers: uploads.map((u: any) => ({ ...u, type: 'upload' })),
                                        isPaused:        false,
                                        bulkDeletionCount: 0,
                                        email:           cachedEmail,
                                        isAuthenticating,
                                    });
                                } else if (engine) {
                                    const status = engine.getStatus();
                                    const transfers = engine.getActiveTransfers();
                                    const bulkCount = engine.getBulkDeletionCount();
                                    const localSyncRoot = engine.getLocalSyncRoot();
                                    payload = JSON.stringify({
                                        status,
                                        mode: 'full',
                                        activeTransfers: transfers,
                                        bulkDeletionCount: bulkCount,
                                        isPaused: status === 'paused',
                                        isAuthenticating,
                                        localSyncRoot,
                                        email: cachedEmail
                                    });
                                } else {
                                    payload = JSON.stringify({
                                        status: 'error',
                                        error: 'Engine/FOD not initialized',
                                        email: cachedEmail,
                                        isAuthenticating,
                                    });
                                }
                                controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                            } catch {
                                // Client disconnected
                            }
                        };
                        // Send immediately on connect, then on every change
                        send();
                        if (engine) {
                            engine.on('statusChanged', send);
                            cleanup = () => engine.off('statusChanged', send);
                        } else if (fod?.isFuseMode) {
                            const interval = setInterval(send, 3000);
                            cleanup = () => clearInterval(interval);
                        }
                    },
                    cancel() {
                        if (cleanup) cleanup();
                    },
                });
                return new Response(stream, {
                    headers: {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'X-Accel-Buffering': 'no',
                    },
                });
            }

            // HTML FRONTEND PAGE
            if (url.pathname === '/' || url.pathname === '/index.html') {
                const isFod = fod?.isFuseMode ?? false;
                return new Response(getHtmlContent(isFod), {
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                });
            }

            return new Response('Not Found', { status: 404 });
        },
    });

    logger.info(`Dashboard server running at http://localhost:${port}`);
    return server;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}


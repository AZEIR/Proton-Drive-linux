import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { SyncDatabase } from './db';
import { SyncEngine } from './engine';
import { openBrowserUrl } from '../sdk/adapter';
import { getHtmlContent } from './dashboard/template';

export interface FodHooks {
    isFuseMode:         boolean;
    mountPoint:         string;
    getInodes:          () => any[];
    getCached:          () => any[];
    getCacheStats:       () => { totalFiles: number; totalBytes: number };
    evictFile:          (nodeUid: string) => Promise<boolean>;
    pinFile:            (nodeUid: string) => Promise<boolean>;
    hydrateFile?:       (nodeUid: string, relativePath: string) => Promise<string>;
    getUploads:         () => any[];
    getActiveTransfers?: () => any[];
    scanRemoteTree?:     () => Promise<void>;
    pause?:              () => Promise<void>;
    resume?:             () => Promise<void>;
    start?:              () => Promise<void>;
    stop?:               () => Promise<void>;
    getStatus?:          () => string;
    getIsPaused?:        () => boolean;
}

export async function startAuthenticatedSync(
    engine: SyncEngine | null,
    fod?: FodHooks,
): Promise<void> {
    if (fod?.isFuseMode) {
        if (!fod.start) throw new Error('FUSE engine is unavailable after authentication');
        await fod.start();
        await engine?.startFodEventLoop();
        engine?.emit('statusChanged');
        return;
    }
    if (engine) {
        await engine.start();
        engine.emit('statusChanged');
    }
}

export function startDashboard(
    db: SyncDatabase,
    initialEngine: SyncEngine | null,
    initialSession: any,
    port: number = 8085,
    initialFod?: FodHooks,
) {
    let engine = initialEngine;
    let session = initialSession;
    let fod = initialFod;
    let logger = session?.logger ?? console;
    let isAuthenticating = false;
    let cachedEmail = 'Not Logged In';
    let dashboardToken =
        typeof (db as any).getConfig === 'function'
            ? db.getConfig('dashboard_token', '')
            : '';
    if (!dashboardToken) {
        dashboardToken = randomBytes(32).toString('hex');
        if (typeof (db as any).setConfig === 'function') {
            db.setConfig('dashboard_token', dashboardToken);
        }
    }
    const allowedOrigins = new Set([
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
    ]);
    const validHosts = new Set([
        `127.0.0.1:${port}`,
        `localhost:${port}`,
    ]);

    const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        async fetch(req) {
            const url = new URL(req.url);
            const host = req.headers.get('host') ?? '';
            if (!validHosts.has(host)) {
                return Response.json({ ok: false, error: 'Invalid Host header' }, { status: 421 });
            }
            const origin = req.headers.get('origin');
            if (origin && !allowedOrigins.has(origin)) {
                return Response.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
            }
            if (url.pathname.startsWith('/api/') && origin) {
                const cookie = req.headers.get('cookie') ?? '';
                if (!cookie.split(';').some((part) => part.trim() === `proton_dashboard=${dashboardToken}`)) {
                    return Response.json({ ok: false, error: 'Dashboard authorization required' }, { status: 403 });
                }
            }

            // API ENDPOINTS
            if (url.pathname === '/api/status') {
                let email = 'Not Logged In';
                try {
                    if (session?.auth?.isLoggedIn()) {
                        const primaryAddress = await session.addresses.getOwnPrimaryAddress();
                        email = primaryAddress.email;
                        cachedEmail = email;

                        // Legacy full-sync: auto-start if idle
                        if (!fod?.isFuseMode && db.getSyncMode() !== 'fuse' && engine && engine.getStatus() === 'idle') {
                            engine.start();
                        }
                    } else {
                        cachedEmail = 'Not Logged In';
                    }
                } catch {}

                if (fod?.isFuseMode) {
                    const transfers = fod.getActiveTransfers ? fod.getActiveTransfers() : fod.getUploads().map((u: any) => ({ ...u, type: 'upload' }));
                    return Response.json({
                        status:          session?.auth?.isLoggedIn() ? (fod.getStatus?.() ?? 'error') : 'auth_required',
                        mode:            'fod',
                        mountPoint:      fod.mountPoint,
                        activeTransfers: transfers,
                        isPaused:        fod.getIsPaused?.() ?? false,
                        bulkDeletionCount: 0,
                        email,
                        isAuthenticating,
                    });
                }

                return Response.json({
                    status:            engine?.getStatus() ?? 'offline',
                    mode:              fod?.isFuseMode ? 'fuse' : db.getSyncMode(),
                    activeTransfers:   engine?.getActiveTransfers() ?? [],
                    localSyncRoot:     fod?.isFuseMode ? fod.mountPoint : (engine?.getLocalSyncRoot() ?? ''),
                    isPaused:          engine?.getStatus() === 'paused',
                    bulkDeletionCount: engine?.getBulkDeletionCount() ?? 0,
                    concurrencyLimit:  engine?.getConcurrencyLimit() ?? (db?.getConfig ? parseInt(db.getConfig('sync_concurrency', '2'), 10) : 2),
                    maxSpeedKbps:      engine?.getMaxSpeedKbps() ?? (db?.getConfig ? parseInt(db.getConfig('sync_max_speed_kbps', '0'), 10) : 0),
                    wifiSafeMode:      engine?.isWifiSafeMode() ?? (db?.getConfig ? db.getConfig('sync_wifi_safe_mode', '0') === '1' : false),
                    email,
                    isAuthenticating,
                });
            }

            if (req.method === 'POST' && url.pathname === '/api/set-mode') {
                try {
                    const body = await req.json() as { mode?: string };
                    const targetMode = body.mode === 'fuse' ? 'fuse' : 'full';
                    await engine?.stop();
                    await fod?.stop?.();
                    db.setSyncMode(targetMode);
                    db.log('system', 'system', 'completed', `Sync mode updated to ${targetMode.toUpperCase()}. Applying changes...`);

                    setTimeout(() => {
                        process.kill(process.pid, 'SIGTERM');
                    }, 500);

                    return Response.json({ ok: true, mode: targetMode, message: 'Sync mode updated. Daemon restarting...' });
                } catch (err: any) {
                    return Response.json({ ok: false, error: err?.message || 'Failed to set sync mode' }, { status: 500 });
                }
            }

            if (req.method === 'POST' && url.pathname === '/api/set-concurrency') {
                try {
                    const body = await req.json() as { concurrency?: number | string };
                    const limit = typeof body.concurrency === 'number' ? body.concurrency : parseInt(String(body.concurrency || ''), 10);
                    if (!isNaN(limit) && limit >= 1 && limit <= 10) {
                        if (engine) {
                            engine.setConcurrencyLimit(limit);
                        } else {
                            db.setConfig('sync_concurrency', limit.toString());
                        }
                        db.log('system', 'system', 'completed', `Network concurrency updated to ${limit}.`);
                        return Response.json({ ok: true, concurrency: limit });
                    }
                    return Response.json({ ok: false, error: 'Invalid concurrency limit (must be between 1 and 10)' }, { status: 400 });
                } catch (err: any) {
                    return Response.json({ ok: false, error: err?.message || 'Invalid request' }, { status: 400 });
                }
            }

            if (req.method === 'POST' && url.pathname === '/api/set-speed-limit') {
                try {
                    const body = await req.json() as { maxSpeedKbps?: number | string };
                    const kbps = typeof body.maxSpeedKbps === 'number' ? body.maxSpeedKbps : parseInt(String(body.maxSpeedKbps || '0'), 10);
                    if (!isNaN(kbps) && kbps >= 0 && kbps <= 10_000_000) {
                        if (engine) {
                            engine.setMaxSpeedKbps(kbps);
                        } else {
                            db.setConfig('sync_max_speed_kbps', kbps.toString());
                        }
                        db.log('system', 'system', 'completed', `Network bandwidth limit set to ${kbps === 0 ? 'Unlimited' : `${kbps} KB/s`}.`);
                        return Response.json({ ok: true, maxSpeedKbps: kbps });
                    }
                    return Response.json({ ok: false, error: 'Invalid speed limit (must be between 0 and 10,000,000 KB/s)' }, { status: 400 });
                } catch (err: any) {
                    return Response.json({ ok: false, error: err?.message || 'Invalid request' }, { status: 400 });
                }
            }

            if (req.method === 'POST' && url.pathname === '/api/set-wifi-safe-mode') {
                try {
                    const body = await req.json() as { enabled?: boolean };
                    const enabled = Boolean(body.enabled);
                    if (engine) {
                        engine.setWifiSafeMode(enabled);
                    } else {
                        db.setConfig('sync_wifi_safe_mode', enabled ? '1' : '0');
                    }
                    db.log('system', 'system', 'completed', `Wi-Fi Safe Mode ${enabled ? 'enabled' : 'disabled'}.`);
                    return Response.json({ ok: true, wifiSafeMode: enabled });
                } catch (err: any) {
                    return Response.json({ ok: false, error: err?.message || 'Invalid request' }, { status: 400 });
                }
            }

            if (req.method === 'GET' && url.pathname === '/api/fod/hydrate') {
                const nodeUid = url.searchParams.get('nodeUid');
                if (!nodeUid) return Response.json({ ok: false, error: 'Missing nodeUid' }, { status: 400 });
                try {
                    const mapping = db.getMappingByNodeUid(nodeUid);
                    if (fod && mapping) {
                        const cachePath = await fod.hydrateFile?.(nodeUid, mapping.local_path);
                        return Response.json({ ok: true, cachePath });
                    }
                    return Response.json({ ok: false, error: 'Hydrator unavailable or mapping not found' }, { status: 404 });
                } catch (err: any) {
                    return Response.json({ ok: false, error: err.message }, { status: 500 });
                }
            }

            if (req.method === 'POST' && url.pathname === '/api/login') {
                if (!session?.auth) {
                    return Response.json({ ok: false, error: 'Session not initialized' }, { status: 503 });
                }
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
                            db.log(
                                'system',
                                'system',
                                'completed',
                                `Authentication successful. Starting ${fod?.isFuseMode ? 'FUSE engine' : 'sync engine'}...`,
                            );
                            try {
                                if (session.auth.isLoggedIn()) {
                                    const primaryAddress = await session.addresses.getOwnPrimaryAddress();
                                    cachedEmail = primaryAddress.email;
                                }
                            } catch {}
                            try {
                                await startAuthenticatedSync(engine, fod);
                            } catch (startupErr: any) {
                                const message = startupErr?.message || String(startupErr);
                                db.log(
                                    'system',
                                    'system',
                                    'failed',
                                    `Authentication succeeded but sync startup failed: ${message}`,
                                );
                                logger.error('Post-authentication sync startup failed:', startupErr);
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
                    if (session?.auth?.isLoggedIn()) {
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
                const requestedLimit = parseInt(url.searchParams.get('limit') || '500', 10) || 500;
                const limit = Math.min(1000, Math.max(1, requestedLimit));
                const logs = db.getRecentLogs(limit);
                return Response.json(logs);
            }

            // ── Integrated File Browser Endpoint ────────────────────────────
            if (url.pathname === '/api/browser/list') {
                const requestedPath = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
                const allMappings = db.getAllMappings();

                // Build Breadcrumbs
                const breadcrumbs: { name: string; path: string }[] = [{ name: 'My Files', path: '' }];
                if (requestedPath) {
                    const parts = requestedPath.split('/');
                    let acc = '';
                    for (const p of parts) {
                        acc = acc ? `${acc}/${p}` : p;
                        breadcrumbs.push({ name: p, path: acc });
                    }
                }

                // Get cached files set if in FUSE mode
                const cachedSet = new Set<string>();
                const pinnedSet = new Set<string>();
                if (fod) {
                    try {
                        const cachedFiles = fod.getCached();
                        for (const c of cachedFiles) {
                            if (c.nodeUid) cachedSet.add(c.nodeUid);
                            if (c.isPinned) pinnedSet.add(c.nodeUid);
                        }
                    } catch {}
                }

                const localRoot = fod?.isFuseMode ? fod.mountPoint : (engine?.getLocalSyncRoot() ?? '');

                const directChildren = new Map<string, {
                    name: string;
                    relPath: string;
                    nodeUid: string;
                    isDir: boolean;
                    size: number;
                    mtime: number;
                    isCached: boolean;
                    isPinned: boolean;
                }>();

                const reqLen = requestedPath.length;
                for (const m of allMappings) {
                    const lp = m.local_path;
                    if (!lp) continue;

                    let isMatch = false;
                    let childRelPath = '';

                    if (reqLen === 0) {
                        isMatch = true;
                        childRelPath = lp;
                    } else if (lp.startsWith(requestedPath + '/')) {
                        isMatch = true;
                        childRelPath = lp.substring(reqLen + 1);
                    }

                    if (isMatch && childRelPath) {
                        const slashIdx = childRelPath.indexOf('/');
                        const itemName = slashIdx !== -1 ? childRelPath.substring(0, slashIdx) : childRelPath;
                        const itemRelPath = requestedPath ? `${requestedPath}/${itemName}` : itemName;
                        const isDirItem = slashIdx !== -1 ? true : (m.is_dir === 1);

                        if (!directChildren.has(itemName)) {
                            let isCached = false;
                            if (fod?.isFuseMode) {
                                isCached = isDirItem || cachedSet.has(m.node_uid);
                            } else {
                                const fullPath = path.join(localRoot, itemRelPath);
                                isCached = existsSync(fullPath);
                            }

                            const isPinned = pinnedSet.has(m.node_uid);

                            directChildren.set(itemName, {
                                name: itemName,
                                relPath: itemRelPath,
                                nodeUid: slashIdx !== -1 ? '' : m.node_uid,
                                isDir: isDirItem,
                                size: isDirItem ? 0 : m.size,
                                mtime: m.mtime || Date.now(),
                                isCached,
                                isPinned,
                            });
                        } else if (!isDirItem) {
                            const existing = directChildren.get(itemName)!;
                            existing.nodeUid = m.node_uid;
                            existing.size = m.size;
                            existing.mtime = m.mtime;
                            existing.isDir = false;
                            if (fod?.isFuseMode) {
                                existing.isCached = cachedSet.has(m.node_uid);
                            }
                            existing.isPinned = pinnedSet.has(m.node_uid);
                        }
                    }
                }

                const items = Array.from(directChildren.values()).sort((a, b) => {
                    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

                return Response.json({ currentPath: requestedPath, breadcrumbs, items });
            }

            if (req.method === 'POST' && url.pathname === '/api/browser/open-item') {
                const body = await req.json() as { relPath?: string };
                if (!body?.relPath && body?.relPath !== '') {
                    return Response.json({ ok: false, error: 'relPath required' }, { status: 400 });
                }
                const localRoot = fod?.isFuseMode ? fod.mountPoint : (engine?.getLocalSyncRoot() ?? '');
                const isFusePath = Boolean(fod?.isFuseMode);
                const fullPath = resolveContainedPath(localRoot, body.relPath, !isFusePath);
                if (!fullPath) {
                    return Response.json({ ok: false, error: 'Path escapes the configured root' }, { status: 400 });
                }
                if (isFusePath) {
                    // Never synchronously stat/realpath our own FUSE mount from
                    // the Node process that must answer that FUSE request. Use
                    // the already-loaded remote mapping tree for existence
                    // validation, then let xdg-open access the mount from a
                    // separate process.
                    const relPath = body.relPath.replace(/^\/+|\/+$/g, '');
                    const mapped = relPath === '' || db.getAllMappings().some(
                        (mapping) =>
                            mapping.local_path === relPath ||
                            mapping.local_path.startsWith(`${relPath}/`),
                    );
                    if (!mapped) {
                        return Response.json({ ok: false, error: 'File/directory not found in Proton Drive.' }, { status: 404 });
                    }
                    execFile('xdg-open', [fullPath]);
                    return Response.json({ ok: true });
                }
                if (existsSync(fullPath)) {
                    execFile('xdg-open', [fullPath]);
                    return Response.json({ ok: true });
                }
                return Response.json({ ok: false, error: 'File/directory not found on local disk.' }, { status: 404 });
            }

            if (req.method === 'POST' && url.pathname === '/api/evict') {
                const body = await req.json() as { nodeUid?: string };
                if (!body?.nodeUid) return Response.json({ ok: false, error: 'nodeUid required' }, { status: 400 });
                const ok = fod ? await fod.evictFile(body.nodeUid) : false;
                db.log(body.nodeUid, 'system', ok ? 'completed' : 'failed', ok ? 'Evicted from cache' : 'Evict failed');
                return Response.json({ ok });
            }

            if (req.method === 'POST' && url.pathname === '/api/pin') {
                const body = await req.json() as { nodeUid?: string };
                if (!body?.nodeUid) return Response.json({ ok: false, error: 'nodeUid required' }, { status: 400 });
                const ok = fod ? await fod.pinFile(body.nodeUid) : false;
                db.log(body.nodeUid, 'download', ok ? 'completed' : 'failed', ok ? 'Pinned to local cache' : 'Pin failed');
                return Response.json({ ok });
            }

            // ── FOD-specific endpoints ──────────────────────────────────────
            if (fod?.isFuseMode) {
                if (url.pathname === '/api/cached-files') {
                    const cached = fod.getCached();
                    const stats  = fod.getCacheStats();
                    return Response.json({ files: cached, stats });
                }

                if (req.method === 'POST' && url.pathname === '/api/open-folder') {
                    const mountPoint = fod.mountPoint;
                    if (mountPoint) {
                        // The mount point is created before FUSE starts. A
                        // synchronous mkdir/stat here would ask the daemon to
                        // service its own filesystem request and deadlock.
                        execFile('xdg-open', [mountPoint]);
                        return Response.json({ ok: true });
                    }
                    return Response.json({ ok: false, error: 'Mount point does not exist' }, { status: 404 });
                }

                if (req.method === 'POST' && url.pathname === '/api/logout') {
                    db.log('system', 'system', 'syncing', 'Logging out from Proton Drive');
                    await fod.stop?.();
                    await engine?.stop();
                    await session.auth.logout();
                    return Response.json({ ok: true });
                }
            }

            // ── Legacy full-sync endpoints ──────────────────────────────────
            if (req.method === 'POST') {
                if (url.pathname === '/api/pause') {
                    if (fod?.isFuseMode) await fod.pause?.();
                    else await engine?.pause();
                    return Response.json({ ok: true });
                }

                if (url.pathname === '/api/resume') {
                    if (fod?.isFuseMode) await fod.resume?.();
                    else await engine?.resume();
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
                    if (fod?.isFuseMode && fod) {
                        void fod.scanRemoteTree?.();
                    } else if (engine) {
                        engine.forceSync(); // Run async
                    }
                    return Response.json({ ok: true });
                }

                if (url.pathname === '/api/set-path') {
                    const body = await req.json() as { path?: string };
                    if (body && body.path) {
                        try {
                            const safePath = validateConfiguredPath(body.path);
                            if (fod?.isFuseMode) {
                                db.setFuseMountPoint(safePath);
                            } else if (engine) {
                                await engine.setLocalSyncRoot(safePath);
                            }
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
                    if (localPath) {
                        try { mkdirSync(localPath, { recursive: true }); } catch {}
                        execFile('xdg-open', [localPath]);
                        return Response.json({ ok: true });
                    }
                    return Response.json({ ok: false, error: 'Directory does not exist' }, { status: 404 });
                }

                if (url.pathname === '/api/daemon/stop') {
                    db.log('system', 'system', 'syncing', 'Daemon stop requested from dashboard');
                    setTimeout(() => {
                        execFile('systemctl', ['--user', 'stop', 'proton-sync.service'], () => {
                            process.kill(process.pid, 'SIGTERM');
                        });
                        process.kill(process.pid, 'SIGTERM');
                    }, 300);
                    return Response.json({ ok: true });
                }

                if (url.pathname === '/api/daemon/restart') {
                    db.log('system', 'system', 'syncing', 'Daemon restart requested from dashboard');
                    setTimeout(() => {
                        execFile('systemctl', ['--user', 'restart', 'proton-sync.service'], (err) => {
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
                                if (cachedEmail === 'Not Logged In' && session?.auth?.isLoggedIn()) {
                                    try {
                                        const primaryAddress = await session.addresses.getOwnPrimaryAddress();
                                        cachedEmail = primaryAddress.email;
                                    } catch {}
                                } else if (!session?.auth?.isLoggedIn()) {
                                    cachedEmail = 'Not Logged In';
                                }

                                let payload: string;
                                if (fod?.isFuseMode) {
                                    const transfers = fod.getActiveTransfers ? fod.getActiveTransfers() : fod.getUploads().map((u: any) => ({ ...u, type: 'upload' }));
                                    const isTransferring = transfers.length > 0;
                                    const status = fod.getStatus?.() ?? (isTransferring ? 'syncing' : 'synced');
                                    payload = JSON.stringify({
                                        status:          session?.auth?.isLoggedIn() ? status : 'auth_required',
                                        mode:            'fod',
                                        mountPoint:      fod.mountPoint,
                                        activeTransfers: transfers,
                                        isPaused:        fod.getIsPaused?.() ?? status === 'paused',
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
                                        concurrencyLimit: engine.getConcurrencyLimit(),
                                        maxSpeedKbps: engine.getMaxSpeedKbps(),
                                        wifiSafeMode: engine.isWifiSafeMode(),
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
                        if (fod?.isFuseMode) {
                            const subscribedFod = fod;
                            const subscribedEngine = engine;
                            const interval = setInterval(send, 15000);
                            const onTransfersChanged = () => send();
                            const onStatusChanged = () => send();
                            (subscribedFod as any).on?.('transfersChanged', onTransfersChanged);
                            (subscribedFod as any).on?.('statusChanged', onStatusChanged);
                            if (subscribedEngine) {
                                subscribedEngine.on('statusChanged', send);
                            }
                            cleanup = () => {
                                clearInterval(interval);
                                (subscribedFod as any).off?.('transfersChanged', onTransfersChanged);
                                (subscribedFod as any).off?.('statusChanged', onStatusChanged);
                                if (subscribedEngine) {
                                    subscribedEngine.off('statusChanged', send);
                                }
                            };
                        } else if (engine) {
                            const subscribedEngine = engine;
                            subscribedEngine.on('statusChanged', send);
                            cleanup = () => subscribedEngine.off('statusChanged', send);
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
                    headers: {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Set-Cookie': `proton_dashboard=${dashboardToken}; HttpOnly; SameSite=Strict; Path=/`,
                    },
                });
            }

            return new Response('Not Found', { status: 404 });
        },
    });

    logger.info(`Dashboard server running at http://localhost:${port}`);
    return Object.assign(server, {
        updateContext(nextEngine: SyncEngine | null, nextSession: any, nextFod?: FodHooks) {
            engine = nextEngine;
            session = nextSession;
            fod = nextFod;
            logger = session?.logger ?? console;
        },
    });
}

function resolveContainedPath(root: string, relativePath: string, inspectFilesystem = true): string | null {
    if (!root || path.isAbsolute(relativePath) || relativePath.includes('\0')) return null;
    const resolvedRoot = path.resolve(root);
    const candidate = path.resolve(resolvedRoot, relativePath);
    if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) return null;
    if (!inspectFilesystem) return candidate;
    if (!existsSync(candidate)) return candidate;
    try {
        const realRoot = realpathSync(resolvedRoot);
        const realCandidate = realpathSync(candidate);
        if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) return null;
        return realCandidate;
    } catch {
        return null;
    }
}

function validateConfiguredPath(rawPath: string): string {
    if (rawPath.includes('\0') || !path.isAbsolute(rawPath)) {
        throw new Error('Path must be an absolute filesystem path');
    }
    const resolved = path.resolve(rawPath);
    const forbidden = new Set(['/', homedir(), '/etc', '/usr', '/bin', '/sbin', '/var', '/proc', '/sys', '/dev']);
    if (forbidden.has(resolved)) {
        throw new Error('Refusing to use a system or home root as a sync path');
    }
    return resolved;
}

function formatBytes(bytes: number): string {
    if (bytes <= 0 || isNaN(bytes)) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

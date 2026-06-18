import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SyncDatabase } from './db';
import { SyncEngine } from './engine';
import { openBrowserUrl } from '../cli/openBrowserUrl';

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
                                        activeTransfers: transfers,
                                        bulkDeletionCount: bulkCount,
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

function getHtmlContent(isFodMode: boolean = false): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proton Drive - Desktop Sync</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap" rel="stylesheet">
    <style>
        :root {
            /* Common core tokens */
            --primary: #6c47ff;
            --primary-hover: #5936e0;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
            --font-body: 'Inter', sans-serif;

            /* Slate Dark Theme tokens (default) */
            --bg-body: #1e202b;
            --bg-sidebar: #141620;
            --bg-card: #252839;
            --bg-card-hover: #2c2f44;
            --border-color: #2e3248;
            --text-main: #f1f5f9;
            --text-muted: #94a3b8;
            --sidebar-active: #2e3248;
            --sidebar-hover: rgba(255, 255, 255, 0.04);
            --shadow-premium: 0 4px 20px rgba(0, 0, 0, 0.15);
            --input-bg: #141620;
            --table-header-bg: #1e202b;
            --table-row-hover: rgba(255, 255, 255, 0.02);
        }

        body.light-theme {
            /* Light theme tokens */
            --bg-body: #f8fafc;
            --bg-sidebar: #ffffff;
            --bg-card: #ffffff;
            --bg-card-hover: #f1f5f9;
            --border-color: #e2e8f0;
            --text-main: #0f172a;
            --text-muted: #64748b;
            --sidebar-active: #f1f5f9;
            --sidebar-hover: #f8fafc;
            --shadow-premium: 0 4px 20px rgba(0, 0, 0, 0.05);
            --input-bg: #f8fafc;
            --table-header-bg: #f8fafc;
            --table-row-hover: rgba(0, 0, 0, 0.01);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--font-body);
            background: var(--bg-body);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            overflow: hidden;
            width: 100vw;
            max-width: 100vw;
            transition: background 0.2s ease, color 0.2s ease;
        }

        /* Layout Structure */
        .app-layout {
            display: flex;
            width: 100%;
            height: 100vh;
            position: relative;
        }

        /* Sidebar Styling */
        .sidebar {
            width: 280px;
            background: var(--bg-sidebar);
            border-right: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            padding: 1.5rem 1rem;
            flex-shrink: 0;
            z-index: 10;
            transition: transform 0.2s ease, background 0.2s ease, border-color 0.2s ease;
        }

        .sidebar-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 2rem;
            padding-left: 0.5rem;
        }

        .proton-logo {
            width: 32px;
            height: 32px;
            flex-shrink: 0;
        }

        .brand-name {
            font-size: 1.25rem;
            font-weight: 700;
            letter-spacing: -0.5px;
            color: var(--text-main);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .sub-brand {
            font-size: 0.75rem;
            font-weight: 600;
            background: var(--primary);
            color: #ffffff;
            padding: 2px 6px;
            border-radius: 4px;
        }

        .sidebar-menu {
            display: flex;
            flex-direction: column;
            gap: 6px;
            flex-grow: 1;
        }

        .menu-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 0.75rem 1rem;
            color: var(--text-muted);
            text-decoration: none;
            font-size: 0.95rem;
            font-weight: 500;
            border-radius: 8px;
            transition: all 0.2s ease;
            cursor: pointer;
        }

        .menu-item .menu-icon {
            font-size: 20px;
            color: var(--text-muted);
            transition: color 0.2s;
        }

        .menu-item:hover {
            background: var(--sidebar-hover);
            color: var(--text-main);
        }

        .menu-item:hover .menu-icon {
            color: var(--text-main);
        }

        .menu-item.active {
            background: var(--sidebar-active);
            color: var(--primary);
            font-weight: 600;
        }

        .menu-item.active .menu-icon {
            color: var(--primary);
        }

        /* Theme Toggle Button */
        .theme-toggle-container {
            padding: 0 0.5rem;
            margin-bottom: 0.5rem;
        }
        
        .theme-toggle-btn {
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            padding: 0.6rem;
            border-radius: 8px;
            color: var(--text-main);
            font-size: 0.88rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        
        .theme-toggle-btn:hover {
            border-color: var(--primary);
            background: var(--sidebar-hover);
        }
        
        .theme-toggle-btn .material-symbols-outlined {
            font-size: 20px;
        }
        
        body.light-theme .sun-icon { display: none; }
        body:not(.light-theme) .moon-icon { display: none; }

        /* Sidebar Footer & Quota */
        .sidebar-footer {
            border-top: 1px solid var(--border-color);
            padding-top: 1.2rem;
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }

        .storage-widget {
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            padding: 1.1rem;
            border-radius: 12px;
        }

        .storage-title {
            font-size: 0.75rem;
            color: var(--text-muted);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }

        .storage-bar-bg {
            height: 8px;
            background: rgba(108, 71, 255, 0.08);
            border-radius: 9999px;
            overflow: hidden;
            margin-bottom: 8px;
        }

        .storage-bar-fill {
            height: 100%;
            background: var(--primary);
            border-radius: 9999px;
            width: 0%;
            transition: width 0.5s ease;
        }

        .storage-details {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .storage-text {
            font-size: 0.75rem;
            color: var(--text-muted);
        }

        .storage-percent {
            font-size: 0.85rem;
            font-weight: 600;
            color: var(--text-main);
        }

        .user-profile {
            display: flex;
            align-items: center;
            gap: 12px;
            background: var(--input-bg);
            padding: 0.75rem;
            border-radius: 10px;
            border: 1px solid var(--border-color);
        }

        .user-avatar {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            background: var(--primary);
            color: #ffffff;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 600;
            font-size: 1.1rem;
        }

        .user-details {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .user-email {
            font-size: 0.85rem;
            font-weight: 500;
            color: var(--text-main);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .user-status {
            font-size: 0.75rem;
            color: var(--success);
            font-weight: 500;
        }

        /* Main Content Styling */
        .main-content {
            flex-grow: 1;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: var(--bg-body);
            width: calc(100% - 280px);
            transition: background 0.2s ease;
        }

        /* Top Bar */
        .topbar {
            height: 70px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 2rem;
            background: transparent;
            z-index: 9;
            gap: 1rem;
        }

        .topbar-actions {
            flex-shrink: 0;
        }

        .section-title {
            font-size: 1.4rem;
            font-weight: 700;
            color: var(--text-main);
            letter-spacing: -0.3px;
        }

        .status-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 0.5rem 1rem;
            border-radius: 9999px;
            font-size: 0.78rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border: 1px solid var(--border-color);
            background: var(--input-bg);
            transition: all 0.2s ease;
        }

        .status-badge .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--text-muted);
        }

        /* Status colors and styling */
        .status-synced {
            color: var(--success);
            border-color: rgba(16, 185, 129, 0.2);
            background: rgba(16, 185, 129, 0.08);
        }
        .status-synced .dot {
            background: var(--success);
        }

        .status-syncing {
            color: #a78bfa;
            border-color: rgba(108, 71, 255, 0.2);
            background: rgba(108, 71, 255, 0.08);
        }
        .status-syncing .dot {
            background: var(--primary);
        }

        .status-scanning {
            color: var(--warning);
            border-color: rgba(245, 158, 11, 0.25);
            background: rgba(245, 158, 11, 0.08);
        }
        .status-scanning .dot {
            background: var(--warning);
        }

        .status-paused {
            color: var(--text-muted);
            border-color: var(--border-color);
        }
        .status-paused .dot {
            background: var(--text-muted);
        }

        .status-offline {
            color: var(--warning);
            border-color: rgba(245, 158, 11, 0.25);
            background: rgba(245, 158, 11, 0.08);
        }
        .status-offline .dot {
            background: var(--warning);
        }

        .status-error {
            color: var(--danger);
            border-color: rgba(239, 68, 68, 0.2);
            background: rgba(239, 68, 68, 0.08);
        }
        .status-error .dot {
            background: var(--danger);
        }

        .status-auth_required {
            color: var(--danger);
            border-color: rgba(239, 68, 68, 0.2);
            background: rgba(239, 68, 68, 0.08);
        }
        .status-auth_required .dot {
            background: var(--danger);
        }

        /* Content Scroll Container */
        .content-container {
            flex-grow: 1;
            padding: 2rem;
            overflow-y: auto;
        }

        /* Tab Panels */
        .tab-pane {
            display: none;
        }

        .tab-pane.active {
            display: block;
        }

        /* Card System */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
            box-shadow: var(--shadow-premium);
            transition: all 0.2s ease;
            min-width: 0;
        }

        /* Cards don't change border on hover — only interactive elements do */

        .card h2 {
            font-size: 1.15rem;
            font-weight: 700;
            color: var(--text-main);
            margin-bottom: 1.2rem;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 0.6rem;
        }

        /* Dashboard Grid Layout (Desktop 2-columns) */
        .dashboard-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 1.5rem;
        }

        /* Hero Status Card */
        .card-hero {
            display: flex;
            flex-direction: column;
            align-items: stretch;
            gap: 1.5rem;
            padding: 2rem;
        }

        .card-hero-content {
            display: flex;
            align-items: center;
            gap: 1.5rem;
        }

        .status-icon-wrapper {
            width: 76px;
            height: 76px;
            border-radius: 50%;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }

        /* Hero Status Icon Animations */
        .status-hero-icon {
            font-size: 44px;
            line-height: 1;
        }

        .text-success { color: var(--success); }
        .text-primary { color: var(--primary); }
        .text-warning { color: var(--warning); }
        .text-danger { color: var(--danger); }
        .text-muted { color: var(--text-muted); }

        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        .spin-animation {
            animation: spin 2.5s linear infinite;
        }

        @keyframes pulse {
            0% { opacity: 0.7; transform: scale(0.95); }
            100% { opacity: 1; transform: scale(1.05); }
        }
        .pulse-animation {
            animation: pulse 1.5s ease-in-out infinite alternate;
        }

        .status-info h2 {
            font-size: 1.4rem;
            font-weight: 700;
            border: none !important;
            padding: 0 !important;
            margin-bottom: 6px;
            color: var(--text-main);
        }

        .status-info p {
            font-size: 0.92rem;
            color: var(--text-muted);
            line-height: 1.4;
        }

        .card-hero-actions {
            display: flex;
            border-top: 1px solid var(--border-color);
            padding-top: 1.2rem;
            justify-content: flex-start;
        }

        #syncActions, #authActions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }

        /* Buttons styling */
        .btn {
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 0.65rem 1.2rem;
            color: var(--text-main);
            font-weight: 600;
            font-size: 0.88rem;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: all 0.2s ease;
        }

        .btn:hover {
            background: var(--sidebar-hover);
            border-color: var(--primary);
        }

        .btn:active {
            transform: scale(0.98);
        }

        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            pointer-events: none;
        }

        .btn-primary {
            background: var(--primary);
            border: none;
            color: #ffffff;
        }

        .btn-primary:hover {
            background: var(--primary-hover);
        }

        .btn-danger {
            background: rgba(239, 68, 68, 0.1);
            border-color: rgba(239, 68, 68, 0.2);
            color: #fca5a5;
        }

        body.light-theme .btn-danger {
            background: rgba(239, 68, 68, 0.05);
            color: #ef4444;
        }

        .btn-danger:hover {
            background: var(--danger);
            border-color: var(--danger);
            color: #ffffff;
        }

        /* Active Transfers Panel (inline, above log) */
        .transfers-list {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 8px;
            min-width: 0;
        }

        .transfer-item {
            background: var(--input-bg);
            padding: 0.75rem 1rem;
            border-radius: 8px;
            border: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            gap: 6px;
            min-width: 0;
            box-sizing: border-box;
            width: 100%;
        }

        .transfer-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
            min-width: 0;
        }

        .transfer-name-wrapper {
            display: flex;
            align-items: center;
            gap: 8px;
            flex: 1;
            min-width: 0;
        }

        .transfer-type-icon {
            font-size: 18px;
            flex-shrink: 0;
        }

        .upload-color { color: #a78bfa; }
        .download-color { color: var(--success); }

        .transfer-name {
            font-size: 0.88rem;
            font-weight: 500;
            color: var(--text-main);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .transfer-meta {
            font-size: 0.78rem;
            color: var(--text-muted);
            font-weight: 500;
            white-space: nowrap;
            flex-shrink: 0;
        }

        .transfer-bar-bg {
            height: 6px;
            background: rgba(108, 71, 255, 0.08);
            border-radius: 9999px;
            overflow: hidden;
        }

        .transfer-bar-fill {
            height: 100%;
            border-radius: 9999px;
            width: 0%;
            transition: width 0.3s ease;
        }

        .upload-bar {
            background-color: #8b5cf6;
        }

        .download-bar {
            background-color: var(--success);
        }

        /* Settings configuration page */
        .settings-group {
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
        }

        .setting-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 2rem;
            background: var(--input-bg);
            padding: 1.2rem;
            border-radius: 12px;
            border: 1px solid var(--border-color);
        }

        .setting-info {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .setting-title {
            font-size: 0.95rem;
            font-weight: 600;
            color: var(--text-main);
        }

        .setting-desc {
            font-size: 0.85rem;
            color: var(--text-muted);
        }

        .setting-input-group {
            display: flex;
            gap: 8px;
            width: 100%;
            max-width: 450px;
        }

        input[type="text"] {
            flex: 1;
            background: var(--bg-body);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 0.7rem 1rem;
            color: var(--text-main);
            font-family: inherit;
            font-size: 0.9rem;
            transition: all 0.2s ease;
        }

        input[type="text"]:focus {
            outline: none;
            border-color: var(--primary);
        }

        .logs-table-wrapper {
            overflow-x: auto;
            max-height: 550px;
            overflow-y: auto;
            border-radius: 12px;
            border: 1px solid var(--border-color);
            background: var(--input-bg);
        }

        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
            font-size: 0.88rem;
        }

        th {
            background: var(--table-header-bg);
            padding: 1rem 1.2rem;
            color: var(--text-muted);
            font-weight: 600;
            border-bottom: 1px solid var(--border-color);
            text-transform: uppercase;
            font-size: 0.72rem;
            letter-spacing: 0.8px;
        }

        td {
            padding: 1rem 1.2rem;
            border-bottom: 1px solid var(--border-color);
            color: var(--text-main);
        }

        tr:last-child td {
            border-bottom: none;
        }

        tr:hover td {
            background: var(--table-row-hover);
        }

        .log-direction {
            font-weight: 600;
            font-size: 0.75rem;
            text-transform: uppercase;
        }

        .log-status {
            font-weight: 600;
            font-size: 0.75rem;
            padding: 3px 8px;
            border-radius: 6px;
            display: inline-block;
        }

        .status-completed { color: var(--success); background: rgba(16, 185, 129, 0.1); }
        .status-syncing { color: var(--primary); background: rgba(108, 71, 255, 0.1); }
        .status-failed { color: var(--danger); background: rgba(239, 68, 68, 0.1); }

        .time-col {
            color: var(--text-muted);
            font-size: 0.8rem;
            white-space: nowrap;
        }

        .file-path-text {
            font-weight: 500;
            color: var(--text-main);
            word-break: break-all;
        }

        .log-message {
            display: block;
            font-size: 0.78rem;
            color: var(--text-muted);
            margin-top: 2px;
        }

        /* Search & Filter bar for logs & cache */
        .card-header-flex {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 1rem;
            margin-bottom: 1.2rem;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 0.6rem;
        }

        .filter-search-container {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
        }

        .search-box {
            position: relative;
            display: flex;
            align-items: center;
            background: var(--bg-body);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 0 0.75rem;
            width: 220px;
            transition: all 0.2s;
        }

        .search-box:focus-within {
            border-color: var(--primary);
        }

        .search-icon {
            font-size: 18px;
            color: var(--text-muted);
            margin-right: 8px;
            flex-shrink: 0;
        }

        .search-box input {
            background: none;
            border: none;
            outline: none;
            padding: 0.5rem 0;
            color: var(--text-main);
            font-size: 0.82rem;
            width: 100%;
        }

        .filter-pills {
            display: flex;
            gap: 6px;
        }

        .filter-pill {
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: 20px;
            padding: 0.35rem 0.85rem;
            color: var(--text-muted);
            font-size: 0.78rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }

        .filter-pill:hover {
            background: var(--sidebar-hover);
            color: var(--text-main);
            border-color: var(--primary);
        }

        .filter-pill.active {
            background: var(--primary);
            color: #ffffff;
            border-color: transparent;
        }

        /* Empty state styling */
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            gap: 8px;
            color: var(--text-muted);
            padding: 2.5rem 1rem;
        }

        .empty-icon {
            font-size: 40px;
            color: var(--border-color);
            margin-bottom: 6px;
        }

        .empty-title {
            font-size: 0.95rem;
            font-weight: 600;
            color: var(--text-main);
        }

        .empty-desc {
            font-size: 0.82rem;
            max-width: 320px;
            line-height: 1.4;
        }

        /* Hamburger menu button */
        .menu-toggle {
            display: none;
            background: none;
            border: none;
            color: var(--text-main);
            cursor: pointer;
            padding: 8px;
            align-items: center;
            justify-content: center;
            border-radius: 6px;
            transition: background-color 0.2s;
        }

        .menu-toggle:hover {
            background: var(--sidebar-hover);
        }

        .menu-toggle .material-symbols-outlined {
            font-size: 24px;
        }

        /* Mobile sidebar drawer overlay */
        .sidebar-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(0, 0, 0, 0.4);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            z-index: 90;
        }

        .sidebar-overlay.active {
            display: block;
        }

        /* Custom scrollbar styling */
        * {
            scrollbar-width: thin;
            scrollbar-color: var(--border-color) var(--bg-sidebar);
        }

        /* Bulk Deletion Warning Card */
        .card-warning {
            background: rgba(245, 158, 11, 0.08) !important;
            border-color: var(--warning) !important;
            display: flex;
            flex-direction: column;
            gap: 1.2rem;
            padding: 1.5rem;
        }

        .warning-banner-content {
            display: flex;
            align-items: flex-start;
            gap: 1.2rem;
        }

        .warning-banner-icon {
            font-size: 32px;
            color: var(--warning);
            flex-shrink: 0;
        }

        .warning-text-wrapper h3 {
            font-size: 1.15rem;
            font-weight: 700;
            color: var(--text-main);
            margin-bottom: 6px;
            border-bottom: none !important;
            padding-bottom: 0 !important;
        }

        .warning-text-wrapper p {
            font-size: 0.92rem;
            color: var(--text-muted);
            line-height: 1.4;
        }

        .warning-actions {
            display: flex;
            gap: 12px;
        }

        .btn-success {
            background: var(--success);
            border: none;
            color: #ffffff;
        }

        .btn-success:hover {
            background: #059669;
        }

        /* ── RESPONSIVE MEDIA QUERIES ────────────────────────────────────── */

        @media (max-width: 1100px) {
            .card-hero {
                padding: 1.5rem;
            }
        }

        @media (max-width: 1024px) {
            .app-layout {
                width: 100vw;
                max-width: 100vw;
                min-width: 0;
                overflow: hidden;
            }

            .sidebar {
                position: fixed;
                top: 0;
                left: 0;
                height: 100vh;
                transform: translateX(-100%);
                z-index: 100;
                box-shadow: 4px 0 24px rgba(0, 0, 0, 0.2);
                visibility: hidden;
            }
            
            .sidebar.open {
                transform: translateX(0);
                visibility: visible;
            }

            .main-content {
                width: 100vw;
                max-width: 100vw;
                min-width: 0;
            }

            .menu-toggle {
                display: flex;
            }

            .topbar {
                padding: 0 1.5rem;
            }

            .content-container {
                padding: 1.5rem;
            }
        }

        @media (max-width: 850px) {
            .topbar {
                height: 56px;
                padding: 0 1.25rem;
            }
            .section-title {
                font-size: 1.2rem;
            }
            .status-badge {
                padding: 0.4rem 0.75rem;
                font-size: 0.72rem;
            }
            .content-container {
                padding: 1.25rem;
            }
            .card {
                padding: 1.25rem;
                margin-bottom: 1rem;
                border-radius: 12px;
            }
            .card-hero {
                padding: 1.2rem 1.25rem;
                gap: 1.2rem;
            }
            .status-icon-wrapper {
                width: 54px;
                height: 54px;
            }
            .status-hero-icon {
                font-size: 32px;
            }
            .status-info h2 {
                font-size: 1.15rem;
                margin-bottom: 4px;
            }
            .status-info p {
                font-size: 0.85rem;
            }
            .btn {
                padding: 0.5rem 1rem;
                font-size: 0.82rem;
                border-radius: 6px;
            }
            .card-header-flex {
                gap: 8px;
            }
            .card-header-flex h2 {
                font-size: 1.05rem;
            }
            .logs-table-wrapper th, .logs-table-wrapper td {
                padding: 0.6rem 0.8rem;
                font-size: 0.82rem;
            }
        }

        @media (min-width: 1200px) {
            .dashboard-main-col {
                display: flex;
                flex-direction: column;
            }
        }

        @media (max-width: 768px) {
            .setting-row {
                flex-direction: column;
                align-items: flex-start;
                gap: 1.2rem;
                padding: 1rem;
            }

            .setting-input-group {
                max-width: 100%;
            }

            .card-header-flex {
                flex-direction: column;
                align-items: flex-start;
                gap: 12px;
            }

            .filter-search-container {
                width: 100%;
                flex-direction: column;
                align-items: flex-start;
                min-width: 0;
            }

            .search-box {
                width: 100%;
            }

            .filter-pills {
                width: 100%;
                overflow-x: auto;
                padding-bottom: 4px;
                display: flex;
                min-width: 0;
                flex-wrap: nowrap;
            }

            .filter-pill {
                white-space: nowrap;
                flex-shrink: 0;
            }
        }

        @media (max-width: 480px) {
            .main-content {
                width: 100vw;
                max-width: 100vw;
                min-width: 0;
                overflow-x: hidden;
            }

            .content-container {
                padding: 0.75rem;
                width: 100%;
                min-width: 0;
                max-width: 100%;
                overflow-x: hidden;
                box-sizing: border-box;
            }

            .card {
                padding: 0.85rem;
                border-radius: 12px;
                margin-bottom: 0.75rem;
                width: 100%;
                box-sizing: border-box;
                min-width: 0;
            }

            .dashboard-grid {
                grid-template-columns: 1fr !important;
                gap: 0.75rem;
                min-width: 0;
            }

            .dashboard-main-col,
            .dashboard-side-col {
                min-width: 0;
                width: 100%;
            }

            .topbar {
                height: 56px;
                padding: 0 1rem;
                justify-content: space-between;
            }

            .section-title {
                font-size: 1.1rem;
            }

            .status-badge {
                padding: 0.35rem 0.65rem;
                font-size: 0.68rem;
            }

            .card-hero {
                padding: 1.5rem 1rem;
                gap: 1.5rem;
                align-items: center;
                text-align: center;
            }

            .card-hero-content {
                flex-direction: column;
                align-items: center;
                gap: 1rem;
            }

            .status-icon-wrapper {
                width: 72px;
                height: 72px;
            }

            .status-hero-icon {
                font-size: 40px;
            }

            .status-info h2 {
                font-size: 1.2rem;
            }

            .status-info p {
                font-size: 0.85rem;
            }

            .card-hero-actions {
                flex-direction: column;
                align-items: stretch;
                width: 100%;
                gap: 8px;
                border-top: 1px solid var(--border-color);
                padding-top: 1.2rem;
            }

            .card-hero-actions .btn {
                width: 100%;
            }

            #syncActions, #authActions {
                flex-direction: column;
                width: 100%;
                gap: 8px;
            }

            /* Stack log table cells to form a mobile list item card */
            .logs-table-wrapper {
                border: none;
                background: transparent;
                border-radius: 0;
                overflow: visible;
                max-height: none;
            }
            .logs-table-wrapper table, 
            .logs-table-wrapper tbody {
                display: block;
                width: 100%;
            }
            .logs-table-wrapper thead {
                display: none;
            }
            .logs-table-wrapper tr {
                display: grid;
                grid-template-areas:
                    "direction status time"
                    "path path path";
                grid-template-columns: auto auto 1fr;
                row-gap: 8px;
                column-gap: 10px;
                padding: 1rem 0.75rem;
                border-bottom: 1px solid var(--border-color);
                align-items: center;
                background: var(--bg-card);
                margin-bottom: 8px;
                border: 1px solid var(--border-color);
                border-radius: 8px;
                width: 100%;
                box-sizing: border-box;
            }
            .logs-table-wrapper td {
                padding: 0;
                border: none;
                background: none;
            }
            .logs-table-wrapper .time-col {
                grid-area: time;
                text-align: right;
                font-size: 0.72rem;
                color: var(--text-muted);
            }
            .logs-table-wrapper .log-direction {
                grid-area: direction;
                font-size: 0.78rem;
                font-weight: 600;
                margin-bottom: 0;
            }
            .logs-table-wrapper td:nth-child(3) {
                grid-area: status;
                justify-self: start;
            }
            .logs-table-wrapper td:nth-child(4) {
                grid-area: path;
                width: 100%;
                min-width: 0;
                word-break: break-all;
            }

            /* Stack cache table cells to form a mobile list item card */
            #tab-cache table, 
            #tab-cache tbody {
                display: block;
                width: 100%;
            }
            #tab-cache thead {
                display: none;
            }
            #tab-cache tr {
                display: grid;
                grid-template-areas:
                    "filename filename"
                    "size status"
                    "actions actions";
                grid-template-columns: 1fr auto;
                row-gap: 10px;
                column-gap: 12px;
                padding: 1rem 0.75rem;
                border-bottom: 1px solid var(--border-color);
                align-items: center;
                background: var(--bg-card);
                margin-bottom: 8px;
                border: 1px solid var(--border-color);
                border-radius: 8px;
                width: 100%;
                box-sizing: border-box;
            }
            #tab-cache td {
                padding: 0;
                border: none;
                background: none;
            }
            #tab-cache td:nth-child(1) {
                grid-area: filename;
                font-weight: 600;
                width: 100%;
                min-width: 0;
                word-break: break-all;
            }
            #tab-cache td:nth-child(2) {
                grid-area: size;
                font-size: 0.78rem;
                color: var(--text-muted);
            }
            #tab-cache td:nth-child(3) {
                grid-area: status;
                justify-self: end;
            }
            #tab-cache td:nth-child(4) {
                grid-area: actions;
                display: flex;
                gap: 8px;
                width: 100%;
                margin-top: 4px;
            }
            #tab-cache td:nth-child(4) .btn {
                flex: 1;
                padding: 0.45rem;
                font-size: 0.78rem;
                width: 100%;
            }

            /* Stack configuration input fields on mobile */
            .setting-input-group {
                flex-direction: column;
                align-items: stretch;
                width: 100%;
                gap: 8px;
            }
            .setting-input-group input {
                width: 100%;
            }
            .setting-input-group .btn {
                width: 100%;
            }

            .warning-banner-content {
                gap: 0.75rem;
                flex-direction: column;
                align-items: center;
                text-align: center;
            }

            .warning-banner-icon {
                font-size: 28px;
            }

            .warning-text-wrapper h3 {
                font-size: 1rem;
            }

            .warning-text-wrapper p {
                font-size: 0.82rem;
            }

            .warning-actions {
                flex-direction: column;
                width: 100%;
                gap: 8px;
            }

            .warning-actions .btn {
                width: 100%;
            }

            .card-header-flex {
                flex-direction: column;
                align-items: stretch;
                gap: 12px;
                width: 100%;
                min-width: 0;
            }

            .filter-search-container {
                width: 100%;
                flex-direction: column;
                align-items: stretch;
                min-width: 0;
                max-width: 100%;
                gap: 8px;
            }

            .filter-pills {
                width: 100%;
                overflow-x: auto;
                padding-bottom: 6px;
                display: flex;
                min-width: 0;
                max-width: 100%;
                flex-wrap: nowrap;
                -webkit-overflow-scrolling: touch;
            }

            .filter-pills::-webkit-scrollbar {
                height: 4px;
            }
            .filter-pills::-webkit-scrollbar-thumb {
                background: var(--border-color);
                border-radius: 4px;
            }

            .filter-pill {
                white-space: nowrap;
                flex-shrink: 0;
            }
        }

        /* Full-screen Login View */
        .login-view {
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            width: 100vw;
            height: 100vh;
            background: var(--bg-body);
            color: var(--text-main);
            padding: 2rem;
            text-align: center;
            box-sizing: border-box;
        }

        .login-card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 3rem 2.5rem;
            max-width: 480px;
            width: 100%;
            box-shadow: var(--shadow-premium);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 1.5rem;
            box-sizing: border-box;
        }

        .login-logo {
            width: 72px;
            height: 72px;
            margin-bottom: 0.5rem;
        }

        .login-title {
            font-size: 1.6rem;
            font-weight: 700;
            letter-spacing: -0.5px;
            margin: 0;
            color: var(--text-main);
        }

        .login-desc {
            font-size: 0.92rem;
            color: var(--text-muted);
            line-height: 1.5;
            margin: 0 0 1rem 0;
        }

        .login-btn {
            width: 100%;
            padding: 0.8rem 1.5rem;
            font-size: 0.95rem;
            font-weight: 600;
            border-radius: 8px;
        }
    </style>
</head>
<body>
    <div class="app-layout">
        <!-- Left Sidebar -->
        <aside class="sidebar">
            <div class="sidebar-header">
                <!-- Official Proton Drive Folder Icon SVG -->
                <svg class="proton-logo" viewBox="0 20 106 95" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <!-- Background folder flap -->
                    <path fill-rule="evenodd" clip-rule="evenodd" d="M49.9553 33.7554H95.0391C101.095 33.7554 106 38.6208 106 44.6278V101.117C106 107.124 101.095 111.989 95.0391 111.989H83.4637V55.256C83.4637 50.568 79.6201 46.7666 74.8827 46.7999L33.3631 47.0326C31.5754 47.0437 29.8324 46.4926 28.3687 45.4619L19.1173 38.9532C17.676 37.9336 15.9441 37.3906 14.1788 37.3906H0V35.8722C0 29.8654 4.90503 25 10.9609 25H31.5307C33.6089 25 35.6313 25.6539 37.2961 26.873L44.1788 31.8824C45.8547 33.1015 47.8771 33.7554 49.9553 33.7554Z" fill="#a78bfa"/>
                    <!-- Foreground folder body -->
                    <path d="M74.8827 46.7999L33.3631 47.0326C31.5754 47.0437 29.8324 46.4926 28.3687 45.4619L19.1173 38.9532C17.676 37.9336 15.9441 37.3906 14.1788 37.3906H0V101.128C0 107.135 4.90503 112 10.9609 112H83.4637V55.256C83.4637 50.568 79.6201 46.7666 74.8827 46.7999Z" fill="#6d4aff"/>
                </svg>
                <span class="brand-name">Proton Drive<span class="sub-brand" id="modeLabel">Sync</span></span>
            </div>

            <nav class="sidebar-menu">
                <div class="menu-item active" data-tab="dashboard" onclick="showTab('dashboard')">
                    <span class="material-symbols-outlined menu-icon">dashboard</span>
                    Dashboard
                </div>
                <div class="menu-item" data-tab="settings" onclick="showTab('settings')">
                    <span class="material-symbols-outlined menu-icon">settings</span>
                    Settings
                </div>
                <div class="menu-item" id="cacheMenuItem" data-tab="cache" onclick="showTab('cache')" style="display:none;">
                    <span class="material-symbols-outlined menu-icon">database</span>
                    Local Cache
                </div>
            </nav>

            <div class="sidebar-footer">
                <!-- Theme Toggle Button -->
                <div class="theme-toggle-container">
                    <button class="theme-toggle-btn" onclick="toggleTheme()" aria-label="Toggle light/dark theme">
                        <span class="material-symbols-outlined sun-icon">light_mode</span>
                        <span class="material-symbols-outlined moon-icon">dark_mode</span>
                        <span id="themeToggleText">Light Mode</span>
                    </button>
                </div>

                <!-- Quota status widget -->
                <div class="storage-widget">
                    <div class="storage-title">Storage Quota</div>
                    <div class="storage-bar-bg">
                        <div id="quotaBar" class="storage-bar-fill"></div>
                    </div>
                    <div class="storage-details">
                        <span class="storage-text" id="quotaText">0 B of 0 B</span>
                        <span class="storage-percent" id="quotaPercent">0%</span>
                    </div>
                </div>

                <!-- User profile badge -->
                <div class="user-profile">
                    <div class="user-avatar" id="avatarLetter">?</div>
                    <div class="user-details">
                        <span id="userEmail" class="user-email">Not Logged In</span>
                        <span id="userStatus" class="user-status">Connected</span>
                    </div>
                </div>
            </div>
        </aside>

        <!-- Right Main View -->
        <main class="main-content">
            <!-- Topbar showing title & global status badge -->
            <header class="topbar">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <button class="menu-toggle" id="sidebarToggle" onclick="toggleSidebar()">
                        <span class="material-symbols-outlined">menu</span>
                    </button>
                    <h1 class="section-title" id="pageTitle">Sync Dashboard</h1>
                </div>
                <div class="topbar-actions">
                    <div id="statusBadge" class="status-badge status-synced">
                        <span class="dot"></span>
                        <span id="statusText">Synced</span>
                    </div>
                </div>
            </header>

            <!-- Scrollable content area -->
            <div class="content-container">
                <!-- Tab Pane: Dashboard -->
                <div id="tab-dashboard" class="tab-pane active">
                    <!-- Bulk Deletion Warning Banner -->
                    <div id="bulkDeletionWarningCard" class="card card-warning" style="display: none;">
                        <div class="warning-banner-content">
                            <span class="material-symbols-outlined warning-banner-icon">warning</span>
                            <div class="warning-text-wrapper">
                                <h3>Bulk Deletion Safeguard Triggered</h3>
                                <p id="bulkDeletionWarningDesc">The sync engine detected that local files were deleted. Synchronization has been paused to protect your remote files in the cloud from being deleted.</p>
                            </div>
                        </div>
                        <div class="warning-actions">
                            <button class="btn btn-danger" onclick="confirmBulkDeletions()">Delete from Cloud</button>
                            <button class="btn btn-success" onclick="restoreBulkDeletions()">Restore Files from Cloud</button>
                        </div>
                    </div>

                    <!-- FOD Mode Hero Card (hidden by default, shown when mode=fod) -->
                    <div id="fodHeroCard" class="card" style="display:none;">
                        <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
                            <div style="width:52px;height:52px;border-radius:50%;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                                <span class="material-symbols-outlined text-success" style="font-size:24px;">cloud</span>
                            </div>
                            <div>
                                <h2 style="font-size:1.1rem;font-weight:700;color:var(--text-main);margin:0 0 4px;border:none;padding:0;">File On Demand — FUSE Mode</h2>
                                <p style="font-size:0.88rem;color:var(--text-muted);margin:0;">Mount point: <code id="mountPointDisplay" style="color:var(--primary);font-size:0.85rem;font-weight:600;">~/P-Drive</code></p>
                            </div>
                            <div style="margin-left:auto;display:flex;gap:8px;">
                                <button class="btn" onclick="openFolder()">Open Mount Folder</button>
                            </div>
                        </div>
                    </div>

                    <!-- Dashboard Grid Layout -->
                    <div class="dashboard-grid">
                        <div class="dashboard-main-col">
                            <!-- Hero Synced Status Card -->
                            <div class="card card-hero">
                                <div class="card-hero-content">
                                    <div class="status-icon-wrapper" id="syncStatusIcon">
                                        <!-- Large Material Icon inserted dynamically via JS -->
                                    </div>
                                    <div class="status-info">
                                        <h2 id="syncStateTitle">Your files are up to date</h2>
                                        <p id="syncStateDesc">Proton Drive is actively monitoring your sync folder.</p>
                                    </div>
                                </div>
                                <div class="card-hero-actions">
                                    <div id="syncActions">
                                        <button id="btnPause" class="btn btn-primary" onclick="togglePause()">Pause Sync</button>
                                        <button id="syncNowBtn" class="btn" onclick="forceSync()">Sync Now</button>
                                        <button class="btn" onclick="openFolder()">Open Folder</button>
                                    </div>
                                    <div id="authActions" style="display: none;">
                                        <button id="btnLogin" class="btn btn-primary btn-login-action" onclick="login()">Login to Proton Drive</button>
                                    </div>
                                </div>
                            </div>

                            <!-- Active Transfers Card (shown inline when transfers are active) -->
                            <div id="transfersCard" class="card" style="display: none;">
                                <div class="card-header-flex" style="margin-bottom:0.8rem;">
                                    <h2>Active Transfers</h2>
                                    <span id="transfersCount" style="font-size:0.8rem;color:var(--text-muted);font-weight:500;"></span>
                                </div>
                                <ul id="transfersList" class="transfers-list">
                                    <!-- Populated dynamically via JS -->
                                </ul>
                            </div>

                            <!-- Activity History Card -->
                            <div class="card">
                                <div class="card-header-flex">
                                    <h2>Recent Activity Log</h2>
                                    <div class="filter-search-container">
                                        <div class="search-box">
                                            <span class="material-symbols-outlined search-icon">search</span>
                                            <input type="text" id="logSearchInput" placeholder="Search logs..." oninput="filterLogs()">
                                        </div>
                                        <div class="filter-pills" id="logFilterPills">
                                            <button class="filter-pill active" onclick="setLogFilter('all')">All</button>
                                            <button class="filter-pill" onclick="setLogFilter('uploads')">Uploads</button>
                                            <button class="filter-pill" onclick="setLogFilter('downloads')">Downloads</button>
                                            <button class="filter-pill" onclick="setLogFilter('system')">System</button>
                                            <button class="filter-pill" onclick="setLogFilter('failed')">Errors</button>
                                        </div>
                                    </div>
                                </div>
                                <div class="logs-table-wrapper">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>Time</th>
                                                <th>Operation</th>
                                                <th>Status</th>
                                                <th>File / Details</th>
                                            </tr>
                                        </thead>
                                        <tbody id="logsBody">
                                            <!-- Populated dynamically via JS -->
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Tab Pane: Cache -->
                <div id="tab-cache" class="tab-pane">
                    <div class="card" style="margin-bottom:1rem;">
                        <div class="card-header-flex">
                            <div>
                                <h2 style="margin-bottom:4px; border:none; padding:0;">Local Cache</h2>
                                <p style="font-size:0.85rem;color:var(--text-muted);margin:0;">Files downloaded to your device. Click Evict to free space; click Pin to pre-download.</p>
                            </div>
                            <div style="text-align:right; display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
                                <div id="cacheSizeDisplay" style="font-size:0.85rem;color:var(--text-muted);">Loading…</div>
                                <button class="btn btn-danger" style="font-size:0.8rem;padding:0.4rem 0.8rem;" onclick="evictAll()">Free All Space</button>
                            </div>
                        </div>

                        <!-- Cache Filters -->
                        <div class="filter-search-container" style="margin-bottom: 1.2rem;">
                            <div class="search-box">
                                <span class="material-symbols-outlined search-icon">search</span>
                                <input type="text" id="cacheSearchInput" placeholder="Search cache..." oninput="filterCache()">
                            </div>
                            <div class="filter-pills" id="cacheFilterPills">
                                <button class="filter-pill active" onclick="setCacheFilter('all')">All</button>
                                <button class="filter-pill" onclick="setCacheFilter('local')">Local Only</button>
                                <button class="filter-pill" onclick="setCacheFilter('stub')">Stubs Only</button>
                            </div>
                        </div>

                        <div class="logs-table-wrapper">
                            <table>
                                <thead>
                                    <tr>
                                        <th>File</th>
                                        <th>Size</th>
                                        <th>Status</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody id="cacheBody">
                                    <tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem;">Loading…</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Tab Pane: Settings -->
                <div id="tab-settings" class="tab-pane">
                    <div class="card">
                        <h2>Configuration Settings</h2>
                        <div class="settings-group">
                            <div class="setting-row">
                                <div class="setting-info">
                                    <span class="setting-title">Sync Folder Path</span>
                                    <span class="setting-desc">Files inside this directory will sync with your Proton Cloud root.</span>
                                </div>
                                <div class="setting-input-group">
                                    <input type="text" id="syncPath" value="">
                                    <button class="btn btn-primary" onclick="savePath()">Save Path</button>
                                </div>
                            </div>
                            
                            <div class="setting-row">
                                <div class="setting-info">
                                    <span class="setting-title">Session Connection</span>
                                    <span class="setting-desc">Disconnect this daemon from your Proton account. All local files will remain intact.</span>
                                </div>
                                <button class="btn btn-danger" onclick="logout()">Logout Account</button>
                            </div>

                            <div class="setting-row">
                                <div class="setting-info">
                                    <span class="setting-title">Daemon Control</span>
                                    <span class="setting-desc">Stop or restart the background sync process. Stopping will disconnect this dashboard until the daemon is restarted manually.</span>
                                </div>
                                <div style="display:flex;gap:8px;flex-shrink:0;">
                                    <button class="btn" onclick="restartDaemon()">
                                        <span class="material-symbols-outlined" style="font-size:16px;">refresh</span>
                                        Restart
                                    </button>
                                    <button class="btn btn-danger" onclick="stopDaemon()">
                                        <span class="material-symbols-outlined" style="font-size:16px;">stop_circle</span>
                                        Stop Daemon
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <!-- Dedicated login screen for unauthenticated users -->
    <div id="loginView" class="login-view">
        <div class="login-card">
            <!-- Official Proton Drive Folder Icon SVG -->
            <svg class="login-logo" viewBox="0 20 106 95" fill="none" xmlns="http://www.w3.org/2000/svg">
                <!-- Background folder flap -->
                <path fill-rule="evenodd" clip-rule="evenodd" d="M49.9553 33.7554H95.0391C101.095 33.7554 106 38.6208 106 44.6278V101.117C106 107.124 101.095 111.989 95.0391 111.989H83.4637V55.256C83.4637 50.568 79.6201 46.7666 74.8827 46.7999L33.3631 47.0326C31.5754 47.0437 29.8324 46.4926 28.3687 45.4619L19.1173 38.9532C17.676 37.9336 15.9441 37.3906 14.1788 37.3906H0V35.8722C0 29.8654 4.90503 25 10.9609 25H31.5307C33.6089 25 35.6313 25.6539 37.2961 26.873L44.1788 31.8824C45.8547 33.1015 47.8771 33.7554 49.9553 33.7554Z" fill="#a78bfa"/>
                <!-- Foreground folder body -->
                <path d="M74.8827 46.7999L33.3631 47.0326C31.5754 47.0437 29.8324 46.4926 28.3687 45.4619L19.1173 38.9532C17.676 37.9336 15.9441 37.3906 14.1788 37.3906H0V101.128C0 107.135 4.90503 112 10.9609 112H83.4637V55.256C83.4637 50.568 79.6201 46.7666 74.8827 46.7999Z" fill="#6d4aff"/>
            </svg>
            <h1 class="login-title">Welcome to Proton Drive</h1>
            <p class="login-desc">Sign in with your Proton account to configure local desktop synchronization and access your secure cloud files.</p>
            <button class="btn btn-primary login-btn btn-login-action" onclick="login()">Login to Proton Drive</button>
        </div>
    </div>

    <script>
        let isPaused = false;
        let currentTab = 'dashboard';
        const IS_FOD = false; // Replaced server-side with isFodMode

        // Injected by server
        const FOD_MODE = ${isFodMode ? 'true' : 'false'};

        // Local UI State for Search/Filters
        let logSearchQuery = '';
        let logFilterCategory = 'all';
        let cachedLogs = [];
        let lastLogsJson = '';

        let cacheSearchQuery = '';
        let cacheFilterStatus = 'all';
        let cachedCacheFiles = [];
        let lastCacheJson = '';

        function init() {
            // Load theme from localStorage
            loadTheme();

            // Create sidebar overlay for mobile
            const overlay = document.createElement('div');
            overlay.className = 'sidebar-overlay';
            overlay.onclick = toggleSidebar;
            document.body.appendChild(overlay);

            if (FOD_MODE) {
                document.getElementById('modeLabel').innerText = 'FOD';
                document.getElementById('cacheMenuItem').style.display = 'flex';
                document.getElementById('fodHeroCard').style.display = 'block';
                // FOD: hide full-sync only controls
                const pauseBtn = document.getElementById('btnPause');
                if (pauseBtn) pauseBtn.style.display = 'none';
                const syncNowBtn = document.getElementById('syncNowBtn');
                if (syncNowBtn) syncNowBtn.style.display = 'none';
                fetchCachedFiles();
                setInterval(fetchCachedFiles, 5000);
            }
        }

        // Theme management
        function toggleTheme() {
            const body = document.body;
            body.classList.toggle('light-theme');
            const isLight = body.classList.contains('light-theme');
            localStorage.setItem('theme', isLight ? 'light' : 'dark');
            updateThemeButtonText();
        }

        function updateThemeButtonText() {
            const isLight = document.body.classList.contains('light-theme');
            document.getElementById('themeToggleText').innerText = isLight ? 'Dark Mode' : 'Light Mode';
        }

        function loadTheme() {
            const savedTheme = localStorage.getItem('theme');
            if (savedTheme === 'light') {
                document.body.classList.add('light-theme');
            } else {
                document.body.classList.remove('light-theme');
            }
            updateThemeButtonText();
        }

        // Get Material Icon for Sync Status
        function getMascotIcon(status) {
            if (status === 'synced' || status === 'idle') {
                return \`<span class="material-symbols-outlined status-hero-icon text-success">cloud_done</span>\`;
            } else if (status === 'syncing') {
                return \`<span class="material-symbols-outlined status-hero-icon text-primary spin-animation">sync</span>\`;
            } else if (status === 'scanning') {
                return \`<span class="material-symbols-outlined status-hero-icon text-warning pulse-animation">search</span>\`;
            } else if (status === 'paused') {
                return \`<span class="material-symbols-outlined status-hero-icon text-muted">pause_circle</span>\`;
            } else if (status === 'bulk_deletion_warning') {
                return \`<span class="material-symbols-outlined status-hero-icon text-warning pulse-animation">warning</span>\`;
            } else {
                return \`<span class="material-symbols-outlined status-hero-icon text-danger">cloud_off</span>\`;
            }
        }

        function toggleSidebar() {
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.querySelector('.sidebar-overlay');
            sidebar.classList.toggle('open');
            overlay.classList.toggle('active');
        }

        function showTab(tabId) {
            document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
            const pane = document.getElementById('tab-' + tabId);
            if (pane) pane.classList.add('active');

            const item = document.querySelector(\`.menu-item[data-tab="\${tabId}"]\`);
            if (item) item.classList.add('active');

            currentTab = tabId;
            const titles = {
                'dashboard': 'Sync Dashboard',
                'history':   'Activity History',
                'settings':  'Configuration Settings',
                'cache':     'Local Cache',
            };
            document.getElementById('pageTitle').innerText = titles[tabId] || tabId;

            // Close mobile sidebar drawer if open
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.querySelector('.sidebar-overlay');
            if (sidebar.classList.contains('open')) {
                sidebar.classList.remove('open');
                overlay.classList.remove('active');
            }
        }

        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        }

        // Logs filter & rendering
        function setLogFilter(category) {
            logFilterCategory = category;
            document.querySelectorAll('#logFilterPills .filter-pill').forEach(btn => {
                const text = btn.innerText.trim().toLowerCase();
                if (text === category.toLowerCase() || (category === 'failed' && text === 'errors')) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
            renderLogs();
        }

        function filterLogs() {
            logSearchQuery = document.getElementById('logSearchInput').value.trim().toLowerCase();
            renderLogs();
        }

        function renderLogs() {
            const body = document.getElementById('logsBody');
            if (!cachedLogs || cachedLogs.length === 0) {
                body.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;"><div class="empty-state"><span class="material-symbols-outlined empty-icon">cloud_off</span><span class="empty-title">No recent sync activity</span><span class="empty-desc">Proton Drive is scanning your files. Activity logs will appear here as changes are detected.</span></div></td></tr>';
                return;
            }

            const filtered = cachedLogs.filter(l => {
                const path = l.file_path || '';
                const msg = l.message || '';
                const matchesSearch = !logSearchQuery || path.toLowerCase().includes(logSearchQuery) || msg.toLowerCase().includes(logSearchQuery);
                
                let matchesCategory = true;
                const dir = l.direction.toLowerCase();
                if (logFilterCategory === 'uploads') {
                    matchesCategory = dir.startsWith('up') || dir === 'upload';
                } else if (logFilterCategory === 'downloads') {
                    matchesCategory = dir.startsWith('down') || dir === 'download';
                } else if (logFilterCategory === 'system') {
                    matchesCategory = dir === 'system';
                } else if (logFilterCategory === 'failed') {
                    matchesCategory = l.status === 'failed';
                }

                return matchesSearch && matchesCategory;
            });

            if (filtered.length === 0) {
                body.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;"><div class="empty-state"><span class="material-symbols-outlined empty-icon">search_off</span><span class="empty-title">No matches found</span><span class="empty-desc">Try adjusting your search query or filters.</span></div></td></tr>';
                return;
            }

            body.innerHTML = filtered.map(l => {
                const time       = new Date(l.timestamp).toLocaleString();
                const action     = l.direction.replace('_', ' ');
                const statusClass= 'status-' + l.status;
                const path       = l.file_path;
                const msg        = l.message ? \`<span class="log-message">\${l.message}</span>\` : '';
                return \`<tr>
                    <td class="time-col">\${time}</td>
                    <td class="log-direction" style="color: \${l.direction.startsWith('up') ? '#a78bfa' : '#10b981'}">\${action}</td>
                    <td><span class="log-status \${statusClass}">\${l.status}</span></td>
                    <td><strong class="file-path-text">\${path}</strong>\${msg}</td>
                </tr>\`;
            }).join('');
        }

        // Cache filter & rendering
        function setCacheFilter(status) {
            cacheFilterStatus = status;
            document.querySelectorAll('#cacheFilterPills .filter-pill').forEach(btn => {
                const text = btn.innerText.trim().toLowerCase();
                if (text === status.toLowerCase() || (status === 'local' && text.includes('local')) || (status === 'stub' && text.includes('stub'))) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
            renderCache();
        }

        function filterCache() {
            cacheSearchQuery = document.getElementById('cacheSearchInput').value.trim().toLowerCase();
            renderCache();
        }

        function renderCache() {
            const body = document.getElementById('cacheBody');
            if (!cachedCacheFiles || cachedCacheFiles.length === 0) {
                body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem;"><div class="empty-state"><span class="material-symbols-outlined empty-icon">cloud_queue</span><span class="empty-title">No files cached locally</span><span class="empty-desc">Access files in your mount folder to see them in local cache.</span></div></td></tr>';
                return;
            }

            const filtered = cachedCacheFiles.filter(f => {
                const name = f.local_path || f.name || '';
                const matchesSearch = !cacheSearchQuery || name.toLowerCase().includes(cacheSearchQuery);

                let matchesStatus = true;
                if (cacheFilterStatus === 'local') {
                    matchesStatus = f.is_local;
                } else if (cacheFilterStatus === 'stub') {
                    matchesStatus = !f.is_local;
                }

                return matchesSearch && matchesStatus;
            });

            if (filtered.length === 0) {
                body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem;"><div class="empty-state"><span class="material-symbols-outlined empty-icon">search_off</span><span class="empty-title">No matches found</span><span class="empty-desc">Try adjusting your search query or filters.</span></div></td></tr>';
                return;
            }

            body.innerHTML = filtered.map(f => {
                const name    = f.local_path || f.name;
                const size    = formatBytes(f.size || 0);
                const isLocal = f.is_local;
                const uid     = f.node_uid;
                const status  = isLocal
                    ? \`<span class="log-status status-completed"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;margin-right:4px;">check_circle</span>Local</span>\`
                    : \`<span class="log-status" style="color:var(--text-muted);background:rgba(255,255,255,0.05);"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;margin-right:4px;">cloud_queue</span>Stub</span>\`;
                const actions = uid ? \`
                    \${isLocal ? \`<button class="btn btn-danger" style="padding:0.3rem 0.6rem;font-size:0.78rem;" onclick="evictFile('\${uid}')">Evict</button>\` : ''}
                    \${!isLocal ? \`<button class="btn btn-primary" style="padding:0.3rem 0.6rem;font-size:0.78rem;" onclick="pinFile('\${uid}')">Pin</button>\` : ''}
                \` : '';
                return \`<tr>
                    <td><strong class="file-path-text" title="\${name}">\${name}</strong></td>
                    <td style="color:var(--text-muted);">\${size}</td>
                    <td>\${status}</td>
                    <td style="display:flex;gap:6px;">\${actions}</td>
                </tr>\`;
            }).join('');
        }

        function renderStatus(data) {
            // Check auth state to show login page or main dashboard
            const appLayout = document.querySelector('.app-layout');
            const loginView = document.getElementById('loginView');
            if (data.status === 'auth_required') {
                if (appLayout) appLayout.style.display = 'none';
                if (loginView) loginView.style.display = 'flex';
            } else {
                if (appLayout) appLayout.style.display = 'flex';
                if (loginView) loginView.style.display = 'none';
            }

            // Status badge in topbar & Dashboard Hero
            const badge = document.getElementById('statusBadge');
            const text = document.getElementById('statusText');
            badge.className = 'status-badge status-' + data.status;
            const statusLabels = { synced: 'Synced', syncing: 'Syncing', scanning: 'Scanning', paused: 'Paused', offline: 'Offline', error: 'Error', auth_required: 'Login Required', bulk_deletion_warning: 'Action Required' };
            text.innerText = statusLabels[data.status] || data.status;

            // FOD mode — show mount point in hero card
            if (FOD_MODE && data.mountPoint) {
                const mp = document.getElementById('mountPointDisplay');
                if (mp) mp.innerText = data.mountPoint;
            }

            // Update status description and icon in hero card
            const heroTitle = document.getElementById('syncStateTitle');
            const heroDesc  = document.getElementById('syncStateDesc');
            const heroIcon  = document.getElementById('syncStatusIcon');

            // Bulk deletion warning card visibility
            const warningCard = document.getElementById('bulkDeletionWarningCard');
            const warningDesc = document.getElementById('bulkDeletionWarningDesc');
            if (data.status === 'bulk_deletion_warning') {
                warningCard.style.display = 'block';
                if (data.bulkDeletionCount > 0) {
                    warningDesc.innerText = \`The sync engine detected that \${data.bulkDeletionCount} local files were deleted. Synchronization has been paused to protect your remote files in the cloud from being deleted.\`;
                } else {
                    warningDesc.innerText = \`The sync engine detected that your local sync folder was emptied. Synchronization has been paused to protect your remote files in the cloud from being deleted.\`;
                }
            } else {
                warningCard.style.display = 'none';
            }

            // Inject the Material Symbol icon
            heroIcon.innerHTML = getMascotIcon(data.status);

            if (data.status === 'synced') {
                heroTitle.innerText = FOD_MODE ? 'FUSE filesystem mounted' : 'Your files are up to date';
                heroDesc.innerText  = FOD_MODE ? 'Files are served on-demand. Accessing a file downloads it transparently.' : 'Proton Drive is actively monitoring your sync folder.';
            } else if (data.status === 'bulk_deletion_warning') {
                heroTitle.innerText = 'Sync Paused - Deletion Warning';
                heroDesc.innerText  = 'A large number of local deletions was intercepted. Confirm or cancel them to resume sync.';
            } else if (data.status === 'syncing') {
                heroTitle.innerText = 'Syncing your changes...';
                heroDesc.innerText  = 'Uploading/downloading files to keep your drive in sync.';
            } else if (data.status === 'scanning') {
                heroTitle.innerText = 'Scanning repositories...';
                heroDesc.innerText  = 'Checking local and cloud directories for changes.';
            } else if (data.status === 'offline') {
                heroTitle.innerText = 'Sync Offline';
                heroDesc.innerText  = 'Connection to Proton servers lost. Sync will resume automatically when online.';
            } else if (data.status === 'paused') {
                heroTitle.innerText = 'Sync is paused';
                heroDesc.innerText  = 'Synchronization is paused. Changes will not be synced.';
            } else {
                heroTitle.innerText = 'Authentication required';
                heroDesc.innerText  = 'Please sign in to Proton Drive to enable sync.';
            }

            // Toggle sync/auth action controls visibility
            const syncActions = document.getElementById('syncActions');
            const authActions = document.getElementById('authActions');
            if (syncActions && authActions) {
                if (data.status === 'auth_required') {
                    syncActions.style.display = 'none';
                    authActions.style.display = 'flex';
                } else {
                    syncActions.style.display = 'flex';
                    authActions.style.display = 'none';
                }
            }

            const btns = document.querySelectorAll('.btn-login-action');
            btns.forEach(btn => {
                if (data.isAuthenticating) {
                    btn.innerText = 'Waiting for Authentication...';
                    btn.disabled = true;
                    isLoggingIn = true;
                } else {
                    btn.innerText = 'Login to Proton Drive';
                    btn.disabled = false;
                    isLoggingIn = false;
                }
            });

            // Sync path input field
            const pathInput = document.getElementById('syncPath');
            if (pathInput && document.activeElement !== pathInput && (data.localSyncRoot !== undefined || data.mountPoint !== undefined)) {
                pathInput.value = data.localSyncRoot || data.mountPoint || '';
            }

            // User Profile Email and Status
            if (data.email !== undefined) {
                document.getElementById('userEmail').innerText = data.email;
                const userStatus = document.getElementById('userStatus');
                if (data.email && data.email !== 'Not Logged In') {
                    document.getElementById('avatarLetter').innerText = data.email[0].toUpperCase();
                    userStatus.innerText = 'Connected';
                    userStatus.style.color = 'var(--success)';
                } else {
                    document.getElementById('avatarLetter').innerText = '?';
                    userStatus.innerText = 'Disconnected';
                    userStatus.style.color = 'var(--danger)';
                }
            }

            // Active transfers section (inline, above log)
            const transfersCard = document.getElementById('transfersCard');
            const transfersList = document.getElementById('transfersList');
            const transfersCount = document.getElementById('transfersCount');
            if (data.activeTransfers && data.activeTransfers.length > 0) {
                transfersCard.style.display = 'block';
                if (transfersCount) transfersCount.innerText = \`\${data.activeTransfers.length} active\`;
                transfersList.innerHTML = data.activeTransfers.map(t => {
                    const name = t.filePath ? t.filePath.split('/').pop() : t.localPath?.split('/').pop() || 'file';
                    const isUpload = t.type === 'upload';
                    const iconName = isUpload ? 'upload' : 'download';
                    const progressClass = isUpload ? 'upload-color' : 'download-color';
                    const percent = t.percent || 0;
                    const progressText = t.size > 0
                        ? \`\${formatBytes(t.transferred)} / \${formatBytes(t.size)} (\${percent}%)\`
                        : \`\${isUpload ? 'Uploading' : 'Downloading'}…\`;

                    return \`<li class="transfer-item">
                        <div class="transfer-header">
                            <span class="transfer-name-wrapper">
                                <span class="material-symbols-outlined transfer-type-icon \${progressClass}">\${iconName}</span>
                                <span class="transfer-name" title="\${t.filePath || t.localPath || ''}">\${name}</span>
                            </span>
                            <span class="transfer-meta">\${progressText}</span>
                        </div>
                        <div class="transfer-bar-bg">
                            <div class="transfer-bar-fill \${isUpload ? 'upload-bar' : 'download-bar'}" style="width: \${percent}%"></div>
                        </div>
                    </li>\`;
                }).join('');
            } else {
                transfersCard.style.display = 'none';
            }

            // Update pause button state
            if (!FOD_MODE) {
                isPaused = data.isPaused;
                const btn = document.getElementById('btnPause');
                if (btn) {
                    btn.className = isPaused ? 'btn btn-primary' : 'btn';
                    btn.innerText  = isPaused ? 'Resume Sync' : 'Pause Sync';
                }
                const syncBtn = document.getElementById('syncNowBtn');
                if (syncBtn) {
                    if (isPaused) {
                        syncBtn.setAttribute('disabled', 'true');
                    } else {
                        syncBtn.removeAttribute('disabled');
                    }
                }
            }
        }

        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                renderStatus(data);
            } catch (err) {
                console.error('Failed to fetch status:', err);
            }
        }

        async function fetchQuota() {
            try {
                const res  = await fetch('/api/quota');
                const data = await res.json();
                document.getElementById('quotaPercent').innerText    = data.percent + '%';
                document.getElementById('quotaBar').style.width       = data.percent + '%';
                document.getElementById('quotaText').innerText        = \`\${data.usedSpaceFormatted} of \${data.maxSpaceFormatted}\`;
            } catch (err) {
                console.error('Failed to fetch quota:', err);
            }
        }

        async function fetchLogs() {
            try {
                const res  = await fetch('/api/logs?limit=50');
                const rawText = await res.text();
                if (rawText === lastLogsJson) {
                    return;
                }
                lastLogsJson = rawText;
                cachedLogs = JSON.parse(rawText);
                renderLogs();
            } catch (err) {
                console.error('Failed to fetch logs:', err);
            }
        }

        async function fetchCachedFiles() {
            if (!FOD_MODE) return;
            try {
                const res  = await fetch('/api/cached-files');
                const rawText = await res.text();
                if (rawText === lastCacheJson) {
                    return;
                }
                lastCacheJson = rawText;
                const data = JSON.parse(rawText);
                const statsEl = document.getElementById('cacheSizeDisplay');

                if (data.stats) {
                    statsEl.innerText = \`\${data.stats.totalFiles} files cached — \${formatBytes(data.stats.totalBytes)} used on disk\`;
                }

                cachedCacheFiles = data.files || [];
                renderCache();
            } catch (err) {
                console.error('Failed to fetch cached files:', err);
            }
        }

        async function evictFile(nodeUid) {
            await fetch('/api/evict', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nodeUid }),
            });
            fetchCachedFiles();
        }

        async function pinFile(nodeUid) {
            await fetch('/api/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nodeUid }),
            });
            fetchCachedFiles();
        }

        async function evictAll() {
            if (!confirm('This will remove all locally cached files. Files will be re-downloaded on next access. Continue?')) return;
            const res  = await fetch('/api/cached-files');
            const data = await res.json();
            if (data.files) {
                for (const f of data.files) {
                    if (f.node_uid && f.is_local) await evictFile(f.node_uid);
                }
            }
        }

        async function togglePause() {
            const endpoint = isPaused ? '/api/resume' : '/api/pause';
            await fetch(endpoint, { method: 'POST' });
            fetchStatus();
        }

        async function confirmBulkDeletions() {
            if (confirm('Are you sure you want to delete these files from your remote Proton Cloud folder? This cannot be undone.')) {
                await fetch('/api/confirm-deletions', { method: 'POST' });
                fetchStatus();
                setTimeout(fetchLogs, 500);
            }
        }

        async function restoreBulkDeletions() {
            if (confirm('Do you want to restore these files by downloading them again from your remote Proton Cloud folder?')) {
                await fetch('/api/restore-deletions', { method: 'POST' });
                fetchStatus();
                setTimeout(fetchLogs, 500);
            }
        }

        async function forceSync() {
            await fetch('/api/sync', { method: 'POST' });
            fetchStatus();
            setTimeout(fetchLogs, 500);
        }

        async function openFolder() {
            await fetch('/api/open-folder', { method: 'POST' });
        }

        async function savePath() {
            const pathVal = document.getElementById('syncPath').value;
            try {
                const res = await fetch('/api/set-path', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: pathVal })
                });
                if (res.ok) {
                    alert('Sync folder updated successfully!');
                    fetchStatus();
                } else {
                    const data = await res.json();
                    alert('Error: ' + data.error);
                }
            } catch (err) {
                alert('Request failed: ' + err);
            }
        }

        async function logout() {
            if (confirm('Are you sure you want to log out from Proton Drive?')) {
                await fetch('/api/logout', { method: 'POST' });
                alert('Logged out successfully.');
                location.reload();
            }
        }

        async function stopDaemon() {
            if (!confirm('Stop the sync daemon? This dashboard will disconnect. Restart it manually with ./drive.sh start')) return;
            try {
                await fetch('/api/daemon/stop', { method: 'POST' });
            } catch {}
        }

        async function restartDaemon() {
            if (!confirm('Restart the sync daemon? This dashboard will briefly disconnect then reconnect.')) return;
            try {
                await fetch('/api/daemon/restart', { method: 'POST' });
                // Reconnect after a short delay
                setTimeout(() => location.reload(), 3000);
            } catch {
                setTimeout(() => location.reload(), 3000);
            }
        }

        let isLoggingIn = false;
        async function login() {
            if (isLoggingIn) return;
            isLoggingIn = true;
            
            const btns = document.querySelectorAll('.btn-login-action');
            btns.forEach(btn => {
                btn.innerText = 'Opening Browser...';
                btn.disabled = true;
            });

            try {
                const res = await fetch('/api/login', { method: 'POST' });
                const result = await res.json();
                if (result.ok) {
                    btns.forEach(btn => {
                        btn.innerText = 'Waiting for Authentication...';
                    });
                    alert('Proton Drive login page has been opened in your browser. Please sign in there, and this dashboard will automatically update once done.');
                } else {
                    alert('Failed to start login: ' + (result.error || 'Unknown error'));
                    btns.forEach(btn => {
                        btn.innerText = 'Login to Proton Drive';
                        btn.disabled = false;
                    });
                    isLoggingIn = false;
                }
            } catch (err) {
                alert('Network error trying to start login: ' + err.message);
                btns.forEach(btn => {
                    btn.innerText = 'Login to Proton Drive';
                    btn.disabled = false;
                });
                isLoggingIn = false;
            }
        }

        // Boot
        init();
        fetchStatus();
        fetchQuota();
        fetchLogs();

        // SSE push stream for real-time status
        const evtSource = new EventSource('/api/events');
        evtSource.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.status !== undefined) renderStatus(data);
            } catch {}
        };
        evtSource.onerror = () => {
            setTimeout(fetchStatus, 3000);
        };

        // Logs and quota remain poll-based
        setInterval(fetchLogs, 2000);
        setInterval(fetchQuota, 30000);
    </script>
</body>
</html>`;
}

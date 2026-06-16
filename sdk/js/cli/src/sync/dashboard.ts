import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SyncDatabase } from './db';
import { SyncEngine } from './engine';

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

                        // Legacy full-sync: auto-start if idle
                        if (engine && engine.getStatus() === 'idle') {
                            engine.start();
                        }
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
                });
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
            }

            // SSE PUSH STREAM — replaces client-side 1s polling for status updates
            if (url.pathname === '/api/events') {
                if (!engine) {
                    return new Response('Engine not available', { status: 503 });
                }
                let cleanup: (() => void) | null = null;
                const stream = new ReadableStream({
                    start(controller) {
                        const encoder = new TextEncoder();
                        const send = () => {
                            try {
                                const status = engine!.getStatus();
                                const transfers = engine!.getActiveTransfers();
                                const bulkCount = engine!.getBulkDeletionCount();
                                const payload = JSON.stringify({ status, activeTransfers: transfers, bulkDeletionCount: bulkCount });
                                controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                            } catch {
                                // Client disconnected
                            }
                        };
                        // Send immediately on connect, then on every change
                        send();
                        engine!.on('statusChanged', send);
                        cleanup = () => engine!.off('statusChanged', send);
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
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-body: #0b0a12;
            --bg-sidebar: #0f0e1a;
            --bg-card: rgba(22, 21, 38, 0.65);
            --bg-card-hover: rgba(29, 27, 48, 0.85);
            --border-color: rgba(255, 255, 255, 0.06);
            --border-color-glow: rgba(108, 71, 255, 0.25);
            --primary: #6c47ff;
            --primary-gradient: linear-gradient(135deg, #7c3aed 0%, #6366f1 100%);
            --primary-hover: #8060ff;
            --primary-glow: rgba(108, 71, 255, 0.2);
            --success: #10b981;
            --success-glow: rgba(16, 185, 129, 0.2);
            --warning: #f59e0b;
            --danger: #ef4444;
            --text-main: #f3f3f5;
            --text-muted: #8f8da8;
            --sidebar-active: rgba(108, 71, 255, 0.12);
            --sidebar-hover: rgba(255, 255, 255, 0.04);
            --shadow-premium: 0 8px 32px 0 rgba(0, 0, 0, 0.35);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Inter', sans-serif;
            background: var(--bg-body);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            overflow: hidden;
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
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
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
            color: var(--primary);
            flex-shrink: 0;
        }

        .brand-name {
            font-family: 'Outfit', sans-serif;
            font-size: 1.25rem;
            font-weight: 700;
            letter-spacing: -0.5px;
            color: #ffffff;
        }

        .sub-brand {
            font-family: 'Inter', sans-serif;
            font-size: 0.75rem;
            font-weight: 600;
            background: var(--primary-gradient);
            color: #ffffff;
            padding: 2px 6px;
            border-radius: 4px;
            margin-left: 6px;
            box-shadow: 0 2px 6px var(--primary-glow);
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
            border-left: 3px solid transparent;
        }

        .menu-item svg {
            width: 20px;
            height: 20px;
            fill: none;
            stroke: currentColor;
            stroke-width: 2;
            transition: stroke 0.2s;
        }

        .menu-item:hover {
            background: var(--sidebar-hover);
            color: var(--text-main);
        }

        .menu-item.active {
            background: var(--sidebar-active);
            color: #ffffff;
            border-left-color: var(--primary);
            font-weight: 600;
        }

        /* Sidebar Footer & Quota */
        .sidebar-footer {
            border-top: 1px solid var(--border-color);
            padding-top: 1.5rem;
            display: flex;
            flex-direction: column;
            gap: 1.2rem;
        }

        .storage-widget {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--border-color);
            padding: 1.1rem;
            border-radius: 12px;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.15);
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
            background: rgba(255, 255, 255, 0.04);
            border-radius: 9999px;
            overflow: hidden;
            margin-bottom: 8px;
        }

        .storage-bar-fill {
            height: 100%;
            background: var(--primary-gradient);
            border-radius: 9999px;
            width: 0%;
            transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 0 10px rgba(108, 71, 255, 0.4);
            background-size: 200% 200%;
            animation: gradient-shift 5s ease infinite;
        }

        @keyframes gradient-shift {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
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
            color: #ffffff;
        }

        .user-profile {
            display: flex;
            align-items: center;
            gap: 12px;
            background: rgba(255, 255, 255, 0.02);
            padding: 0.75rem;
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.03);
        }

        .user-avatar {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            background: var(--primary-gradient);
            color: #ffffff;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 600;
            font-size: 1.1rem;
            box-shadow: 0 2px 8px var(--primary-glow);
        }

        .user-details {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .user-email {
            font-size: 0.85rem;
            font-weight: 500;
            color: #ffffff;
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
        }

        /* Top Bar */
        .topbar {
            height: 70px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 2rem;
            background: rgba(11, 10, 18, 0.5);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            z-index: 9;
        }

        .section-title {
            font-family: 'Outfit', sans-serif;
            font-size: 1.4rem;
            font-weight: 600;
            color: #ffffff;
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
            background: rgba(255, 255, 255, 0.02);
            transition: all 0.3s;
        }

        .status-badge .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--text-muted);
        }

        /* Status colors and glowing animations */
        .status-synced {
            color: var(--success);
            border-color: rgba(16, 185, 129, 0.25);
            background: rgba(16, 185, 129, 0.06);
        }
        .status-synced .dot {
            background: var(--success);
            animation: pulse-glow-success 2.5s infinite;
        }

        @keyframes pulse-glow-success {
            0% { box-shadow: 0 0 2px rgba(16, 185, 129, 0.4); }
            50% { box-shadow: 0 0 10px rgba(16, 185, 129, 0.8); }
            100% { box-shadow: 0 0 2px rgba(16, 185, 129, 0.4); }
        }

        .status-syncing {
            color: #a78bfa;
            border-color: rgba(108, 71, 255, 0.25);
            background: rgba(108, 71, 255, 0.06);
        }
        .status-syncing .dot {
            background: var(--primary);
            animation: blink 1.2s infinite alternate, pulse-glow-primary 1.5s infinite;
        }

        @keyframes pulse-glow-primary {
            0% { box-shadow: 0 0 2px rgba(108, 71, 255, 0.4); }
            50% { box-shadow: 0 0 12px rgba(108, 71, 255, 0.8); }
            100% { box-shadow: 0 0 2px rgba(108, 71, 255, 0.4); }
        }

        .status-scanning {
            color: var(--warning);
            border-color: rgba(245, 158, 11, 0.25);
            background: rgba(245, 158, 11, 0.06);
        }
        .status-scanning .dot {
            background: var(--warning);
            animation: blink 1.2s infinite alternate, pulse-glow-warning 1.5s infinite;
        }

        @keyframes pulse-glow-warning {
            0% { box-shadow: 0 0 2px rgba(245, 158, 11, 0.4); }
            50% { box-shadow: 0 0 10px rgba(245, 158, 11, 0.8); }
            100% { box-shadow: 0 0 2px rgba(245, 158, 11, 0.4); }
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
            background: rgba(245, 158, 11, 0.06);
        }
        .status-offline .dot {
            background: var(--warning);
            animation: blink 1.2s infinite alternate;
        }

        .status-error {
            color: var(--danger);
            border-color: rgba(239, 68, 68, 0.25);
            background: rgba(239, 68, 68, 0.06);
        }
        .status-error .dot {
            background: var(--danger);
            box-shadow: 0 0 8px var(--danger);
        }

        @keyframes blink {
            0% { opacity: 0.4; }
            100% { opacity: 1; }
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
            animation: fadeIn 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .tab-pane.active {
            display: block;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* Card System (Glassmorphism) */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
            box-shadow: var(--shadow-premium);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .card:hover {
            border-color: rgba(108, 71, 255, 0.2);
            box-shadow: 0 12px 40px rgba(108, 71, 255, 0.06);
            transform: translateY(-2px);
        }

        .card h2 {
            font-family: 'Outfit', sans-serif;
            font-size: 1.15rem;
            font-weight: 600;
            color: #ffffff;
            margin-bottom: 1.2rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.04);
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
            align-items: center;
            justify-content: space-between;
            gap: 2rem;
            padding: 2rem;
            background: radial-gradient(circle at 10% 10%, rgba(108, 71, 255, 0.12), transparent), var(--bg-card);
        }

        .card-hero-content {
            display: flex;
            align-items: center;
            gap: 1.5rem;
        }

        .status-icon-wrapper {
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        }

        .hero-icon {
            width: 32px;
            height: 32px;
        }

        .hero-icon.success { color: var(--success); }
        .hero-icon.primary { color: var(--primary); }
        .hero-icon.warning { color: var(--warning); }
        .hero-icon.danger { color: var(--danger); }
        .hero-icon.muted { color: var(--text-muted); }

        .rotating {
            animation: rotate 2.2s linear infinite;
        }

        @keyframes rotate {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }

        .pulse {
            animation: pulse-grow 2s infinite alternate;
        }

        @keyframes pulse-grow {
            0% { transform: scale(0.94); opacity: 0.85; }
            100% { transform: scale(1.06); opacity: 1; }
        }

        .status-info h2 {
            font-family: 'Outfit', sans-serif;
            font-size: 1.4rem;
            font-weight: 600;
            border: none !important;
            padding: 0 !important;
            margin-bottom: 6px;
        }

        .status-info p {
            font-size: 0.92rem;
            color: var(--text-muted);
            line-height: 1.4;
        }

        .card-hero-actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }

        /* Buttons styling */
        .btn {
            background: rgba(255, 255, 255, 0.03);
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
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .btn:hover {
            background: rgba(255, 255, 255, 0.07);
            border-color: rgba(255, 255, 255, 0.15);
            transform: translateY(-1px);
        }

        .btn:active {
            transform: translateY(0);
        }

        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            pointer-events: none;
            transform: none !important;
            box-shadow: none !important;
        }

        .btn-primary {
            background: var(--primary-gradient);
            border: none;
            color: #ffffff;
            box-shadow: 0 4px 12px var(--primary-glow);
        }

        .btn-primary:hover {
            background: linear-gradient(135deg, #8b5cf6 0%, #4f46e5 100%);
            box-shadow: 0 4px 16px rgba(108, 71, 255, 0.35);
        }

        .btn-danger {
            background: rgba(239, 68, 68, 0.1);
            border-color: rgba(239, 68, 68, 0.2);
            color: #fca5a5;
        }

        .btn-danger:hover {
            background: var(--danger);
            border-color: var(--danger);
            color: #ffffff;
            box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
        }

        /* Active Transfers Panel (Animated stripes) */
        .transfers-list {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 12px;
            max-height: 350px;
            overflow-y: auto;
            padding-right: 4px;
            min-width: 0;
        }

        .transfer-item {
            background: rgba(255, 255, 255, 0.01);
            padding: 1rem;
            border-radius: 10px;
            border: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            gap: 8px;
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
            width: 16px;
            height: 16px;
            flex-shrink: 0;
        }

        .upload-color { color: #a78bfa; }
        .download-color { color: #34d399; }

        .transfer-name {
            font-size: 0.88rem;
            font-weight: 500;
            color: #ffffff;
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
            background: rgba(255, 255, 255, 0.05);
            border-radius: 9999px;
            overflow: hidden;
        }

        .transfer-bar-fill {
            height: 100%;
            border-radius: 9999px;
            width: 0%;
            transition: width 0.3s ease;
            position: relative;
            background-size: 30px 30px;
            background-image: linear-gradient(
                45deg,
                rgba(255, 255, 255, 0.15) 25%,
                transparent 25%,
                transparent 50%,
                rgba(255, 255, 255, 0.15) 50%,
                rgba(255, 255, 255, 0.15) 75%,
                transparent 75%,
                transparent
            );
            animation: progress-bar-stripes 1s linear infinite;
        }

        @keyframes progress-bar-stripes {
            0% { background-position: 0 0; }
            100% { background-position: 30px 0; }
        }

        .upload-bar {
            background-color: #8b5cf6;
        }

        .download-bar {
            background-color: #10b981;
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
            background: rgba(255, 255, 255, 0.01);
            padding: 1.2rem;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.02);
        }

        .setting-info {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .setting-title {
            font-size: 0.95rem;
            font-weight: 600;
            color: #ffffff;
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
            background: rgba(0, 0, 0, 0.25);
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
            box-shadow: 0 0 6px var(--primary-glow);
        }

        .logs-table-wrapper {
            overflow-x: auto;
            max-height: 550px;
            overflow-y: auto;
            border-radius: 12px;
            border: 1px solid var(--border-color);
            background: rgba(0, 0, 0, 0.15);
            box-shadow: inset 0 2px 8px rgba(0,0,0,0.2);
        }

        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
            font-size: 0.88rem;
        }

        th {
            background: rgba(255, 255, 255, 0.01);
            padding: 1rem 1.2rem;
            color: var(--text-muted);
            font-weight: 600;
            border-bottom: 1px solid var(--border-color);
            text-transform: uppercase;
            font-size: 0.72rem;
            letter-spacing: 0.8px;
            font-family: 'Outfit', sans-serif;
        }

        td {
            padding: 1rem 1.2rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.02);
            color: #e2e8f0;
        }

        tr:last-child td {
            border-bottom: none;
        }

        tr:hover td {
            background: rgba(255, 255, 255, 0.01);
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

        .status-completed { color: #34d399; background: rgba(16, 185, 129, 0.1); }
        .status-syncing { color: #a78bfa; background: rgba(108, 71, 255, 0.1); }
        .status-failed { color: #fca5a5; background: rgba(239, 68, 68, 0.1); }

        .time-col {
            color: var(--text-muted);
            font-size: 0.8rem;
            white-space: nowrap;
        }

        .file-path-text {
            font-weight: 500;
            color: #ffffff;
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
            border-bottom: 1px solid rgba(255, 255, 255, 0.04);
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
            background: rgba(0, 0, 0, 0.2);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 0 0.75rem;
            width: 220px;
            transition: all 0.2s;
        }

        .search-box:focus-within {
            border-color: var(--primary);
            box-shadow: 0 0 6px var(--primary-glow);
            background: rgba(0, 0, 0, 0.35);
        }

        .search-icon {
            width: 14px;
            height: 14px;
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
            background: rgba(255, 255, 255, 0.01);
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
            background: rgba(255, 255, 255, 0.04);
            color: var(--text-main);
        }

        .filter-pill.active {
            background: var(--primary-gradient);
            color: #ffffff;
            border-color: transparent;
            box-shadow: 0 2px 8px var(--primary-glow);
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
            width: 44px;
            height: 44px;
            color: rgba(255, 255, 255, 0.12);
            margin-bottom: 6px;
        }

        .empty-title {
            font-size: 0.95rem;
            font-weight: 600;
            color: #ffffff;
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
            background: rgba(255,255,255,0.05);
        }

        .menu-toggle svg {
            width: 24px;
            height: 24px;
        }

        /* Mobile sidebar drawer overlay overlay */
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
            animation: fadeOverlay 0.2s ease-out;
        }

        @keyframes fadeOverlay {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        .sidebar-overlay.active {
            display: block;
        }

        /* Custom scrollbar */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }

        ::-webkit-scrollbar-track {
            background: var(--bg-sidebar);
        }

        ::-webkit-scrollbar-thumb {
            background: #232136;
            border-radius: 9999px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: #353252;
        }

        /* Bulk Deletion Warning Card */
        .card-warning {
            background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(239, 68, 68, 0.1)) !important;
            border-color: rgba(245, 158, 11, 0.35) !important;
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
            width: 36px;
            height: 36px;
            color: var(--warning);
            flex-shrink: 0;
            margin-top: 2px;
        }

        .warning-text-wrapper h3 {
            font-size: 1.15rem;
            font-weight: 700;
            color: #ffffff;
            margin-bottom: 6px;
            border-bottom: none !important;
            padding-bottom: 0 !important;
        }

        .warning-text-wrapper p {
            font-size: 0.92rem;
            color: #ffedd5;
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
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        }

        /* ── RESPONSIVE MEDIA QUERIES ────────────────────────────────────── */

        @media (max-width: 1024px) {
            .sidebar {
                position: fixed;
                top: 0;
                left: 0;
                height: 100vh;
                transform: translateX(-100%);
                z-index: 100;
                box-shadow: 4px 0 24px rgba(0, 0, 0, 0.5);
            }
            
            .sidebar.open {
                transform: translateX(0);
            }

            .main-content {
                width: 100%;
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

        @media (min-width: 1200px) {
            .dashboard-grid {
                grid-template-columns: 2fr 1.1fr;
            }
            .dashboard-main-col {
                display: flex;
                flex-direction: column;
            }
            .dashboard-side-col {
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
            }

            .search-box {
                width: 100%;
            }

            .filter-pills {
                width: 100%;
                overflow-x: auto;
                padding-bottom: 4px;
            }

            .filter-pill {
                white-space: nowrap;
            }
        }

        @media (max-width: 480px) {
            .topbar {
                height: 60px;
                padding: 0 1rem;
            }

            .section-title {
                font-size: 1.15rem;
            }

            .status-badge {
                padding: 0.4rem 0.75rem;
                font-size: 0.7rem;
            }

            .content-container {
                padding: 1rem;
            }

            .card {
                padding: 1rem;
                border-radius: 12px;
            }

            .card-hero {
                padding: 1rem;
            }

            .status-icon-wrapper {
                width: 48px;
                height: 48px;
            }

            .hero-icon {
                width: 24px;
                height: 24px;
            }

            .status-info h2 {
                font-size: 1.15rem;
            }

            .status-info p {
                font-size: 0.85rem;
            }

            .warning-banner-content {
                gap: 0.75rem;
            }

            .warning-banner-icon {
                width: 28px;
                height: 28px;
            }

            .warning-text-wrapper h3 {
                font-size: 1rem;
            }

            .warning-text-wrapper p {
                font-size: 0.85rem;
            }

            .warning-actions {
                flex-direction: column;
                width: 100%;
            }

            .warning-actions .btn {
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <div class="app-layout">
        <!-- Left Sidebar -->
        <aside class="sidebar">
            <div class="sidebar-header">
                <!-- Proton-style Cloud / Shield SVG Logo -->
                <svg class="proton-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"/>
                    <path d="M12 6V11"/>
                    <path d="M12 15H12.01"/>
                    <path d="M8 12C8 9.79086 9.79086 8 12 8C14.2091 8 16 9.79086 16 12C16 14.2091 14.2091 16 12 16C9.79086 16 8 14.2091 8 12Z" stroke-dasharray="2 2"/>
                </svg>
                <span class="brand-name">Proton Drive<span class="sub-brand" id="modeLabel">Sync</span></span>
            </div>

            <nav class="sidebar-menu">
                <div class="menu-item active" onclick="showTab('dashboard')">
                    <!-- Dashboard icon -->
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="3" width="7" height="9"></rect>
                        <rect x="14" y="3" width="7" height="5"></rect>
                        <rect x="14" y="12" width="7" height="9"></rect>
                        <rect x="3" y="16" width="7" height="5"></rect>
                    </svg>
                    Dashboard
                </div>
                <div class="menu-item" onclick="showTab('settings')">
                    <!-- Settings icon -->
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="3"></circle>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                    Settings
                </div>
                <div class="menu-item" id="cacheMenuItem" onclick="showTab('cache')" style="display:none;">
                    <!-- Cloud icon -->
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
                    </svg>
                    Local Cache
                </div>
            </nav>

            <div class="sidebar-footer">
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
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="3" y1="12" x2="21" y2="12"></line>
                            <line x1="3" y1="6" x2="21" y2="6"></line>
                            <line x1="3" y1="18" x2="21" y2="18"></line>
                        </svg>
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
                            <svg class="warning-banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                                <line x1="12" y1="9" x2="12" y2="13"></line>
                                <line x1="12" y1="17" x2="12.01" y2="17"></line>
                            </svg>
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
                    <div id="fodHeroCard" class="card" style="display:none; background: radial-gradient(circle at 10% 10%, rgba(16,185,129,0.08), transparent), var(--bg-card);">
                        <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
                            <div style="width:52px;height:52px;border-radius:50%;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                                <svg style="width:28px;height:28px;color:#10b981;" viewBox="0 0 24 24" fill="currentColor"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
                            </div>
                            <div>
                                <h2 style="font-size:1.1rem;font-weight:700;color:#fff;margin:0 0 4px;border:none;padding:0;">File On Demand — FUSE Mode</h2>
                                <p style="font-size:0.88rem;color:var(--text-muted);margin:0;">Mount point: <code id="mountPointDisplay" style="color:#a78bfa;font-size:0.85rem;">~/P-Drive</code></p>
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
                                        <svg class="hero-icon success" viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                                        </svg>
                                    </div>
                                    <div class="status-info">
                                        <h2 id="syncStateTitle">Your files are up to date</h2>
                                        <p id="syncStateDesc">Proton Drive is actively monitoring your sync folder.</p>
                                    </div>
                                </div>
                                <div class="card-hero-actions">
                                    <button id="btnPause" class="btn btn-primary" onclick="togglePause()">Pause Sync</button>
                                    <button id="syncNowBtn" class="btn" onclick="forceSync()">Sync Now</button>
                                    <button class="btn" onclick="openFolder()">Open Folder</button>
                                </div>
                            </div>

                            <!-- Activity History Card -->
                            <div class="card">
                                <div class="card-header-flex">
                                    <h2>Recent Activity Log</h2>
                                    <div class="filter-search-container">
                                        <div class="search-box">
                                            <!-- Search icon -->
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="search-icon">
                                                <circle cx="11" cy="11" r="8"></circle>
                                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                            </svg>
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

                        <div class="dashboard-side-col" id="dashboardSideCol">
                            <!-- Active Transfers Card -->
                            <div id="transfersCard" class="card" style="display: none;">
                                <h2>Active Transfers</h2>
                                <ul id="transfersList" class="transfers-list">
                                    <!-- Populated dynamically via JS -->
                                </ul>
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
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="search-icon">
                                    <circle cx="11" cy="11" r="8"></circle>
                                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                </svg>
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
                        </div>
                    </div>
                </div>
            </div>
        </main>
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

        let cacheSearchQuery = '';
        let cacheFilterStatus = 'all';
        let cachedCacheFiles = [];

        function init() {
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

            const items = document.querySelectorAll('.menu-item');
            for (let item of items) {
                const txt = item.innerText.trim().toLowerCase();
                if (txt === tabId.toLowerCase() ||
                    (tabId === 'history' && txt === 'activity log') ||
                    (tabId === 'cache'   && txt === 'local cache')) {
                    item.classList.add('active');
                }
            }

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
                body.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;"><div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span class="empty-title">No recent sync activity</span><span class="empty-desc">Proton Drive is scanning your files. Activity logs will appear here as changes are detected.</span></div></td></tr>';
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
                body.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;"><div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg><span class="empty-title">No matches found</span><span class="empty-desc">Try adjusting your search query or filters.</span></div></td></tr>';
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
                    <td class="log-direction" style="color: \${l.direction.startsWith('up') ? '#a78bfa' : '#34d399'}">\${action}</td>
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
                body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem;"><div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg><span class="empty-title">No files cached locally</span><span class="empty-desc">Access files in your mount folder to see them in local cache.</span></div></td></tr>';
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
                body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem;"><div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg><span class="empty-title">No matches found</span><span class="empty-desc">Try adjusting your search query or filters.</span></div></td></tr>';
                return;
            }

            body.innerHTML = filtered.map(f => {
                const name    = f.local_path || f.name;
                const size    = formatBytes(f.size || 0);
                const isLocal = f.is_local;
                const uid     = f.node_uid;
                const status  = isLocal
                    ? \`<span class="log-status status-completed">&#8226; Local</span>\`
                    : \`<span class="log-status" style="color:#8f8da8;background:rgba(255,255,255,0.04);">&#8226; Stub</span>\`;
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
            // Status badge in topbar & Dashboard Hero
            const badge = document.getElementById('statusBadge');
            const text = document.getElementById('statusText');
            badge.className = 'status-badge status-' + data.status;
            text.innerText = data.status.replace('_', ' ');

            // FOD mode — show mount point in hero card
            if (FOD_MODE && data.mountPoint) {
                const mp = document.getElementById('mountPointDisplay');
                if (mp) mp.innerText = data.mountPoint;
            }

            // Update status description and icon in hero card
            const heroTitle = document.getElementById('syncStateTitle');
            const heroDesc  = document.getElementById('syncStateDesc');
            const heroIcon  = document.getElementById('syncStatusIcon');

            // Bulk deletion warning card visibility (legacy full-sync only)
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

            if (data.status === 'synced') {
                heroTitle.innerText = FOD_MODE ? 'FUSE filesystem mounted' : 'Your files are up to date';
                heroDesc.innerText  = FOD_MODE ? 'Files are served on-demand. Accessing a file downloads it transparently.' : 'Proton Drive is actively monitoring your sync folder.';
                heroIcon.innerHTML  = \`<svg class="hero-icon success" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>\`;
            } else if (data.status === 'bulk_deletion_warning') {
                heroTitle.innerText = 'Sync Paused - Deletion Warning';
                heroDesc.innerText  = 'A large number of local deletions was intercepted. Confirm or cancel them to resume sync.';
                heroIcon.innerHTML  = \`<svg class="hero-icon danger pulse" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>\`;
            } else if (data.status === 'syncing') {
                heroTitle.innerText = 'Syncing your changes...';
                heroDesc.innerText  = 'Uploading/downloading files to keep your drive in sync.';
                heroIcon.innerHTML  = \`<svg class="hero-icon primary rotating" viewBox="0 0 24 24" fill="currentColor"><path d="M19 8l-4 4h3c0 3.31-2.69 6-6 6-1.01 0-1.97-.25-2.8-.7l-1.46 1.46C8.97 19.54 10.43 20 12 20c4.42 0 8-3.58 8-8h3l-4-4zM6 12c0-3.31 2.69-6 6-6 1.01 0 1.97.25 2.8.7l1.46-1.46C15.03 4.46 13.57 4 12 4c-4.42 0-8 3.58-8 8H1l4 4 4-4H6z"/></svg>\`;
            } else if (data.status === 'scanning') {
                heroTitle.innerText = 'Scanning repositories...';
                heroDesc.innerText  = 'Checking local and cloud directories for changes.';
                heroIcon.innerHTML  = \`<svg class="hero-icon warning pulse" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>\`;
            } else if (data.status === 'offline') {
                heroTitle.innerText = 'Sync Offline';
                heroDesc.innerText  = 'Connection to Proton servers lost. Sync will resume automatically when online.';
                heroIcon.innerHTML  = \`<svg class="hero-icon warning pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.5"></path><path d="M5 12.5a10.94 10.94 0 0 1 2.28-1.44"></path><path d="M8.66 8.66A6.96 6.96 0 0 1 12 7.5a6.96 6.96 0 0 1 3.34 1.16"></path><path d="M12 18.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"></path><path d="M10.12 13.12a2.97 2.97 0 0 1 3.76 0"></path></svg>\`;
            } else if (data.status === 'paused') {
                heroTitle.innerText = 'Sync is paused';
                heroDesc.innerText  = 'Synchronization is paused. Changes will not be synced.';
                heroIcon.innerHTML  = \`<svg class="hero-icon muted" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>\`;
            } else {
                heroTitle.innerText = 'Authentication required';
                heroDesc.innerText  = 'Please sign in to Proton Drive via CLI to enable sync.';
                heroIcon.innerHTML  = \`<svg class="hero-icon danger" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>\`;
            }

            // Sync path input field (full-sync mode only)
            const pathInput = document.getElementById('syncPath');
            if (pathInput && document.activeElement !== pathInput) {
                pathInput.value = data.localSyncRoot || data.mountPoint || '';
            }

            // User Profile Email and Status
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

            // Active transfers section
            const transfersCard = document.getElementById('transfersCard');
            const transfersList = document.getElementById('transfersList');
            if (data.activeTransfers && data.activeTransfers.length > 0) {
                transfersCard.style.display = 'block';
                transfersList.innerHTML = data.activeTransfers.map(t => {
                    const name = t.filePath ? t.filePath.split('/').pop() : t.localPath?.split('/').pop() || 'file';
                    const isUpload = t.type === 'upload';
                    const iconSvg = isUpload
                        ? \`<svg class="transfer-type-icon upload-color" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zm0-10h4v6h6v-6h4l-7-7-7 7z"/></svg>\`
                        : \`<svg class="transfer-type-icon download-color" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>\`;

                    const percent = t.percent || 0;
                    const progressText = t.size > 0
                        ? \`\${formatBytes(t.transferred)} / \${formatBytes(t.size)} (\${percent}%)\`
                        : \`\${isUpload ? 'Uploading' : 'Downloading'}…\`;

                    return \`<li class="transfer-item">
                        <div class="transfer-header">
                            <span class="transfer-name-wrapper">
                                \${iconSvg}
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

            // Update pause button state (full-sync only)
            if (!FOD_MODE) {
                isPaused = data.isPaused;
                const btn = document.getElementById('btnPause');
                if (btn) {
                    btn.className = isPaused ? 'btn btn-primary' : 'btn btn-secondary';
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
                const res  = await fetch('/api/logs');
                cachedLogs = await res.json();
                renderLogs();
            } catch (err) {
                console.error('Failed to fetch logs:', err);
            }
        }

        async function fetchCachedFiles() {
            if (!FOD_MODE) return;
            try {
                const res  = await fetch('/api/cached-files');
                const data = await res.json();
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
                alert('Logged out. Please run login from the terminal to reconnect.');
                location.reload();
            }
        }

        // Boot
        init();
        fetchStatus();
        fetchQuota();
        fetchLogs();

        // Use SSE push stream for real-time status instead of 1s polling.
        // The server emits an event on every engine statusChanged — zero CPU overhead when idle.
        const evtSource = new EventSource('/api/events');
        evtSource.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.status !== undefined) renderStatus(data);
            } catch {}
        };
        evtSource.onerror = () => {
            // SSE disconnected (e.g. server restarted) — fall back to polling until reconnected
            setTimeout(fetchStatus, 3000);
        };

        // Logs and quota remain poll-based (not event-driven)
        setInterval(fetchLogs, 2000);
        setInterval(fetchQuota, 30000);
    </script>
</body>
</html>`;
}

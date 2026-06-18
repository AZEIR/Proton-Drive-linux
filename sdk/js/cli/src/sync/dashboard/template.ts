import css from './style.css' with { type: 'text' };
import js from './app.js' with { type: 'text' };

export function getHtmlContent(isFodMode: boolean = false): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proton Drive - Desktop Sync</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 20 106 95'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M49.9553 33.7554H95.0391C101.095 33.7554 106 38.6208 106 44.6278V101.117C106 107.124 101.095 111.989 95.0391 111.989H83.4637V55.256C83.4637 50.568 79.6201 46.7666 74.8827 46.7999L33.3631 47.0326C31.5754 47.0437 29.8324 46.4926 28.3687 45.4619L19.1173 38.9532C17.676 37.9336 15.9441 37.3906 14.1788 37.3906H0V35.8722C0 29.8654 4.90503 25 10.9609 25H31.5307C33.6089 25 35.6313 25.6539 37.2961 26.873L44.1788 31.8824C45.8547 33.1015 47.8771 33.7554 49.9553 33.7554Z' fill='%23a78bfa'/%3E%3Cpath d='M74.8827 46.7999L33.3631 47.0326C31.5754 47.0437 29.8324 46.4926 28.3687 45.4619L19.1173 38.9532C17.676 37.9336 15.9441 37.3906 14.1788 37.3906H0V101.128C0 107.135 4.90503 112 10.9609 112H83.4637V55.256C83.4637 50.568 79.6201 46.7666 74.8827 46.7999Z' fill='%236d4aff'/%3E%3C/svg%3E">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap" rel="stylesheet">
    <style>${css}</style>
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

    <script>const FOD_MODE = ${isFodMode ? 'true' : 'false'};
${js}</script>
</body>
</html>`;
}

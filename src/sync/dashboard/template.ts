import css from './style.css' with { type: 'text' };
import js from './app.js' with { type: 'text' };

export function getHtmlContent(isFodMode: boolean = false): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Drive for Linux — Unofficial Proton client</title>
    <link rel="stylesheet" href="/assets/dashboard.css?v=network-profile-1">
</head>
<body data-fod-mode="${isFodMode ? 'true' : 'false'}">
    <div class="app-layout">
        <!-- Left Sidebar -->
        <aside class="sidebar" id="sidebarNavigation">
            <a href="https://github.com/AZEIR/Proton-Drive-linux" target="_blank" rel="noopener" class="sidebar-header sidebar-brand-link">
                <span class="app-logo" aria-hidden="true">DL</span>
                <span class="brand-name">Drive for Linux<span class="sub-brand" id="modeLabel">Unofficial</span></span>
            </a>

            <nav class="sidebar-menu" aria-label="Dashboard navigation">
                <button type="button" class="menu-item active" data-tab="dashboard" data-action="show-tab" data-action-value="dashboard" aria-current="page">
                    <span class="material-symbols-outlined menu-icon">dashboard</span>
                    Dashboard
                </button>
                <button type="button" class="menu-item" data-tab="browser" data-action="show-tab" data-action-value="browser">
                    <span class="material-symbols-outlined menu-icon">folder_open</span>
                    File Browser
                </button>
                <button type="button" class="menu-item" data-tab="settings" data-action="show-tab" data-action-value="settings">
                    <span class="material-symbols-outlined menu-icon">settings</span>
                    Settings
                </button>
            </nav>

            <div class="sidebar-footer">
                <!-- Theme Toggle Button -->
                <div class="theme-toggle-container">
                    <button type="button" class="theme-toggle-btn" data-action="toggle-theme" aria-label="Toggle light/dark theme">
                        <span class="material-symbols-outlined sun-icon">light_mode</span>
                        <span class="material-symbols-outlined moon-icon">dark_mode</span>
                        <span id="themeToggleText">Light Mode</span>
                    </button>
                </div>

                <!-- Quota status widget -->
                <div class="storage-widget">
                    <div class="storage-title">Storage Quota</div>
                    <div class="storage-bar-bg">
                        <progress id="quotaBar" class="storage-bar-fill" max="100" value="0" aria-label="Storage used"></progress>
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
                <div class="topbar-title-group">
                    <button type="button" class="menu-toggle" id="sidebarToggle" aria-label="Open navigation" aria-controls="sidebarNavigation" aria-expanded="false" data-action="toggle-sidebar">
                        <span class="material-symbols-outlined">menu</span>
                    </button>
                    <h1 class="section-title" id="pageTitle">Sync Dashboard</h1>
                </div>
                <div class="topbar-actions">
                    <div id="statusBadge" class="status-badge status-synced" role="status" aria-live="polite">
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
                    <div id="bulkDeletionWarningCard" class="card card-warning hidden">
                        <div class="warning-banner-content">
                            <span class="material-symbols-outlined warning-banner-icon">warning</span>
                            <div class="warning-text-wrapper">
                                <h3>Bulk Deletion Safeguard Triggered</h3>
                                <p id="bulkDeletionWarningDesc">The sync engine detected that local files were deleted. Synchronization has been paused to protect your remote files in the cloud from being deleted.</p>
                            </div>
                        </div>
                        <div class="warning-actions">
                            <button type="button" class="btn btn-danger" data-action="confirm-bulk-deletions">Delete from Cloud</button>
                            <button type="button" class="btn btn-success" data-action="restore-bulk-deletions">Restore Files from Cloud</button>
                        </div>
                    </div>



                    <!-- Dashboard Layout -->
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
                                    <button type="button" id="btnPause" class="btn btn-primary" aria-pressed="false" aria-label="Pause synchronization" data-action="toggle-pause">Pause Sync</button>
                                    <button type="button" id="syncNowBtn" class="btn" data-action="force-sync">Sync Now</button>
                                    <button type="button" class="btn" data-action="open-folder">Open Folder</button>
                                </div>
                                <div id="authActions" class="hidden">
                                    <button type="button" id="btnLogin" class="btn btn-primary btn-login-action" data-action="login">Login to Proton Drive</button>
                                </div>
                            </div>
                        </div>

                        <section class="runtime-grid" aria-label="Live synchronization health" aria-live="polite">
                            <div class="runtime-metric">
                                <span class="runtime-label">Network</span>
                                <strong id="networkState">Starting</strong>
                                <span id="networkDetail" class="runtime-detail">Measuring connection health…</span>
                            </div>
                            <div class="runtime-metric">
                                <span class="runtime-label">Throughput</span>
                                <strong id="throughputValue">0 B/s</strong>
                                <span id="transferEta" class="runtime-detail">No active transfer</span>
                            </div>
                            <div class="runtime-metric">
                                <span class="runtime-label">Transfer queue</span>
                                <strong id="queueDepth">0</strong>
                                <span id="queueDetail" class="runtime-detail">No queued work</span>
                            </div>
                            <div class="runtime-metric">
                                <span class="runtime-label">Durable work</span>
                                <strong id="durablePending">0</strong>
                                <span id="durableDetail" class="runtime-detail">All changes committed</span>
                            </div>
                        </section>

                        <!-- Activity History Card -->
                        <div class="card">
                            <div class="card-header-flex">
                                <h2>Recent Activity Log</h2>
                                <div class="filter-search-container">
                                    <div class="search-box">
                                        <span class="material-symbols-outlined search-icon">search</span>
                                        <input type="text" id="logSearchInput" aria-label="Search activity logs" placeholder="Search logs..." data-input-action="filter-logs">
                                    </div>
                                    <div class="filter-pills" id="logFilterPills">
                                        <button type="button" class="filter-pill active" data-action="set-log-filter" data-action-value="all">All</button>
                                        <button type="button" class="filter-pill" data-action="set-log-filter" data-action-value="uploads">Uploads</button>
                                        <button type="button" class="filter-pill" data-action="set-log-filter" data-action-value="downloads">Downloads</button>
                                        <button type="button" class="filter-pill" data-action="set-log-filter" data-action-value="system">System</button>
                                        <button type="button" class="filter-pill" data-action="set-log-filter" data-action-value="failed">Errors</button>
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

                <!-- Tab Pane: Settings -->
                <div id="tab-settings" class="tab-pane">
                    <div class="settings-grid">
                        <!-- Section: Sync & Storage -->
                        <div class="card settings-card">
                            <div class="settings-card-header">
                                <span class="material-symbols-outlined settings-header-icon">folder_managed</span>
                                <div>
                                    <h2>Sync & Storage</h2>
                                    <p class="settings-header-desc">Manage local directory paths and file synchronization engine modes.</p>
                                </div>
                            </div>
                            
                            <div class="setting-row">
                                <div class="setting-info">
                                    <span class="setting-title">Sync Folder Path</span>
                                    <span class="setting-desc">Files inside this local directory will sync with your Proton Cloud root.</span>
                                </div>
                                <div class="setting-input-group">
                                    <input type="text" id="syncPath" value="" placeholder="/home/user/ProtonDrive">
                                    <button type="button" class="btn btn-primary" data-action="save-path">Save Path</button>
                                </div>
                            </div>
                            
                            <div class="setting-row vertical-setting">
                                <div class="setting-info setting-info-spaced">
                                    <span class="setting-title">Synchronization Mode</span>
                                    <span class="setting-desc">Choose how Proton Drive handles local files and cloud storage.</span>
                                </div>
                                <div class="mode-cards-container" role="radiogroup" aria-label="Synchronization mode">
                                    <button type="button" class="mode-card" id="cardModeFull" role="radio" aria-checked="false" data-action="switch-sync-mode" data-action-value="full">
                                        <div class="mode-card-header">
                                            <span class="material-symbols-outlined mode-card-icon">folder_copy</span>
                                            <span class="mode-card-badge" id="badgeModeFull">Active</span>
                                        </div>
                                        <h4 class="mode-card-title">Standard Full Sync</h4>
                                        <p class="mode-card-desc">Downloads full copies of all files to your local drive for offline access.</p>
                                        <div class="mode-card-footer">
                                            <span class="material-symbols-outlined check-icon">check_circle</span>
                                            <span>Offline Access Enabled</span>
                                        </div>
                                    </button>
                                    <button type="button" class="mode-card" id="cardModeFuse" role="radio" aria-checked="false" data-action="switch-sync-mode" data-action-value="fuse">
                                        <div class="mode-card-header">
                                            <span class="material-symbols-outlined mode-card-icon">cloud_sync</span>
                                            <span class="mode-card-badge" id="badgeModeFuse">Active</span>
                                        </div>
                                        <h4 class="mode-card-title">FUSE File-On-Demand</h4>
                                        <p class="mode-card-desc">Mounts your Drive virtual filesystem without using local disk space until accessed.</p>
                                        <div class="mode-card-footer">
                                            <span class="material-symbols-outlined check-icon">check_circle</span>
                                            <span>Saves Disk Space</span>
                                        </div>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- Section: Network & Speed Performance -->
                        <div class="card settings-card">
                            <div class="settings-card-header">
                                <span class="material-symbols-outlined settings-header-icon">speed</span>
                                <div>
                                    <h2>Network & Performance</h2>
                                    <p class="settings-header-desc">Control transfer limits and choose a tested connection profile.</p>
                                </div>
                            </div>

                            <div class="setting-row">
                                <div class="setting-info">
                                    <span class="setting-title">Network Profile</span>
                                    <span class="setting-desc">Choose a tested connection profile. Changes affect newly scheduled transfers.</span>
                                </div>
                                <div class="network-profile-options" role="group" aria-label="Network performance profile">
                                    <button type="button" class="network-profile-btn" data-profile="safe" data-action="set-network-profile" data-action-value="safe" aria-pressed="false" title="1 file and up to 2 sockets">Wi-Fi Safe</button>
                                    <button type="button" class="network-profile-btn" data-profile="balanced" data-action="set-network-profile" data-action-value="balanced" aria-pressed="false" title="3 files and up to 8 sockets">Balanced</button>
                                    <button type="button" class="network-profile-btn" data-profile="performance" data-action="set-network-profile" data-action-value="performance" aria-pressed="false" title="5 files and up to 16 sockets">Performance</button>
                                </div>
                            </div>

                            <div class="setting-row">
                                <div class="setting-info">
                                    <span class="setting-title">Bandwidth Speed Limit</span>
                                    <span class="setting-desc">Set maximum upload/download transfer rate (0 = Unlimited).</span>
                                    <div class="speed-presets">
                                        <button type="button" class="speed-preset-btn" data-action="set-speed-preset" data-speed-kbps="0">Unlimited</button>
                                        <button type="button" class="speed-preset-btn" data-action="set-speed-preset" data-speed-kbps="1024">1 MB/s</button>
                                        <button type="button" class="speed-preset-btn" data-action="set-speed-preset" data-speed-kbps="5120">5 MB/s</button>
                                        <button type="button" class="speed-preset-btn" data-action="set-speed-preset" data-speed-kbps="10240">10 MB/s</button>
                                    </div>
                                </div>
                                <div class="setting-input-group">
                                    <div class="input-with-unit">
                                        <input type="number" id="maxSpeedInput" min="0" placeholder="0">
                                        <span class="unit-label">KB/s</span>
                                    </div>
                                    <button type="button" class="btn btn-primary" data-action="save-max-speed">Save Speed</button>
                                </div>
                            </div>

                            <div class="setting-row">
                                <div class="setting-info">
                                    <span class="setting-title">Parallel File Transfers</span>
                                    <span class="setting-desc">Simultaneous files (1–5). Manual changes use a Custom profile.</span>
                                </div>
                                <div class="setting-input-group">
                                    <div class="range-with-value">
                                        <input type="range" id="concurrencyRange" min="1" max="5" step="1" value="2" aria-label="Parallel file transfer limit" data-input-action="update-concurrency-input">
                                        <input type="number" id="concurrencyInput" min="1" max="5" step="1" value="2" aria-label="Parallel file transfer limit" data-input-action="update-concurrency-range">
                                    </div>
                                    <button type="button" id="concurrencySaveBtn" class="btn btn-primary" data-action="save-concurrency">Save Limit</button>
                                </div>
                            </div>

                        </div>

                        <!-- Section: Account & Session -->
                        <div class="card settings-card">
                            <div class="settings-card-header">
                                <span class="material-symbols-outlined settings-header-icon">manage_accounts</span>
                                <div>
                                    <h2>Account & Session</h2>
                                    <p class="settings-header-desc">Manage connected Proton account session state.</p>
                                </div>
                            </div>

                            <div class="setting-row">
                                <div class="account-profile-wrapper">
                                    <div class="user-avatar-md" id="settingsAvatar">?</div>
                                    <div class="account-profile-details">
                                        <span id="settingsUserEmail" class="account-email">Not Logged In</span>
                                        <span id="settingsUserStatus" class="account-status">Connected</span>
                                    </div>
                                </div>
                                <div class="setting-input-group">
                                    <button type="button" class="btn btn-danger" data-action="logout">Logout Account</button>
                                </div>
                            </div>
                        </div>

                        <!-- Section: System & Daemon Control -->
                        <div class="card settings-card">
                            <div class="settings-card-header">
                                <span class="material-symbols-outlined settings-header-icon">terminal</span>
                                <div>
                                    <h2>Daemon Service Control</h2>
                                    <p class="settings-header-desc">Control background synchronization engine process operations.</p>
                                </div>
                            </div>

                            <div class="setting-row">
                                <div class="setting-info">
                                    <span class="setting-title">Background Daemon Process</span>
                                    <span class="setting-desc">Restart or stop the local sync service. Stopping will pause synchronization until restarted.</span>
                                </div>
                                <div class="daemon-actions">
                                    <button type="button" class="btn" data-action="restart-daemon">
                                        <span class="material-symbols-outlined icon-md">refresh</span>
                                        Restart Service
                                    </button>
                                    <button type="button" class="btn btn-danger" data-action="stop-daemon">
                                        <span class="material-symbols-outlined icon-md">stop_circle</span>
                                        Stop Daemon
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Tab Pane: File Browser -->
                <div id="tab-browser" class="tab-pane">
                    <div class="browser-container card">
                        <!-- Browser Header & Breadcrumbs -->
                        <div class="browser-header">
                            <div class="browser-breadcrumbs" id="browserBreadcrumbs">
                                <span class="breadcrumb-item active" aria-current="page">My Files</span>
                            </div>
                            <div class="browser-toolbar">
                                <div class="search-box">
                                    <span class="material-symbols-outlined search-icon">search</span>
                                    <input type="text" id="browserSearchInput" aria-label="Filter files in current folder" placeholder="Filter current folder..." data-input-action="filter-browser-items">
                                </div>
                                <button type="button" class="btn btn-sm browser-refresh-btn" data-action="refresh-browser" title="Refresh file list" aria-label="Refresh file list">
                                    <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
                                </button>
                            </div>
                        </div>

                        <!-- Browser File List Table -->
                        <div class="browser-table-wrapper">
                            <table class="browser-table">
                                <caption class="sr-only">Files and folders in the current Proton Drive directory</caption>
                                <thead>
                                    <tr>
                                        <th class="browser-name-heading">Name</th>
                                        <th class="browser-status-heading">Local Status</th>
                                        <th class="browser-size-heading">Size</th>
                                        <th class="browser-actions-heading">Actions</th>
                                    </tr>
                                </thead>
                                <tbody id="browserTableBody">
                                    <tr class="browser-empty-row">
                                        <td colspan="4" class="text-center browser-empty-cell is-muted">Loading files...</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <!-- Browser Footer Stats -->
                        <div class="browser-footer">
                            <span id="browserItemCount">0 items</span>
                            <span id="browserCacheSummary">0 B cached locally</span>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <!-- Toast Notification Container -->
    <div id="toast-container" class="toast-container" aria-live="polite" aria-atomic="true"></div>

    <!-- Dedicated login screen for unauthenticated users -->
    <div id="loginView" class="login-view">
        <div class="login-card">
            <span class="app-logo login-logo" aria-hidden="true">DL</span>
            <h1 class="login-title">Welcome to Drive for Linux</h1>
            <p class="login-desc">Sign in with your Proton account to configure local desktop synchronization and access your secure cloud files.</p>
            <p class="login-desc unofficial-notice"><em>This is a third-party application not officially supported by Proton.</em></p>
            <button type="button" class="btn btn-primary login-btn btn-login-action" data-action="login">Login to Proton Drive</button>
        </div>
    </div>

    <script src="/assets/dashboard.js?v=network-profile-1" defer></script>
</body>
</html>`;
}

export function getDashboardCss(): string {
    return css;
}

export function getDashboardJs(): string {
    return js;
}

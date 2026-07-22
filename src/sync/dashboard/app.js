        let isPaused = false;
        let currentTab = 'dashboard';
        const IS_FOD = false; // Replaced server-side with isFodMode

        // Injected by server

        // Local UI State for Search/Filters
        let logSearchQuery = '';
        let logFilterCategory = 'all';
        let cachedLogs = [];
        let lastLogsJson = '';
        let cachedActiveTransfers = [];
        let visibleLogsCount = 100;
        let currentFilteredLength = 0;

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

            // Infinite scroll for logs
            const logsWrapper = document.querySelector('#tab-dashboard .logs-table-wrapper');
            if (logsWrapper) {
                logsWrapper.addEventListener('scroll', () => {
                    // Trigger when within 40px of the bottom of scroll container
                    if (logsWrapper.scrollHeight - logsWrapper.scrollTop - logsWrapper.clientHeight < 40) {
                        if (visibleLogsCount < currentFilteredLength) {
                            visibleLogsCount += 100;
                            renderLogs();
                        }
                    }
                });
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
                return `<span class="material-symbols-outlined status-hero-icon text-success">cloud_done</span>`;
            } else if (status === 'syncing') {
                return `<span class="material-symbols-outlined status-hero-icon text-primary spin-animation">sync</span>`;
            } else if (status === 'scanning') {
                return `<span class="material-symbols-outlined status-hero-icon text-warning pulse-animation">search</span>`;
            } else if (status === 'paused') {
                return `<span class="material-symbols-outlined status-hero-icon text-muted">pause_circle</span>`;
            } else if (status === 'bulk_deletion_warning') {
                return `<span class="material-symbols-outlined status-hero-icon text-warning pulse-animation">warning</span>`;
            } else {
                return `<span class="material-symbols-outlined status-hero-icon text-danger">cloud_off</span>`;
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

            const item = document.querySelector(`.menu-item[data-tab="${tabId}"]`);
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
            visibleLogsCount = 100;
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
            visibleLogsCount = 100;
            renderLogs();
        }

        function renderLogs() {
            const body = document.getElementById('logsBody');

            // Build active-transfer rows pinned to the top of the table
            const ringR = 8;
            const ringCirc = +(2 * Math.PI * ringR).toFixed(2);
            const activeRows = cachedActiveTransfers
                .filter(t => {
                    const isUpload = t.type === 'upload';
                    if (logFilterCategory === 'uploads')   return isUpload;
                    if (logFilterCategory === 'downloads') return !isUpload;
                    if (logFilterCategory === 'system' || logFilterCategory === 'failed') return false;
                    if (logSearchQuery) {
                        const name = t.filePath || t.localPath || '';
                        return name.toLowerCase().includes(logSearchQuery);
                    }
                    return true;
                })
                .map(t => {
                    const name      = t.filePath || t.localPath || 'file';
                    const isUpload  = t.type === 'upload';
                    const dirColor  = isUpload ? '#a78bfa' : '#10b981';
                    const dirLabel  = isUpload ? 'upload' : 'download';
                    const ringClass = isUpload ? 'upload-ring' : 'download-ring';
                    const percent   = t.percent || 0;
                    const offset    = +(ringCirc * (1 - percent / 100)).toFixed(2);
                    const sizeTxt   = t.size > 0 ? `${formatBytes(t.transferred)} / ${formatBytes(t.size)}` : '';
                    return `<tr class="transfer-active-row">
                        <td class="time-col">${new Date().toLocaleString()}</td>
                        <td class="log-direction" style="color:${dirColor}">${dirLabel}</td>
                        <td>
                            <span class="transfer-progress-cell">
                                <svg class="transfer-mini-ring" viewBox="0 0 22 22" width="20" height="20">
                                    <circle class="transfer-ring-track" cx="11" cy="11" r="${ringR}"/>
                                    <circle class="transfer-ring-fill ${ringClass}" cx="11" cy="11" r="${ringR}"
                                        stroke-dasharray="${ringCirc}" stroke-dashoffset="${offset}"/>
                                </svg>
                                <span>${percent}%</span>
                            </span>
                        </td>
                        <td><strong class="file-path-text">${name}</strong>${sizeTxt ? `<span class="log-message">${sizeTxt}</span>` : ''}</td>
                    </tr>`;
                });

            const filtered = (cachedLogs || []).filter(l => {
                const path = l.file_path || '';
                const msg  = l.message || '';
                const matchesSearch = !logSearchQuery || path.toLowerCase().includes(logSearchQuery) || msg.toLowerCase().includes(logSearchQuery);
                let matchesCategory = true;
                const dir = l.direction.toLowerCase();
                if (logFilterCategory === 'uploads')        matchesCategory = dir.startsWith('up') || dir === 'upload';
                else if (logFilterCategory === 'downloads') matchesCategory = dir.startsWith('down') || dir === 'download';
                else if (logFilterCategory === 'system')    matchesCategory = dir === 'system';
                else if (logFilterCategory === 'failed')    matchesCategory = l.status === 'failed';
                return matchesSearch && matchesCategory;
            });

            currentFilteredLength = filtered.length;

            if (activeRows.length === 0 && filtered.length === 0) {
                const isEmpty = !cachedLogs || cachedLogs.length === 0;
                body.innerHTML = isEmpty
                    ? '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;"><div class="empty-state"><span class="material-symbols-outlined empty-icon">cloud_off</span><span class="empty-title">No recent sync activity</span><span class="empty-desc">Proton Drive is scanning your files. Activity logs will appear here as changes are detected.</span></div></td></tr>'
                    : '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;"><div class="empty-state"><span class="material-symbols-outlined empty-icon">search_off</span><span class="empty-title">No matches found</span><span class="empty-desc">Try adjusting your search query or filters.</span></div></td></tr>';
                return;
            }

            const visibleLogs = filtered.slice(0, visibleLogsCount);
            let html = activeRows.join('') + visibleLogs.map(l => {
                const time        = new Date(l.timestamp).toLocaleString();
                const action      = l.direction.replace('_', ' ');
                const statusClass = 'status-' + l.status;
                const path        = l.file_path;
                const msg         = l.message ? `<span class="log-message">${l.message}</span>` : '';
                return `<tr>
                    <td class="time-col">${time}</td>
                    <td class="log-direction" style="color: ${l.direction.startsWith('up') ? '#a78bfa' : '#10b981'}">${action}</td>
                    <td><span class="log-status ${statusClass}">${l.status}</span></td>
                    <td><strong class="file-path-text">${path}</strong>${msg}</td>
                </tr>`;
            }).join('');

            if (filtered.length > visibleLogsCount) {
                html += `<tr>
                    <td colspan="4" style="text-align: center; padding: 1rem;">
                        <button class="btn" style="font-size: 0.8rem; padding: 0.4rem 1rem;" onclick="loadMoreLogs(event)">
                            <span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle; margin-right:4px;">expand_more</span>
                            Show More (showing ${visibleLogsCount} of ${filtered.length})
                        </button>
                    </td>
                </tr>`;
            }

            body.innerHTML = html;
        }

        window.loadMoreLogs = function(event) {
            if (event) event.preventDefault();
            visibleLogsCount += 100;
            renderLogs();
        };

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
                    ? `<span class="log-status status-completed"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;margin-right:4px;">check_circle</span>Local</span>`
                    : `<span class="log-status" style="color:var(--text-muted);background:rgba(255,255,255,0.05);"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;margin-right:4px;">cloud_queue</span>Stub</span>`;
                const actions = uid ? `
                    ${isLocal ? `<button class="btn btn-danger" style="padding:0.3rem 0.6rem;font-size:0.78rem;" onclick="evictFile('${uid}')">Evict</button>` : ''}
                    ${!isLocal ? `<button class="btn btn-primary" style="padding:0.3rem 0.6rem;font-size:0.78rem;" onclick="pinFile('${uid}')">Pin</button>` : ''}
                ` : '';
                return `<tr>
                    <td><strong class="file-path-text" title="${name}">${name}</strong></td>
                    <td style="color:var(--text-muted);">${size}</td>
                    <td>${status}</td>
                    <td style="display:flex;gap:6px;">${actions}</td>
                </tr>`;
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

            // Bulk deletion warning card visibility
            const warningCard = document.getElementById('bulkDeletionWarningCard');
            const warningDesc = document.getElementById('bulkDeletionWarningDesc');
            if (data.status === 'bulk_deletion_warning') {
                warningCard.style.display = 'block';
                if (data.bulkDeletionCount > 0) {
                    warningDesc.innerText = `The sync engine detected that ${data.bulkDeletionCount} local files were deleted. Synchronization has been paused to protect your remote files in the cloud from being deleted.`;
                } else {
                    warningDesc.innerText = `The sync engine detected that your local sync folder was emptied. Synchronization has been paused to protect your remote files in the cloud from being deleted.`;
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

            // Active transfers — store and re-render log table so they appear as pinned rows
            cachedActiveTransfers = data.activeTransfers || [];
            renderLogs();

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
                document.getElementById('quotaText').innerText        = `${data.usedSpaceFormatted} of ${data.maxSpaceFormatted}`;
            } catch (err) {
                console.error('Failed to fetch quota:', err);
            }
        }

        async function fetchLogs() {
            try {
                const res  = await fetch('/api/logs?limit=1000');
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
                    statsEl.innerText = `${data.stats.totalFiles} files cached — ${formatBytes(data.stats.totalBytes)} used on disk`;
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
            try { await fetch('/api/daemon/stop', { method: 'POST' }); } catch {}
        }

        async function restartDaemon() {
            if (!confirm('Restart the sync daemon? This dashboard will briefly disconnect then reconnect.')) return;
            try { await fetch('/api/daemon/restart', { method: 'POST' }); } catch {}
            setTimeout(() => location.reload(), 3000);
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

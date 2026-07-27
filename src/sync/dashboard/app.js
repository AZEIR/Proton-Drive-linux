        let isPaused = false;
        let currentTab = 'dashboard';
        let concurrencyDraft;
        const FOD_MODE = document.body.dataset.fodMode === 'true';
        const IS_FOD = FOD_MODE;
        const nativeFetch = window.fetch.bind(window);
        let csrfTokenPromise;

        const ICON_SHAPES = {
            dashboard: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
            menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
            settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
            cloud: '<path d="M7 18h11a4 4 0 0 0 .6-8 6.5 6.5 0 0 0-12.3-1.8A5 5 0 0 0 7 18Z"/>',
            cloud_done: '<path d="M7 18h11a4 4 0 0 0 .6-8 6.5 6.5 0 0 0-12.3-1.8A5 5 0 0 0 7 18Z"/><path d="m9 13 2 2 4-4"/>',
            cloud_off: '<path d="m3 3 18 18M7.2 7.2A5 5 0 0 0 7 17h10M10.2 5.3a6.5 6.5 0 0 1 8.4 4.7 4 4 0 0 1 2.1 6.7"/>',
            sync: '<path d="M20 7h-5V2M4 17h5v5M19 12a7 7 0 0 0-12-5L4 10M5 12a7 7 0 0 0 12 5l3-3"/>',
            refresh: '<path d="M20 6v5h-5M19 11a7 7 0 1 0-1.5 6.3"/>',
            search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
            search_off: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M4 4l16 16"/>',
            folder: '<path d="M3 6h7l2 2h9v10H3Z"/>',
            folder_open: '<path d="M3 7h7l2 2h9l-2 9H3Z"/>',
            folder_copy: '<path d="M5 7h6l2 2h8v10H5Z"/><path d="M3 15V5h7l2 2"/>',
            folder_managed: '<path d="M3 6h7l2 2h9v10H3Z"/><circle cx="15" cy="13" r="2"/><path d="M15 9v2M15 15v2M11 13h2M17 13h2"/>',
            folder_zip: '<path d="M3 6h7l2 2h9v10H3Z"/><path d="M13 8v2h2v2h-2v2h2v2"/>',
            description: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
            draft: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5"/>',
            code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4M13 6l-2 12"/>',
            image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 4 4 2-2 5 5"/>',
            video_file: '<path d="M5 3h10l4 4v14H5Z"/><path d="M15 3v5h5M9 11l5 3-5 3Z"/>',
            audio_file: '<path d="M9 18V7l9-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="15.5" cy="16" r="2.5"/>',
            download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
            open_in_new: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v7H4V6h7"/>',
            push_pin: '<path d="m8 4 8 8M15 3l6 6-4 1-4 4-1 4-6-6 4-1 4-4Z"/><path d="m9 15-5 5"/>',
            delete_sweep: '<path d="M4 7h10M7 7V4h4v3M6 10l1 10h6l1-10M17 13h5M18 17h4M16 21h6"/>',
            warning: '<path d="M12 3 2.5 20h19Z"/><path d="M12 9v5M12 17h.01"/>',
            check_circle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
            error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
            info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
            pause_circle: '<circle cx="12" cy="12" r="9"/><path d="M9 9v6M15 9v6"/>',
            stop_circle: '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6"/>',
            speed: '<path d="M5 19a8 8 0 1 1 14 0M12 17l4-6"/><path d="M7 15H4M20 15h-3M12 7V4"/>',
            terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
            manage_accounts: '<circle cx="9" cy="8" r="3"/><path d="M3 19a6 6 0 0 1 12 0M17 11l4 4M19 9l2 2-5 5-3 1 1-3Z"/>',
            dark_mode: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
            light_mode: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
            chevron_right: '<path d="m9 5 7 7-7 7"/>',
            expand_more: '<path d="m5 9 7 7 7-7"/>',
        };

        const ICON_ALIASES = {
            cloud_sync: 'sync',
        };

        function renderIcon(element) {
            if (element.classList.contains('icon-ready')) return;
            const requestedName = element.textContent.trim();
            const iconName = ICON_ALIASES[requestedName] || requestedName;
            const shape = ICON_SHAPES[iconName] || ICON_SHAPES.info;
            element.textContent = '';
            element.dataset.icon = requestedName;
            element.setAttribute('aria-hidden', 'true');
            element.innerHTML = `<svg class="ui-icon" viewBox="0 0 24 24" focusable="false">${shape}</svg>`;
            element.classList.add('icon-ready');
        }

        function installIconRenderer() {
            const renderWithin = node => {
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                if (node.matches?.('.material-symbols-outlined')) renderIcon(node);
                node.querySelectorAll?.('.material-symbols-outlined').forEach(renderIcon);
            };
            renderWithin(document.body);
            new MutationObserver(mutations => {
                for (const mutation of mutations) {
                    mutation.addedNodes.forEach(renderWithin);
                }
            }).observe(document.body, { childList: true, subtree: true });
        }

        async function getCsrfToken() {
            csrfTokenPromise ??= nativeFetch('/api/v1/session')
                .then(response => {
                    if (!response.ok) throw new Error('Dashboard session is not authorized');
                    return response.json();
                })
                .then(payload => payload.csrfToken);
            return csrfTokenPromise;
        }

        window.fetch = async function secureDashboardFetch(input, init = {}) {
            const method = String(init.method || 'GET').toUpperCase();
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
                const headers = new Headers(init.headers || {});
                headers.set('X-CSRF-Token', await getCsrfToken());
                init = { ...init, headers };
            }
            return nativeFetch(input, init);
        };

        function escapeHtml(str) {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        function encodeActionValue(value) {
            const bytes = new TextEncoder().encode(String(value ?? ''));
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return btoa(binary);
        }

        function decodeActionValue(value) {
            const binary = atob(value);
            const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
            return new TextDecoder().decode(bytes);
        }

        // Local UI State for Search/Filters
        let logSearchQuery = '';
        let logFilterCategory = 'all';
        let cachedLogs = [];
        let lastLogsJson = '';
        let cachedActiveTransfers = [];
        let visibleLogsCount = 100;
        let currentFilteredLength = 0;

        // Toast Notification System
        function showToast(message, type = 'info', duration = 4000) {
            const container = document.getElementById('toast-container');
            if (!container) return;

            const toast = document.createElement('div');
            toast.className = `toast toast-${type}`;

            let iconName = 'info';
            if (type === 'success') iconName = 'check_circle';
            if (type === 'danger') iconName = 'error';

            toast.innerHTML = `
                <span class="material-symbols-outlined toast-icon">${iconName}</span>
                <span class="toast-message">${escapeHtml(message)}</span>
            `;

            container.appendChild(toast);

            setTimeout(() => {
                toast.classList.add('toast-out');
                setTimeout(() => {
                    if (toast.parentNode) toast.parentNode.removeChild(toast);
                }, 250);
            }, duration);
        }

        function setSpeedPreset(kbps) {
            const input = document.getElementById('maxSpeedInput');
            if (input) {
                input.value = kbps;
                updateSpeedPresetButtons(kbps);
                saveMaxSpeed();
            }
        }

        function updateSpeedPresetButtons(val) {
            const btns = document.querySelectorAll('.speed-preset-btn');
            btns.forEach(btn => {
                const preset = Number(btn.dataset.speedKbps);
                if (Number.isFinite(preset) && preset === val) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        }

        function updateNetworkProfileButtons(profile) {
            document.querySelectorAll('.network-profile-btn').forEach(btn => {
                const isActive = btn.dataset.profile === profile;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-pressed', String(isActive));
            });
        }

        function applyConcurrencyValue(val) {
            const input = document.getElementById('concurrencyInput');
            const range = document.getElementById('concurrencyRange');
            if (input) input.value = String(val);
            if (range) range.value = String(val);
        }

        function updateConcurrencyInput(val) {
            concurrencyDraft = String(val);
            applyConcurrencyValue(val);
        }

        function updateConcurrencyRange(val) {
            concurrencyDraft = String(val);
            const parsed = Number(val);
            const range = document.getElementById('concurrencyRange');
            if (range && Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) {
                range.value = String(parsed);
            }
        }

        function installDeclarativeHandlers() {
            document.addEventListener('click', event => {
                const element = event.target.closest('[data-action]');
                if (!element) return;
                const value = element.dataset.actionValue || '';
                const decodedValue = element.dataset.encodedValue
                    ? decodeActionValue(element.dataset.encodedValue)
                    : value;
                const actions = {
                    'toggle-theme': toggleTheme,
                    'toggle-sidebar': toggleSidebar,
                    'confirm-bulk-deletions': confirmBulkDeletions,
                    'restore-bulk-deletions': restoreBulkDeletions,
                    'toggle-pause': togglePause,
                    'force-sync': forceSync,
                    'open-folder': openFolder,
                    login,
                    'save-path': savePath,
                    'save-max-speed': saveMaxSpeed,
                    'save-concurrency': saveConcurrency,
                    logout,
                    'restart-daemon': restartDaemon,
                    'stop-daemon': stopDaemon,
                    'refresh-browser': refreshBrowser,
                    'show-tab': () => showTab(value),
                    'set-log-filter': () => setLogFilter(value),
                    'switch-sync-mode': () => switchSyncMode(value),
                    'set-network-profile': () => setNetworkProfile(value),
                    'set-speed-preset': () => setSpeedPreset(Number(element.dataset.speedKbps)),
                    'navigate-browser': () => navigateToBrowserPath(decodedValue),
                    'hydrate-browser-item': () => hydrateBrowserItem(decodedValue),
                    'evict-browser-item': () => evictBrowserItem(decodedValue),
                    'pin-browser-item': () => pinBrowserItem(decodedValue),
                    'open-browser-item': () => openBrowserItem(decodedValue),
                    'load-more-logs': () => {
                        visibleLogsCount += 100;
                        renderLogs();
                    },
                };
                actions[element.dataset.action]?.();
            });
            document.addEventListener('input', event => {
                const action = event.target.dataset.inputAction;
                if (action === 'filter-logs') filterLogs();
                else if (action === 'filter-browser-items') filterBrowserItems();
                else if (action === 'update-concurrency-input') {
                    updateConcurrencyInput(event.target.value);
                } else if (action === 'update-concurrency-range') {
                    updateConcurrencyRange(event.target.value);
                }
            });
        }

        function init() {
            installIconRenderer();
            installDeclarativeHandlers();
            // Load theme from localStorage
            loadTheme();

            // Create sidebar overlay for mobile
            const overlay = document.createElement('div');
            overlay.className = 'sidebar-overlay';
            overlay.dataset.action = 'toggle-sidebar';
            document.body.appendChild(overlay);

            if (IS_FOD) {
                document.getElementById('modeLabel').innerText = 'FOD';
            }

            const requestedTab = window.location.hash.slice(1);
            if (['browser', 'settings'].includes(requestedTab)) {
                showTab(requestedTab);
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
            const toggle = document.getElementById('sidebarToggle');
            sidebar.classList.toggle('open');
            overlay.classList.toggle('active');
            const isOpen = sidebar.classList.contains('open');
            if (toggle) {
                toggle.setAttribute('aria-expanded', String(isOpen));
                toggle.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
            }
        }

        function showTab(tabId) {
            document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.menu-item').forEach(el => {
                el.classList.remove('active');
                el.removeAttribute('aria-current');
            });
            const pane = document.getElementById('tab-' + tabId);
            if (!pane) return;
            pane.classList.add('active');

            const item = document.querySelector(`.menu-item[data-tab="${tabId}"]`);
            if (item) {
                item.classList.add('active');
                item.setAttribute('aria-current', 'page');
            }

            currentTab = tabId;
            const nextHash = tabId === 'dashboard' ? window.location.pathname : `#${tabId}`;
            window.history.replaceState(null, '', nextHash);
            const titles = {
                'dashboard': 'Sync Dashboard',
                'browser':   'Proton Drive File Browser',
                'history':   'Activity History',
                'settings':  'Configuration Settings',
            };
            document.getElementById('pageTitle').innerText = titles[tabId] || tabId;

            if (tabId === 'browser') {
                loadBrowserPath(currentBrowserPath);
            }

            // Close mobile sidebar drawer if open
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.querySelector('.sidebar-overlay');
            if (sidebar.classList.contains('open')) {
                sidebar.classList.remove('open');
                overlay.classList.remove('active');
                const toggle = document.getElementById('sidebarToggle');
                if (toggle) {
                    toggle.setAttribute('aria-expanded', 'false');
                    toggle.setAttribute('aria-label', 'Open navigation');
                }
            }
        }

        // ── Integrated File Browser Logic ─────────────────────────────────
        let currentBrowserPath = '';
        let currentBrowserData = { breadcrumbs: [], items: [] };
        let browserSearchQuery = '';

        function loadBrowserPath(relPath) {
            currentBrowserPath = relPath || '';
            const tbody = document.getElementById('browserTableBody');
            if (tbody) {
                tbody.innerHTML = `<tr class="browser-empty-row"><td colspan="4" class="text-center browser-empty-cell is-muted">Loading files...</td></tr>`;
            }
            fetch('/api/browser/list?path=' + encodeURIComponent(currentBrowserPath))
                .then(async (response) => {
                    const data = await response.json();
                    if (!response.ok || data.error) {
                        throw new Error(data.error || `Request failed with status ${response.status}`);
                    }
                    return data;
                })
                .then(data => {
                    currentBrowserData = data;
                    renderBreadcrumbs(data.breadcrumbs || []);
                    renderBrowserItems();
                })
                .catch(err => {
                    console.error('Failed to fetch browser list:', err);
                    if (tbody) {
                        tbody.innerHTML = `<tr class="browser-empty-row"><td colspan="4" class="text-center text-danger browser-empty-cell">Failed to load files: ${escapeHtml(err.message)}</td></tr>`;
                    }
                });
        }

        function renderBreadcrumbs(breadcrumbs) {
            const container = document.getElementById('browserBreadcrumbs');
            if (!container) return;
            if (!breadcrumbs || breadcrumbs.length === 0) {
                container.innerHTML = `<span class="breadcrumb-item active" aria-current="page">My Files</span>`;
                return;
            }
            let html = '';
            breadcrumbs.forEach((b, idx) => {
                const isLast = idx === breadcrumbs.length - 1;
                if (idx > 0) {
                    html += `<span class="breadcrumb-separator material-symbols-outlined">chevron_right</span>`;
                }
                if (isLast) {
                    html += `<span class="breadcrumb-item active" aria-current="page">${escapeHtml(b.name)}</span>`;
                } else {
                    html += `<button type="button" class="breadcrumb-item" data-action="navigate-browser" data-encoded-value="${encodeActionValue(b.path)}">${escapeHtml(b.name)}</button>`;
                }
            });
            container.innerHTML = html;
        }

        function navigateToBrowserPath(relPath) {
            const input = document.getElementById('browserSearchInput');
            if (input) input.value = '';
            browserSearchQuery = '';
            loadBrowserPath(relPath);
        }

        function refreshBrowser() {
            loadBrowserPath(currentBrowserPath);
        }

        function filterBrowserItems() {
            const input = document.getElementById('browserSearchInput');
            browserSearchQuery = input ? input.value.trim().toLowerCase() : '';
            renderBrowserItems();
        }

        function getFileIcon(name, isDir) {
            if (isDir) return `<span class="material-symbols-outlined file-icon folder">folder</span>`;
            const ext = name.split('.').pop().toLowerCase();
            if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
                return `<span class="material-symbols-outlined file-icon">image</span>`;
            } else if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) {
                return `<span class="material-symbols-outlined file-icon">description</span>`;
            } else if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) {
                return `<span class="material-symbols-outlined file-icon">video_file</span>`;
            } else if (['mp3', 'wav', 'flac', 'ogg', 'aac'].includes(ext)) {
                return `<span class="material-symbols-outlined file-icon">audio_file</span>`;
            } else if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) {
                return `<span class="material-symbols-outlined file-icon">folder_zip</span>`;
            } else if (['js', 'ts', 'py', 'json', 'html', 'css', 'cpp', 'sh', 'rs'].includes(ext)) {
                return `<span class="material-symbols-outlined file-icon">code</span>`;
            }
            return `<span class="material-symbols-outlined file-icon">draft</span>`;
        }

        function renderBrowserItems() {
            const tbody = document.getElementById('browserTableBody');
            if (!tbody) return;

            let items = currentBrowserData.items || [];
            if (browserSearchQuery) {
                items = items.filter(item => item.name.toLowerCase().includes(browserSearchQuery));
            }

            let cachedCount = 0;
            let totalBytes = 0;
            let cachedBytes = 0;

            items.forEach(item => {
                if (!item.isDir) {
                    const size = Number.isFinite(Number(item.size)) ? Number(item.size) : 0;
                    totalBytes += size;
                    if (item.isCached) {
                        cachedCount++;
                        cachedBytes += size;
                    }
                }
            });

            const countEl = document.getElementById('browserItemCount');
            const summaryEl = document.getElementById('browserCacheSummary');
            if (countEl) countEl.innerText = `${items.length} items (${cachedCount} cached locally)`;
            if (summaryEl) summaryEl.innerText = `${formatBytes(cachedBytes)} cached of ${formatBytes(totalBytes)}`;

            if (items.length === 0) {
                tbody.innerHTML = `<tr class="browser-empty-row"><td colspan="4" class="text-center browser-empty-cell is-muted">No items found in this directory.</td></tr>`;
                return;
            }

            let html = '';
            items.forEach(item => {
                const icon = getFileIcon(item.name, item.isDir);
                const encodedPath = encodeActionValue(item.relPath);
                const encodedUid = encodeActionValue(item.nodeUid || '');
                const nameDisplay = item.isDir 
                    ? `<button type="button" class="browser-item-name is-dir" data-action="navigate-browser" data-encoded-value="${encodedPath}">${icon}<span>${escapeHtml(item.name)}</span></button>`
                    : `<div class="browser-item-name">${icon}<span>${escapeHtml(item.name)}</span></div>`;

                let statusBadge = '';
                if (item.isDir) {
                    statusBadge = `<span class="browser-status-na" aria-label="Not applicable">—</span>`;
                } else if (item.isPinned) {
                    statusBadge = `<span class="badge-status badge-pinned"><span class="material-symbols-outlined icon-sm">push_pin</span> Pinned</span>`;
                } else if (item.isCached) {
                    statusBadge = `<span class="badge-status badge-cached"><span class="material-symbols-outlined icon-sm">cloud_done</span> Locally Cached</span>`;
                } else {
                    statusBadge = `<span class="badge-status badge-virtual"><span class="material-symbols-outlined icon-sm">cloud</span> Cloud Only</span>`;
                }

                const sizeDisplay = item.isDir ? '--' : formatBytes(item.size);

                let actions = `<div class="browser-actions">`;
                if (!item.isDir && item.nodeUid) {
                    if (!item.isCached) {
                        actions += `<button type="button" class="btn btn-sm btn-primary" data-action="hydrate-browser-item" data-encoded-value="${encodedUid}"><span class="material-symbols-outlined icon-sm">download</span> Download</button>`;
                    } else if (IS_FOD) {
                        actions += `<button type="button" class="btn btn-sm" data-action="evict-browser-item" data-encoded-value="${encodedUid}"><span class="material-symbols-outlined icon-sm">delete_sweep</span> Free Space</button>`;
                    }
                    if (item.isPinned) {
                        actions += `<button type="button" class="btn btn-sm" data-action="pin-browser-item" data-encoded-value="${encodedUid}"><span class="material-symbols-outlined text-warning icon-sm">push_pin</span> Unpin</button>`;
                    } else {
                        actions += `<button type="button" class="btn btn-sm" data-action="pin-browser-item" data-encoded-value="${encodedUid}"><span class="material-symbols-outlined icon-sm">push_pin</span> Pin</button>`;
                    }
                }
                actions += `<button type="button" class="btn btn-sm" data-action="open-browser-item" data-encoded-value="${encodedPath}"><span class="material-symbols-outlined icon-sm">open_in_new</span> Open</button>`;
                actions += `</div>`;

                html += `<tr class="${item.isDir ? 'browser-directory-row' : ''}">
                    <td class="browser-name-cell">${nameDisplay}</td>
                    <td class="browser-status-cell">${statusBadge}</td>
                    <td class="browser-size-cell">${sizeDisplay}</td>
                    <td class="browser-actions-cell">${actions}</td>
                </tr>`;
            });

            tbody.innerHTML = html;
        }

        function hydrateBrowserItem(nodeUid) {
            fetch('/api/fod/hydrate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nodeUid }),
            })
                .then(r => r.json())
                .then(res => {
                    if (res.ok) {
                        refreshBrowser();
                    } else {
                        showToast('Download failed: ' + (res.error || 'Unknown error'), 'danger');
                    }
                })
                .catch(err => showToast('Download failed: ' + err.message, 'danger'));
        }

        function evictBrowserItem(nodeUid) {
            fetch('/api/evict', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nodeUid }),
            })
                .then(r => r.json())
                .then(res => {
                    if (res.ok) {
                        refreshBrowser();
                    } else {
                        showToast('Could not free local space: ' + (res.error || 'Unknown error'), 'danger');
                    }
                })
                .catch(err => showToast('Could not free local space: ' + err.message, 'danger'));
        }

        function pinBrowserItem(nodeUid) {
            fetch('/api/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nodeUid }),
            })
                .then(r => r.json())
                .then(res => {
                    if (res.ok) {
                        refreshBrowser();
                    } else {
                        showToast('Pin update failed: ' + (res.error || 'Unknown error'), 'danger');
                    }
                })
                .catch(err => showToast('Pin update failed: ' + err.message, 'danger'));
        }

        function openBrowserItem(relPath) {
            fetch('/api/browser/open-item', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ relPath }),
            })
                .then(r => r.json())
                .then(res => {
                    if (!res.ok) {
                        showToast('Failed to open: ' + (res.error || 'Unknown error'), 'danger');
                    }
                })
                .catch(err => showToast('Failed to open: ' + err.message, 'danger'));
        }

        window.navigateToBrowserPath = navigateToBrowserPath;
        window.refreshBrowser = refreshBrowser;
        window.filterBrowserItems = filterBrowserItems;
        window.hydrateBrowserItem = hydrateBrowserItem;
        window.evictBrowserItem = evictBrowserItem;
        window.pinBrowserItem = pinBrowserItem;
        window.openBrowserItem = openBrowserItem;

        function formatBytes(bytes) {
            const value = Number(bytes);
            if (!Number.isFinite(value) || value <= 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.min(sizes.length - 1, Math.floor(Math.log(value) / Math.log(k)));
            return parseFloat((value / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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
                    const name      = escapeHtml(t.filePath || t.localPath || 'file');
                    const isUpload  = t.type === 'upload';
                    const dirLabel  = isUpload ? 'upload' : 'download';
                    const ringClass = isUpload ? 'upload-ring' : 'download-ring';
                    const percent   = t.percent || 0;
                    const offset    = +(ringCirc * (1 - percent / 100)).toFixed(2);
                    const sizeTxt   = t.size > 0 ? `${formatBytes(t.transferred)} / ${formatBytes(t.size)}` : '';
                    return `<tr class="transfer-active-row">
                        <td class="time-col">${new Date().toLocaleString()}</td>
                        <td class="log-direction ${isUpload ? 'direction-upload' : 'direction-download'}">${dirLabel}</td>
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
                    ? '<tr><td colspan="4" class="log-empty-cell"><div class="empty-state"><span class="material-symbols-outlined empty-icon">cloud_off</span><span class="empty-title">No recent sync activity</span><span class="empty-desc">Proton Drive is scanning your files. Activity logs will appear here as changes are detected.</span></div></td></tr>'
                    : '<tr><td colspan="4" class="log-empty-cell"><div class="empty-state"><span class="material-symbols-outlined empty-icon">search_off</span><span class="empty-title">No matches found</span><span class="empty-desc">Try adjusting your search query or filters.</span></div></td></tr>';
                return;
            }

            const visibleLogs = filtered.slice(0, visibleLogsCount);
            let html = activeRows.join('') + visibleLogs.map(l => {
                const time        = new Date(l.timestamp).toLocaleString();
                const action      = escapeHtml(l.direction.replace('_', ' '));
                const statusClass = 'status-' + String(l.status || '').replace(/[^a-z0-9_-]/gi, '');
                const path        = escapeHtml(l.file_path);
                const msg         = l.message ? `<span class="log-message">${escapeHtml(l.message)}</span>` : '';
                return `<tr>
                    <td class="time-col">${time}</td>
                    <td class="log-direction ${l.direction.startsWith('up') ? 'direction-upload' : 'direction-download'}">${action}</td>
                    <td><span class="log-status ${statusClass}">${escapeHtml(l.status)}</span></td>
                    <td><strong class="file-path-text">${path}</strong>${msg}</td>
                </tr>`;
            }).join('');

            if (filtered.length > visibleLogsCount) {
                html += `<tr>
                    <td colspan="4" class="load-more-cell">
                        <button type="button" class="btn btn-load-more" data-action="load-more-logs">
                            <span class="material-symbols-outlined icon-load-more">expand_more</span>
                            Show More (showing ${visibleLogsCount} of ${filtered.length})
                        </button>
                    </td>
                </tr>`;
            }

            body.innerHTML = html;
        }

        function renderStatus(data) {
            // Check auth state to show login page or main dashboard
            const appLayout = document.querySelector('.app-layout');
            const loginView = document.getElementById('loginView');
            if (data.status === 'auth_required') {
                if (appLayout) appLayout.classList.add('hidden');
                if (loginView) loginView.classList.add('is-visible-flex');
            } else {
                if (appLayout) appLayout.classList.remove('hidden');
                if (loginView) loginView.classList.remove('is-visible-flex');
            }

            // Status badge in topbar & Dashboard Hero
            const badge = document.getElementById('statusBadge');
            const text = document.getElementById('statusText');
            badge.className = 'status-badge status-' + data.status;
            text.innerText = data.status.replace('_', ' ');

            const currentMode = data.mode || (FOD_MODE ? 'fuse' : 'full');
            const isFuseMode = currentMode === 'fuse';
            const network = data.network || {};
            const networkState = network.state || (data.status === 'offline' ? 'offline' : 'starting');
            const uploadBps = Number(network.uploadBps) || 0;
            const downloadBps = Number(network.downloadBps) || 0;
            const totalBps = uploadBps + downloadBps;
            const queued = Number(network.queuedTransfers) || 0;
            const activeCount = Number(network.activeTransfers) || (data.activeTransfers || []).length;
            const pendingOperations = Number(data.pendingOperations) || 0;
            const pendingEvents = Number(data.pendingEvents) || 0;
            const durableCount = pendingOperations + pendingEvents;
            document.getElementById('networkState').innerText = networkState.replace('_', ' ');
            document.getElementById('networkState').className =
                networkState === 'online' ? 'text-success'
                    : networkState === 'offline' ? 'text-danger'
                    : 'text-warning';
            const retrySeconds = network.retryAfter
                ? Math.max(0, Math.ceil((Number(network.retryAfter) - Date.now()) / 1000))
                : 0;
            document.getElementById('networkDetail').innerText = retrySeconds > 0
                ? `Rate limited; retrying in ${retrySeconds}s`
                : `${Number(network.effectiveFileTransfers) || 0} adaptive file slots`;
            document.getElementById('throughputValue').innerText = `${formatBytes(totalBps)}/s`;
            document.getElementById('queueDepth').innerText = String(queued);
            document.getElementById('queueDetail').innerText =
                `${activeCount} active · ${queued} queued`;
            document.getElementById('durablePending').innerText = String(durableCount);
            document.getElementById('durableDetail').innerText = durableCount > 0
                ? `${pendingOperations} local · ${pendingEvents} remote events`
                : 'All changes committed';
            const firstTransfer = (data.activeTransfers || [])[0];
            if (firstTransfer && totalBps > 0 && Number(firstTransfer.size) > 0) {
                const remaining = Math.max(
                    0,
                    Number(firstTransfer.size) - Number(firstTransfer.transferred || 0),
                );
                const seconds = Math.ceil(remaining / totalBps);
                document.getElementById('transferEta').innerText =
                    `${formatBytes(uploadBps)} up · ${formatBytes(downloadBps)} down · ETA ${formatDuration(seconds)}`;
            } else {
                document.getElementById('transferEta').innerText =
                    `${formatBytes(uploadBps)} up · ${formatBytes(downloadBps)} down`;
            }

            // Highlight active mode card in Settings
            const cardFull = document.getElementById('cardModeFull');
            const cardFuse = document.getElementById('cardModeFuse');

            if (cardFull && cardFuse) {
                if (isFuseMode) {
                    cardFuse.classList.add('active');
                    cardFull.classList.remove('active');
                } else {
                    cardFull.classList.add('active');
                    cardFuse.classList.remove('active');
                }
                cardFuse.setAttribute('aria-checked', String(isFuseMode));
                cardFull.setAttribute('aria-checked', String(!isFuseMode));
            }

            const maxSpeedInput = document.getElementById('maxSpeedInput');
            if (maxSpeedInput && data.maxSpeedKbps !== undefined && document.activeElement !== maxSpeedInput) {
                maxSpeedInput.value = data.maxSpeedKbps ?? 0;
                updateSpeedPresetButtons(data.maxSpeedKbps ?? 0);
            }
            const concurrencyInput = document.getElementById('concurrencyInput');
            const concurrencyRange = document.getElementById('concurrencyRange');
            const concurrencySaveBtn = document.getElementById('concurrencySaveBtn');
            const activeNetworkProfile =
                data.networkProfile || (data.wifiSafeMode ? 'safe' : 'custom');
            const isSafeProfile = activeNetworkProfile === 'safe';
            updateNetworkProfileButtons(activeNetworkProfile);
            if (concurrencyInput) concurrencyInput.disabled = isSafeProfile;
            if (concurrencyRange) concurrencyRange.disabled = isSafeProfile;
            if (concurrencySaveBtn) concurrencySaveBtn.disabled = isSafeProfile;
            if (isSafeProfile) {
                concurrencyDraft = undefined;
                applyConcurrencyValue(1);
            } else if (data.concurrencyLimit !== undefined && concurrencyDraft === undefined) {
                applyConcurrencyValue(data.concurrencyLimit ?? 2);
            }

            // Sync action button visibility per mode
            const pauseBtn = document.getElementById('btnPause');
            const syncNowBtn = document.getElementById('syncNowBtn');
            if (pauseBtn) pauseBtn.classList.remove('hidden');
            if (syncNowBtn) syncNowBtn.classList.remove('hidden');

            // Update status description and icon in hero card
            const heroTitle = document.getElementById('syncStateTitle');
            const heroDesc  = document.getElementById('syncStateDesc');
            const heroIcon  = document.getElementById('syncStatusIcon');

            // Bulk deletion warning card visibility
            const warningCard = document.getElementById('bulkDeletionWarningCard');
            const warningDesc = document.getElementById('bulkDeletionWarningDesc');
            if (data.status === 'bulk_deletion_warning') {
                warningCard.classList.remove('hidden');
                if (data.bulkDeletionCount > 0) {
                    warningDesc.innerText = `The sync engine detected that ${data.bulkDeletionCount} local files were deleted. Synchronization has been paused to protect your remote files in the cloud from being deleted.`;
                } else {
                    warningDesc.innerText = `The sync engine detected that your local sync folder was emptied. Synchronization has been paused to protect your remote files in the cloud from being deleted.`;
                }
            } else {
                warningCard.classList.add('hidden');
            }

            // Inject the Material Symbol icon
            heroIcon.innerHTML = getMascotIcon(data.status);

            if (data.status === 'synced' && (!data.activeTransfers || data.activeTransfers.length === 0)) {
                heroTitle.innerText = isFuseMode ? 'FUSE Filesystem Active' : 'Your files are up to date';
                heroDesc.innerText  = isFuseMode ? `Files are mounted at ${data.mountPoint || '~/P-Drive-FUSE'}. Accessing any file downloads it transparently on-demand.` : 'Proton Drive is actively monitoring your sync folder.';
            } else if (data.status === 'syncing' || (data.activeTransfers && data.activeTransfers.length > 0)) {
                const active = (data.activeTransfers && data.activeTransfers[0]) || {};
                const name = active.filePath || active.localPath || 'file';
                const actionLabel = active.type === 'upload' ? 'Uploading' : 'Downloading';
                heroTitle.innerText = isFuseMode ? `FUSE: ${actionLabel} ${name}...` : 'Syncing your changes...';
                heroDesc.innerText  = active.percent !== undefined ? `${actionLabel} ${name} — ${active.percent}% complete` : 'Uploading/downloading files to keep your drive in sync.';
            } else if (data.status === 'bulk_deletion_warning') {
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
                    syncActions.classList.add('hidden');
                    authActions.classList.remove('hidden');
                } else {
                    syncActions.classList.remove('hidden');
                    authActions.classList.add('hidden');
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
                const userEmailEl = document.getElementById('userEmail');
                const settingsUserEmailEl = document.getElementById('settingsUserEmail');
                if (userEmailEl) userEmailEl.innerText = data.email;
                if (settingsUserEmailEl) settingsUserEmailEl.innerText = data.email;

                const userStatus = document.getElementById('userStatus');
                const settingsUserStatus = document.getElementById('settingsUserStatus');
                const avatarLetter = document.getElementById('avatarLetter');
                const settingsAvatar = document.getElementById('settingsAvatar');

                if (data.email && data.email !== 'Not Logged In') {
                    const letter = data.email[0].toUpperCase();
                    if (avatarLetter) avatarLetter.innerText = letter;
                    if (settingsAvatar) settingsAvatar.innerText = letter;

                    if (userStatus) { userStatus.innerText = 'Connected'; userStatus.classList.remove('is-disconnected'); }
                    if (settingsUserStatus) { settingsUserStatus.innerText = 'Connected'; settingsUserStatus.classList.remove('is-disconnected'); }
                } else {
                    if (avatarLetter) avatarLetter.innerText = '?';
                    if (settingsAvatar) settingsAvatar.innerText = '?';

                    if (userStatus) { userStatus.innerText = 'Disconnected'; userStatus.classList.add('is-disconnected'); }
                    if (settingsUserStatus) { settingsUserStatus.innerText = 'Disconnected'; settingsUserStatus.classList.add('is-disconnected'); }
                }
            }

            // Active transfers — store and re-render log table so they appear as pinned rows
            cachedActiveTransfers = data.activeTransfers || [];
            renderLogs();

            // Both Full Sync and FUSE expose the same pause/resume controls.
            isPaused = Boolean(data.isPaused || data.status === 'paused');
            const btn = document.getElementById('btnPause');
            if (btn) {
                btn.className = isPaused ? 'btn btn-primary' : 'btn';
                btn.innerText = isPaused ? 'Resume Sync' : 'Pause Sync';
                btn.setAttribute('aria-pressed', String(isPaused));
                btn.setAttribute('aria-label', isPaused ? 'Resume synchronization' : 'Pause synchronization');
                btn.disabled = false;
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

        function formatDuration(seconds) {
            if (!Number.isFinite(seconds) || seconds <= 0) return 'less than a minute';
            if (seconds < 60) return `${seconds}s`;
            const minutes = Math.floor(seconds / 60);
            const remainder = seconds % 60;
            return `${minutes}m ${remainder}s`;
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
                document.getElementById('quotaBar').value             = Math.max(0, Math.min(100, Number(data.percent) || 0));
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

        async function togglePause() {
            const endpoint = isPaused ? '/api/resume' : '/api/pause';
            const btn = document.getElementById('btnPause');
            if (btn) {
                btn.disabled = true;
                btn.innerText = isPaused ? 'Resuming...' : 'Pausing...';
            }
            try {
                const response = await fetch(endpoint, { method: 'POST' });
                const result = await response.json();
                if (!response.ok || !result.ok) {
                    throw new Error(result.error || `Request failed (${response.status})`);
                }
            } catch (err) {
                console.error('Failed to change pause state:', err);
                showToast(`Could not ${isPaused ? 'resume' : 'pause'} sync: ${err.message}`, 'danger');
            } finally {
                await fetchStatus();
            }
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
            if (!pathVal || !pathVal.trim()) {
                showToast('Please enter a valid sync folder path', 'danger');
                return;
            }
            try {
                const res = await fetch('/api/set-path', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: pathVal })
                });
                if (res.ok) {
                    showToast('Sync folder path updated successfully!', 'success');
                    fetchStatus();
                } else {
                    const data = await res.json();
                    showToast('Error: ' + data.error, 'danger');
                }
            } catch (err) {
                showToast('Request failed: ' + err.message, 'danger');
            }
        }

        async function logout() {
            if (confirm('Are you sure you want to log out from Proton Drive?')) {
                await fetch('/api/logout', { method: 'POST' });
                showToast('Logged out successfully.', 'info');
                setTimeout(() => location.reload(), 1000);
            }
        }

        async function stopDaemon() {
            if (!confirm('Stop the sync daemon? This dashboard will disconnect. Restart it manually with ./drive.sh start')) return;
            try { 
                await fetch('/api/daemon/stop', { method: 'POST' });
                showToast('Daemon service stopping...', 'info');
            } catch {}
        }

        async function restartDaemon() {
            if (!confirm('Restart the sync daemon? This dashboard will briefly disconnect then reconnect.')) return;
            try { 
                await fetch('/api/daemon/restart', { method: 'POST' });
                showToast('Restarting daemon service...', 'info');
            } catch {}
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
                    showToast('Proton Drive login page opened in browser. Please sign in there.', 'info', 6000);
                } else {
                    showToast('Failed to start login: ' + (result.error || 'Unknown error'), 'danger');
                    btns.forEach(btn => {
                        btn.innerText = 'Login to Proton Drive';
                        btn.disabled = false;
                    });
                    isLoggingIn = false;
                }
            } catch (err) {
                showToast('Network error trying to start login: ' + err.message, 'danger');
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
        setInterval(fetchLogs, 5000);
        setInterval(fetchQuota, 30000);

        window.switchSyncMode = async function(targetMode) {
            if (!confirm(`Switch synchronization mode to ${targetMode.toUpperCase()}?\n\nThe daemon will restart in the selected mode.`)) return;
            try {
                const res = await fetch('/api/set-mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: targetMode })
                });
                const data = await res.json();
                if (data.ok) {
                    showToast(data.message || `Switched sync mode to ${targetMode.toUpperCase()}`, 'success');
                    setTimeout(() => { location.reload(); }, 1500);
                } else {
                    showToast('Error switching mode: ' + (data.error || 'Unknown error'), 'danger');
                }
            } catch (err) {
                showToast('Network error switching mode: ' + err.message, 'danger');
            }
        };

        window.setNetworkProfile = async function(profile) {
            const profileButtons = Array.from(document.querySelectorAll('.network-profile-btn'));
            profileButtons.forEach(btn => { btn.disabled = true; });
            try {
                const res = await fetch('/api/set-network-profile', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profile })
                });
                const data = await res.json();
                if (!res.ok || !data.ok) {
                    throw new Error(data.error || `Request failed (${res.status})`);
                }
                concurrencyDraft = undefined;
                updateNetworkProfileButtons(data.networkProfile || profile);
                await fetchStatus();
                const labels = { safe: 'Wi-Fi Safe', balanced: 'Balanced', performance: 'Performance' };
                showToast(`${labels[profile] || profile} network profile enabled`, 'success');
            } catch (err) {
                showToast('Could not change network profile: ' + err.message, 'danger');
                await fetchStatus();
            } finally {
                profileButtons.forEach(btn => { btn.disabled = false; });
            }
        };

        window.saveMaxSpeed = async function() {
            const input = document.getElementById('maxSpeedInput');
            const val = parseInt(input ? input.value : '0', 10);
            if (isNaN(val) || val < 0) return showToast('Invalid speed limit value', 'danger');
            try {
                const res = await fetch('/api/set-speed-limit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ maxSpeedKbps: val })
                });
                const data = await res.json();
                if (data.ok) {
                    const savedValue = data.maxSpeedKbps ?? val;
                    input.value = String(savedValue);
                    updateSpeedPresetButtons(savedValue);
                    showToast(`Speed limit set to ${savedValue === 0 ? 'Unlimited' : savedValue + ' KB/s'}`, 'success');
                } else {
                    showToast('Error: ' + (data.error || 'Failed to update speed limit'), 'danger');
                }
            } catch (err) {
                showToast('Network error: ' + err.message, 'danger');
            }
        };

        window.saveConcurrency = async function() {
            const input = document.getElementById('concurrencyInput');
            const saveBtn = document.getElementById('concurrencySaveBtn');
            const rawValue = concurrencyDraft !== undefined ? concurrencyDraft : (input ? input.value : '2');
            const val = Number(rawValue);
            if (isNaN(val) || val < 1 || val > 5) return showToast('Concurrency limit must be between 1 and 5', 'danger');
            if (!Number.isInteger(val)) return showToast('Concurrency limit must be a whole number', 'danger');
            if (saveBtn) saveBtn.disabled = true;
            try {
                const res = await fetch('/api/set-concurrency', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ concurrency: val })
                });
                const data = await res.json();
                if (data.ok) {
                    const savedValue = data.concurrency ?? val;
                    concurrencyDraft = undefined;
                    applyConcurrencyValue(savedValue);
                    updateNetworkProfileButtons(data.networkProfile || 'custom');
                    showToast(`Parallel transfers limit set to ${savedValue}`, 'success');
                } else {
                    showToast('Error: ' + (data.error || 'Failed to update concurrency limit'), 'danger');
                }
            } catch (err) {
                showToast('Network error: ' + err.message, 'danger');
            } finally {
                if (saveBtn) saveBtn.disabled = false;
            }
        };

        // Explicitly attach all HTML onclick action handlers to window
        window.showToast = showToast;
        window.setSpeedPreset = setSpeedPreset;
        window.updateConcurrencyInput = updateConcurrencyInput;
        window.updateConcurrencyRange = updateConcurrencyRange;
        window.togglePause = togglePause;
        window.forceSync = forceSync;
        window.openFolder = openFolder;
        window.savePath = savePath;
        window.logout = logout;
        window.stopDaemon = stopDaemon;
        window.restartDaemon = restartDaemon;
        window.confirmBulkDeletions = confirmBulkDeletions;
        window.restoreBulkDeletions = restoreBulkDeletions;
        window.login = login;
        window.toggleTheme = toggleTheme;
        window.toggleSidebar = toggleSidebar;
        window.showTab = showTab;
        window.filterLogs = filterLogs;
        window.setLogFilter = setLogFilter;
        window.filterBrowserItems = filterBrowserItems;
        window.navigateToBrowserPath = navigateToBrowserPath;
        window.refreshBrowser = refreshBrowser;
        window.hydrateBrowserItem = hydrateBrowserItem;
        window.pinBrowserItem = pinBrowserItem;
        window.evictBrowserItem = evictBrowserItem;
        window.openBrowserItem = openBrowserItem;

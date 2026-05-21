/* ═══════════════════════════════════════════════════════════
   Ninox DB Diagnostics — Frontend Application
   ═══════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ──────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────
    const state = {
        status: null,               // {logged_in, user, proxy, expires}
        hosts: [],                  // [{name, labels}]
        hostsFilterText: '',
        hostsCachedAt: null,
        selectedHost: null,         // string
        databases: {},              // accountId -> [dbId, ...]
        accountsMetadata: {},       // accountId -> {name, emails: []}
        selectedDb: null,           // {accountId, dbId, path}
        loadingDbs: false,
        playbooks: [],
        selectedPlaybook: null,     // playbook object
        running: false,
        runProgress: [],            // [{name, status, duration, output}]
        report: null,               // final result from run_complete
    };

    let statusPollTimer = null;
    let dropdownOpen = false;

    // ──────────────────────────────────────────────
    // DOM references
    // ──────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    const els = {
        statusDot: $('status-dot'),
        statusLabel: $('status-label'),
        statusUser: $('status-user'),
        statusProxy: $('status-proxy'),
        statusExpiry: $('status-expiry'),
        statusSep1: $('status-separator'),
        statusSep2: $('status-separator-2'),
        statusInfo: $('status-info'),

        hostSearchInput: $('host-search-input'),
        hostDropdown: $('host-dropdown'),
        hostCount: $('host-count'),
        hostSkeleton: $('host-skeleton'),
        cacheTimestamp: $('cache-timestamp'),
        btnRefreshHosts: $('btn-refresh-hosts'),

        dbTreeContainer: $('db-tree-container'),
        dbTree: $('db-tree'),
        dbSkeleton: $('db-skeleton'),
        dbTreeTitle: $('db-tree-title'),

        playbookList: $('playbook-list'),
        playbookSkeleton: $('playbook-skeleton'),

        configHostValue: $('config-host-value'),
        configDbValue: $('config-db-value'),
        configPlaybookValue: $('config-playbook-value'),

        runBtn: $('run-btn'),
        runBtnText: $('run-btn-text'),
        runBtnSpinner: $('run-btn-spinner'),
        runBtnIcon: document.querySelector('.run-btn-icon'),

        progressSection: $('progress-section'),
        globalLoadingBadge: $('global-loading-badge'),
        progressSteps: $('progress-steps'),

        reportSection: $('report-section'),
        severityHeader: $('severity-header'),
        severityIcon: $('severity-icon'),
        severityText: $('severity-text'),
        reportSummary: $('report-summary'),
        reportReasoning: $('report-reasoning'),
        reportErrors: $('report-errors'),
        reportSteps: $('report-steps'),
        reportSavePath: $('report-save-path'),
        savePathValue: $('save-path-value'),

        btnCopyMarkdown: $('btn-copy-markdown'),
        btnSaveReport: $('btn-save-report'),
        btnRunAgain: $('btn-run-again'),
        btnCopyPath: $('btn-copy-path'),

        modalOverlay: $('modal-overlay'),
        confirmTitle: $('confirm-title'),
        confirmMessage: $('confirm-message'),
        btnConfirmCancel: $('btn-confirm-cancel'),
        btnConfirmProceed: $('btn-confirm-proceed'),

        toastContainer: $('toast-container'),
        footerText: $('footer-text'),
    };


    // ──────────────────────────────────────────────
    // Utilities
    // ──────────────────────────────────────────────

    function createElement(tag, attrs, children) {
        const el = document.createElement(tag);
        if (attrs) {
            for (const [key, val] of Object.entries(attrs)) {
                if (key === 'className') {
                    el.className = val;
                } else if (key === 'dataset') {
                    for (const [dk, dv] of Object.entries(val)) {
                        el.dataset[dk] = dv;
                    }
                } else if (key.startsWith('on')) {
                    el.addEventListener(key.slice(2).toLowerCase(), val);
                } else {
                    el.setAttribute(key, val);
                }
            }
        }
        if (children) {
            if (typeof children === 'string') {
                el.textContent = children;
            } else if (Array.isArray(children)) {
                children.forEach(child => {
                    if (child) el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
                });
            } else {
                el.appendChild(children);
            }
        }
        return el;
    }

    function svgIcon(pathD, extraClass) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        if (extraClass) svg.setAttribute('class', extraClass);
        // pathD can be an array of path strings or a single string
        const paths = Array.isArray(pathD) ? pathD : [pathD];
        paths.forEach(d => {
            if (d.startsWith('<')) {
                // Raw SVG element string — parse it
                const temp = document.createElementNS(ns, 'g');
                const wrapper = document.createElement('div');
                wrapper.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg">' + d + '</svg>';
                const parsed = wrapper.querySelector('svg');
                while (parsed.firstChild) {
                    svg.appendChild(parsed.firstChild);
                }
            } else {
                const path = document.createElementNS(ns, 'path');
                path.setAttribute('d', d);
                svg.appendChild(path);
            }
        });
        return svg;
    }

    function showToast(message, type) {
        type = type || 'info';
        const iconPaths = {
            success: 'M20 6L9 17l-5-5',
            error: ['M18 6L6 18', 'M6 6l12 12'],
            info: ['<circle cx="12" cy="12" r="10"/>', '<line x1="12" y1="16" x2="12" y2="12"/>', '<line x1="12" y1="8" x2="12.01" y2="8"/>'],
        };

        const toast = createElement('div', { className: 'toast toast-' + type }, [
            svgIcon(iconPaths[type] || iconPaths.info, 'toast-icon'),
            createElement('span', {}, message),
        ]);

        els.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    function formatDuration(seconds) {
        if (seconds == null) return '';
        if (seconds < 1) return (seconds * 1000).toFixed(0) + 'ms';
        if (seconds < 60) return seconds.toFixed(1) + 's';
        const m = Math.floor(seconds / 60);
        const s = (seconds % 60).toFixed(0);
        return m + 'm ' + s + 's';
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }


    // ──────────────────────────────────────────────
    // Simple Markdown → HTML renderer
    // ──────────────────────────────────────────────

    function renderMarkdown(md) {
        if (!md) return '';
        const lines = md.split('\n');
        let html = '';
        let inCodeBlock = false;
        let codeBlockContent = '';
        let inList = false;
        let listType = '';
        let inTable = false;
        let tableRows = [];

        function flushList() {
            if (inList) {
                html += '</' + listType + '>';
                inList = false;
            }
        }

        function flushTable() {
            if (inTable && tableRows.length > 0) {
                html += '<table>';
                tableRows.forEach((row, idx) => {
                    // Skip separator row (e.g. |---|---|)
                    if (/^\|[\s\-:|]+\|$/.test(row.trim())) return;
                    const tag = idx === 0 ? 'th' : 'td';
                    const rowTag = idx === 0 ? 'thead' : (idx === 1 ? 'tbody' : '');
                    const cells = row.split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
                    if (idx === 0) html += '<thead>';
                    if (idx === 1) html += '</thead><tbody>';
                    // Adjust: if second row is separator, skip it
                    html += '<tr>';
                    cells.forEach(cell => {
                        html += '<' + tag + '>' + inlineMarkdown(cell.trim()) + '</' + tag + '>';
                    });
                    html += '</tr>';
                });
                if (tableRows.length > 1) html += '</tbody>';
                html += '</table>';
                tableRows = [];
                inTable = false;
            }
        }

        function inlineMarkdown(text) {
            // Code inline
            text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
            // Bold
            text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            // Italic
            text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
            return text;
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Code blocks
            if (line.trimStart().startsWith('```')) {
                if (inCodeBlock) {
                    html += '<pre><code>' + escapeHtml(codeBlockContent) + '</code></pre>';
                    codeBlockContent = '';
                    inCodeBlock = false;
                } else {
                    flushList();
                    flushTable();
                    inCodeBlock = true;
                }
                continue;
            }

            if (inCodeBlock) {
                codeBlockContent += (codeBlockContent ? '\n' : '') + line;
                continue;
            }

            // Blank line
            if (line.trim() === '') {
                flushList();
                flushTable();
                continue;
            }

            // HR
            if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim())) {
                flushList();
                flushTable();
                html += '<hr>';
                continue;
            }

            // Table
            if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
                flushList();
                if (!inTable) inTable = true;
                tableRows.push(line);
                continue;
            } else {
                flushTable();
            }

            // Headings
            const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
            if (headingMatch) {
                flushList();
                const level = headingMatch[1].length;
                html += '<h' + level + '>' + inlineMarkdown(headingMatch[2]) + '</h' + level + '>';
                continue;
            }

            // Unordered list
            if (/^[-*]\s+/.test(line.trim())) {
                if (!inList || listType !== 'ul') {
                    flushList();
                    html += '<ul>';
                    inList = true;
                    listType = 'ul';
                }
                html += '<li>' + inlineMarkdown(line.trim().replace(/^[-*]\s+/, '')) + '</li>';
                continue;
            }

            // Ordered list
            if (/^\d+\.\s+/.test(line.trim())) {
                if (!inList || listType !== 'ol') {
                    flushList();
                    html += '<ol>';
                    inList = true;
                    listType = 'ol';
                }
                html += '<li>' + inlineMarkdown(line.trim().replace(/^\d+\.\s+/, '')) + '</li>';
                continue;
            }

            // Paragraph
            flushList();
            html += '<p>' + inlineMarkdown(line) + '</p>';
        }

        // Flush remaining
        if (inCodeBlock) {
            html += '<pre><code>' + escapeHtml(codeBlockContent) + '</code></pre>';
        }
        flushList();
        flushTable();

        return html;
    }


    // ──────────────────────────────────────────────
    // API calls
    // ──────────────────────────────────────────────

    async function apiFetch(url, options) {
        try {
            const resp = await fetch(url, options);
            if (!resp.ok) {
                const text = await resp.text();
                throw new Error(text || 'HTTP ' + resp.status);
            }
            return await resp.json();
        } catch (err) {
            throw err;
        }
    }

    // ──────────────────────────────────────────────
    // Status
    // ──────────────────────────────────────────────

    async function checkStatus() {
        try {
            const data = await apiFetch('/api/status');
            state.status = data;
            renderStatus();

            if (data.logged_in && state.hosts.length === 0) {
                loadHosts(false);
            }
        } catch (err) {
            state.status = null;
            els.statusDot.className = 'status-dot error';
            els.statusLabel.textContent = 'Connection error';
            console.error('Status check failed:', err);
        }
    }

    function renderStatus() {
        const s = state.status;
        if (!s) return;

        if (s.logged_in) {
            els.statusDot.className = 'status-dot connected';
            els.statusLabel.textContent = 'Connected via Teleport';

            if (s.user) {
                els.statusUser.textContent = s.user;
                els.statusSep1.style.display = '';
            }
            if (s.proxy) {
                els.statusProxy.textContent = s.proxy;
                els.statusSep2.style.display = '';
            }
            if (s.expires) {
                const exp = new Date(s.expires);
                const now = new Date();
                const diffMin = Math.round((exp - now) / 60000);
                if (diffMin > 0) {
                    els.statusExpiry.textContent = 'Expires in ' + (diffMin > 60 ? Math.round(diffMin / 60) + 'h' : diffMin + 'min');
                } else {
                    els.statusExpiry.textContent = 'Expired';
                }
            }
        } else {
            els.statusDot.className = 'status-dot disconnected';
            els.statusLabel.textContent = 'Not connected — run tsh login';
            els.statusUser.textContent = '';
            els.statusProxy.textContent = '';
            els.statusExpiry.textContent = '';
            els.statusSep1.style.display = 'none';
            els.statusSep2.style.display = 'none';
        }
    }

    function startStatusPolling() {
        if (statusPollTimer) clearInterval(statusPollTimer);
        statusPollTimer = setInterval(checkStatus, 60000);
    }


    // ──────────────────────────────────────────────
    // Hosts
    // ──────────────────────────────────────────────

    async function loadHosts(refresh) {
        els.hostSkeleton.style.display = '';
        els.btnRefreshHosts.classList.add('spinning');

        try {
            const data = await apiFetch('/api/hosts?refresh=' + (refresh ? 'true' : 'false'));
            state.hosts = data.hosts || [];
            state.hostsCachedAt = data.cached_at;
            renderHostCount();
            renderCacheTimestamp();
            // If there's a filter, apply it
            filterHosts();
        } catch (err) {
            showToast('Failed to load hosts: ' + err.message, 'error');
        } finally {
            els.hostSkeleton.style.display = 'none';
            els.btnRefreshHosts.classList.remove('spinning');
        }
    }

    function renderHostCount() {
        els.hostCount.textContent = state.hosts.length > 0 ? state.hosts.length + ' hosts' : '';
    }

    function renderCacheTimestamp() {
        if (state.hostsCachedAt) {
            const d = new Date(state.hostsCachedAt);
            els.cacheTimestamp.textContent = 'Cached: ' + d.toLocaleTimeString();
        } else {
            els.cacheTimestamp.textContent = '';
        }
    }

    function filterHosts() {
        const query = state.hostsFilterText.toLowerCase().trim();
        const filtered = query
            ? state.hosts.filter(h => h.name.toLowerCase().includes(query))
            : state.hosts;

        const toShow = filtered.slice(0, 50);
        renderHostDropdown(toShow, filtered.length);
    }

    function renderHostDropdown(items, totalCount) {
        els.hostDropdown.innerHTML = '';

        if (items.length === 0 && state.hostsFilterText) {
            const empty = createElement('div', { className: 'host-dropdown-empty' }, 'No hosts match "' + state.hostsFilterText + '"');
            els.hostDropdown.appendChild(empty);
            openDropdown();
            return;
        }

        if (items.length === 0) {
            closeDropdown();
            return;
        }

        items.forEach(host => {
            const isSelected = state.selectedHost === host.name;
            const item = createElement('div', {
                className: 'host-dropdown-item' + (isSelected ? ' selected' : ''),
                dataset: { host: host.name },
                onClick: () => selectHost(host.name),
            }, [
                createElement('span', { className: 'host-name' }, host.name),
            ]);
            els.hostDropdown.appendChild(item);
        });

        if (totalCount > 50) {
            const more = createElement('div', { className: 'host-dropdown-empty' },
                'Showing 50 of ' + totalCount + ' matches');
            els.hostDropdown.appendChild(more);
        }

        openDropdown();
    }

    function openDropdown() {
        els.hostDropdown.classList.add('open');
        dropdownOpen = true;
    }

    function closeDropdown() {
        els.hostDropdown.classList.remove('open');
        dropdownOpen = false;
    }

    function selectHost(hostname) {
        state.selectedHost = hostname;
        els.hostSearchInput.value = hostname;
        state.hostsFilterText = hostname;
        closeDropdown();
        updateConfigSummary();
        // Reset DB selection
        state.databases = {};
        state.selectedDb = null;
        state.dbSizes = {};
        updateConfigSummary();
        updateRunButton();
        loadDatabases(hostname);
        
        // Auto-fetch lightweight health (fast, safe for any host)
        loadHostDashboard(hostname);
    }

    async function loadHostDashboard(host) {
        const dash = document.getElementById('host-dashboard');
        const loading = document.getElementById('dash-loading');

        if (dash) dash.style.display = 'block';
        if (loading) loading.style.display = 'inline-block';

        document.getElementById('dash-status').textContent = '-';
        document.getElementById('dash-version').textContent = '-';
        document.getElementById('dash-disk').textContent = '-';
        document.getElementById('dash-uptime').textContent = '-';
        document.getElementById('dash-memory').textContent = '-';
        document.getElementById('dash-logs').textContent = '';
        
        try {
            const data = await apiFetch('/api/host/dashboard?host=' + encodeURIComponent(host));
            document.getElementById('dash-status').textContent = data.nxdb_status || '-';
            document.getElementById('dash-version').textContent = data.nxdb_version || '-';
            document.getElementById('dash-disk').textContent = data.disk_usage || '-';
            document.getElementById('dash-uptime').textContent = data.uptime || '-';
            document.getElementById('dash-memory').textContent = data.memory || '-';
            document.getElementById('dash-logs').textContent = data.logs || '';
        } catch (err) {
            console.error(err);
            document.getElementById('dash-status').textContent = 'Error';
        } finally {
            if (loading) loading.style.display = 'none';
        }
    }

    async function scanStorageSizes() {
        if (!state.selectedHost) return;
        
        const scanBtn = document.getElementById('btn-scan-storage');
        const scanText = document.getElementById('btn-scan-storage-text');
        
        if (scanBtn) {
            scanBtn.disabled = true;
            scanBtn.style.opacity = '0.6';
            scanBtn.style.cursor = 'not-allowed';
        }
        if (scanText) scanText.textContent = 'Scanning...';
        
        try {
            const data = await apiFetch('/api/host/storage?host=' + encodeURIComponent(state.selectedHost));
            state.dbSizes = data.db_sizes || {};
            
            if (data.timed_out) {
                showToast('Storage scan timed out — partial results shown', 'warning');
            } else {
                const count = Object.keys(state.dbSizes).length;
                showToast('Storage scan complete — ' + count + ' databases measured', 'success');
            }
            
            // Re-render db tree to show sizes
            if (Object.keys(state.databases).length > 0) {
                renderDbTree();
            }
            
            if (scanText) scanText.textContent = 'Rescan Storage';
        } catch (err) {
            console.error(err);
            showToast('Storage scan failed: ' + err.message, 'error');
            if (scanText) scanText.textContent = 'Scan Storage Sizes';
        } finally {
            if (scanBtn) {
                scanBtn.disabled = false;
                scanBtn.style.opacity = '1';
                scanBtn.style.cursor = 'pointer';
            }
        }
    }


    // ──────────────────────────────────────────────
    // Databases
    // ──────────────────────────────────────────────

    async function loadDatabases(host) {
        state.loadingDbs = true;
        els.dbTreeContainer.style.display = '';
        els.dbSkeleton.style.display = '';
        els.dbTree.innerHTML = '';
        els.dbTreeTitle.textContent = 'Databases on ' + host;
        
        // Reset storage scan button and warning
        const scanBtn = document.getElementById('btn-scan-storage');
        const scanText = document.getElementById('btn-scan-storage-text');
        const storageWarning = document.getElementById('storage-warning');
        if (scanBtn) { scanBtn.style.display = 'none'; }
        if (storageWarning) { storageWarning.style.display = 'none'; }
        if (scanText) { scanText.textContent = 'Scan Storage Sizes'; }
        state.dbSizes = {};

        try {
            const data = await apiFetch('/api/dbs?host=' + encodeURIComponent(host));
            state.databases = data.accounts || {};
            state.accountsMetadata = data.metadata || {};
            renderDbTree();
            
            // Show scan storage button after databases load
            const accountCount = Object.keys(state.databases).length;
            if (scanBtn && accountCount > 0) {
                scanBtn.style.display = 'inline-block';
            }
            
            // Show warning for large hosts (20+ accounts — likely public cloud)
            if (storageWarning && accountCount >= 20) {
                storageWarning.style.display = 'block';
            }
        } catch (err) {
            showToast('Failed to load databases: ' + err.message, 'error');
            els.dbTree.innerHTML = '';
        } finally {
            state.loadingDbs = false;
            els.dbSkeleton.style.display = 'none';
        }
    }

    function renderDbTree() {
        els.dbTree.innerHTML = '';
        const accounts = Object.keys(state.databases).sort();

        if (accounts.length === 0) {
            els.dbTree.appendChild(
                createElement('div', { className: 'host-dropdown-empty' }, 'No databases found')
            );
            return;
        }

        accounts.forEach(accountId => {
            const dbs = state.databases[accountId];
            const group = createElement('div', { className: 'db-account-group' });
            const meta = state.accountsMetadata[accountId];

            // Header
            const labelText = meta && meta.name && meta.name !== 'Unknown' 
                ? `${meta.name} (${accountId})` 
                : `Account ${accountId}`;

            const header = createElement('div', {
                className: 'db-account-header',
                onClick: () => toggleAccountGroup(header, listEl),
            }, [
                createChevronSvg(),
                createElement('span', { className: 'db-account-label', title: accountId }, labelText),
                createElement('span', { className: 'db-account-count' }, String(dbs.length)),
            ]);

            // DB list
            const listEl = createElement('div', { className: 'db-list' });

            // Display workspace user emails if available
            if (meta && meta.emails && meta.emails.length > 0) {
                const usersContainer = createElement('div', { className: 'db-account-users' });
                usersContainer.appendChild(createElement('div', { className: 'db-account-users-title' }, 'Workspace Users'));
                
                const emailsList = createElement('ul', { className: 'db-account-users-list' });
                meta.emails.forEach(email => {
                    emailsList.appendChild(createElement('li', { className: 'db-account-user-item', title: email }, email));
                });
                usersContainer.appendChild(emailsList);
                listEl.appendChild(usersContainer);
            }

            dbs.forEach(dbId => {
                const fullPath = '/var/nxdb/accounts/' + accountId + '/db/' + dbId + '/data';
                const displayPath = accountId + '/' + dbId;
                
                const item = createElement('div', {
                    className: 'db-item',
                    onClick: () => selectDb(accountId, dbId, fullPath, displayPath, item),
                });
                
                item.appendChild(createDbIcon());
                
                const nameSpan = createElement('span', { className: 'db-item-name' }, dbId);
                item.appendChild(nameSpan);
                
                // Show size if available
                const key = accountId + '/' + dbId;
                if (state.dbSizes && state.dbSizes[key]) {
                    const sizeBadge = createElement('span', { 
                        style: 'font-size: 0.65rem; color: var(--text-muted); background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; margin-left: auto;' 
                     }, state.dbSizes[key]);
                    item.appendChild(sizeBadge);
                }
                
                listEl.appendChild(item);
            });

            group.appendChild(header);
            group.appendChild(listEl);
            els.dbTree.appendChild(group);
        });

        // Auto-expand first account if only one
        if (accounts.length === 1) {
            const firstHeader = els.dbTree.querySelector('.db-account-header');
            const firstList = els.dbTree.querySelector('.db-list');
            if (firstHeader && firstList) {
                firstHeader.classList.add('expanded');
                firstList.classList.add('open');
            }
        }
    }

    function createChevronSvg() {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'db-account-chevron');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const path = document.createElementNS(ns, 'polyline');
        path.setAttribute('points', '9 18 15 12 9 6');
        svg.appendChild(path);
        return svg;
    }

    function createDbIcon() {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'db-item-icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const ellipse = document.createElementNS(ns, 'ellipse');
        ellipse.setAttribute('cx', '12');
        ellipse.setAttribute('cy', '5');
        ellipse.setAttribute('rx', '9');
        ellipse.setAttribute('ry', '3');
        svg.appendChild(ellipse);
        const p1 = document.createElementNS(ns, 'path');
        p1.setAttribute('d', 'M21 12c0 1.66-4 3-9 3s-9-1.34-9-3');
        svg.appendChild(p1);
        const p2 = document.createElementNS(ns, 'path');
        p2.setAttribute('d', 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5');
        svg.appendChild(p2);
        return svg;
    }

    function toggleAccountGroup(header, listEl) {
        header.classList.toggle('expanded');
        listEl.classList.toggle('open');
    }

    function selectDb(accountId, dbId, fullPath, displayPath, itemEl) {
        // Deselect previous
        const prev = els.dbTree.querySelector('.db-item.selected');
        if (prev) prev.classList.remove('selected');

        itemEl.classList.add('selected');
        state.selectedDb = { accountId, dbId, path: fullPath, displayPath: displayPath };
        updateConfigSummary();
        updateRunButton();
    }


    // ──────────────────────────────────────────────
    // Playbooks
    // ──────────────────────────────────────────────

    async function loadPlaybooks() {
        try {
            const data = await apiFetch('/api/playbooks');
            state.playbooks = data.playbooks || [];
            renderPlaybooks();
        } catch (err) {
            showToast('Failed to load playbooks: ' + err.message, 'error');
        }
    }

    function renderPlaybooks() {
        const container = els.playbookList;
        // Remove skeleton
        const skel = els.playbookSkeleton;
        if (skel) skel.remove();

        container.innerHTML = '';

        if (state.playbooks.length === 0) {
            container.appendChild(
                createElement('div', { className: 'host-dropdown-empty' }, 'No playbooks available')
            );
            return;
        }

        state.playbooks.forEach((pb, idx) => {
            const card = createElement('div', {
                className: 'playbook-card',
                id: 'playbook-card-' + idx,
                dataset: { index: String(idx) },
                onClick: () => selectPlaybook(pb, idx),
            });

            // Top row
            const top = createElement('div', { className: 'playbook-card-top' });

            const label = createElement('span', { className: 'playbook-label' });
            label.textContent = pb.label || pb.id || 'Playbook';

            // Warning icon for confirm playbooks
            if (pb.confirm) {
                const warnSvg = svgIcon([
                    'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
                    '<line x1="12" y1="9" x2="12" y2="13"/>',
                    '<line x1="12" y1="17" x2="12.01" y2="17"/>',
                ], 'playbook-warning-icon');
                label.appendChild(warnSvg);
            }

            const radio = createElement('div', { className: 'playbook-radio' }, [
                createElement('div', { className: 'playbook-radio-dot' }),
            ]);

            top.appendChild(label);
            top.appendChild(radio);
            card.appendChild(top);

            // Description
            if (pb.description) {
                card.appendChild(
                    createElement('p', { className: 'playbook-description' }, pb.description)
                );
            }

            // Time badge
            if (pb.estimated_seconds) {
                const badge = createElement('span', { className: 'time-badge' });
                const clockSvg = svgIcon([
                    '<circle cx="12" cy="12" r="10"/>',
                    '<polyline points="12 6 12 12 16 14"/>',
                ], '');
                clockSvg.style.width = '10px';
                clockSvg.style.height = '10px';
                badge.appendChild(clockSvg);
                const timeText = pb.estimated_seconds >= 60
                    ? '~' + Math.round(pb.estimated_seconds / 60) + 'min'
                    : '~' + pb.estimated_seconds + 's';
                badge.appendChild(document.createTextNode(' ' + timeText));
                card.appendChild(badge);
            }

            container.appendChild(card);
        });
    }

    function selectPlaybook(pb, idx) {
        state.selectedPlaybook = pb;
        document.querySelectorAll('.playbook-card').forEach((card, i) => {
            card.classList.toggle('selected', i === idx);
        });

        updateConfigSummary();
        updateRunButton();
    }


    // ──────────────────────────────────────────────
    // Config summary & Run button
    // ──────────────────────────────────────────────

    function updateConfigSummary() {
        const hv = els.configHostValue;
        const dv = els.configDbValue;
        const pv = els.configPlaybookValue;

        hv.textContent = state.selectedHost || 'Not selected';
        hv.classList.toggle('active', !!state.selectedHost);

        dv.textContent = state.selectedDb ? state.selectedDb.displayPath : 'Not selected';
        dv.classList.toggle('active', !!state.selectedDb);
        dv.style.opacity = '1';

        pv.textContent = state.selectedPlaybook ? (state.selectedPlaybook.label || state.selectedPlaybook.id) : 'Not selected';
        pv.classList.toggle('active', !!state.selectedPlaybook);
    }

    function updateRunButton() {
        const ready = !!(state.selectedHost && state.selectedDb && state.selectedPlaybook) && !state.running;
        els.runBtn.disabled = !ready;
    }


    // ──────────────────────────────────────────────
    // Run execution
    // ──────────────────────────────────────────────

    function startRun() {
        const pb = state.selectedPlaybook;
        if (pb && pb.confirm) {
            showConfirmDialog(pb);
            return;
        }
        executeRun();
    }

    function showConfirmDialog(pb) {
        els.confirmTitle.textContent = 'Confirm: ' + (pb.label || pb.id);
        els.confirmMessage.textContent = (pb.description || 'This playbook requires confirmation.') +
            ' This may take longer than usual. Are you sure you want to continue?';
        els.modalOverlay.style.display = '';
    }

    function hideConfirmDialog() {
        els.modalOverlay.style.display = 'none';
    }

    async function executeRun() {
        hideConfirmDialog();

        state.running = true;
        state.runProgress = [];
        state.report = null;

        // UI updates
        els.runBtn.classList.add('running');
        els.runBtn.disabled = true;
        els.runBtnText.textContent = 'Running…';
        els.runBtnSpinner.style.display = '';
        if (els.runBtnIcon) els.runBtnIcon.style.display = 'none';

        els.progressSection.style.display = '';
        if (els.globalLoadingBadge) els.globalLoadingBadge.style.display = 'flex';
        els.progressSteps.innerHTML = '';
        els.reportSection.style.display = 'none';

        const body = JSON.stringify({
            host: state.selectedHost,
            db_path: state.selectedDb.path,
            playbook_id: state.selectedPlaybook.id,
        });

        try {
            const response = await fetch('/api/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body,
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(errText || 'HTTP ' + response.status);
            }

            await readSSEStream(response);
        } catch (err) {
            showToast('Run failed: ' + err.message, 'error');
        } finally {
            state.running = false;
            els.runBtn.classList.remove('running');
            els.runBtnText.textContent = 'Run Diagnostic';
            els.runBtnSpinner.style.display = 'none';
            if (els.runBtnIcon) els.runBtnIcon.style.display = '';
            if (els.globalLoadingBadge) els.globalLoadingBadge.style.display = 'none';
            updateRunButton();
        }
    }

    async function readSSEStream(response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE events
            const parts = buffer.split('\n\n');
            buffer = parts.pop(); // keep incomplete part

            for (const part of parts) {
                processSSEEvent(part);
            }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
            processSSEEvent(buffer);
        }
    }

    function processSSEEvent(eventStr) {
        let eventType = '';
        let dataStr = '';

        const lines = eventStr.split('\n');
        for (const line of lines) {
            if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                dataStr += line.slice(5).trim();
            }
        }

        if (!eventType || !dataStr) return;

        let data;
        try {
            data = JSON.parse(dataStr);
        } catch (e) {
            console.warn('Failed to parse SSE data:', dataStr);
            return;
        }

        switch (eventType) {
            case 'step_start':
                handleStepStart(data);
                break;
            case 'step_complete':
                handleStepComplete(data);
                break;
            case 'step_error':
                handleStepError(data);
                break;
            case 'run_complete':
                handleRunComplete(data);
                break;
        }
    }

    function handleStepStart(data) {
        state.runProgress.push({
            name: data.name,
            status: 'running',
            duration: null,
            output: null,
            command: data.command,
        });
        renderProgressStep(state.runProgress.length - 1, 'running', data.name, data.command);
    }

    function handleStepComplete(data) {
        const idx = data.step_index;
        if (state.runProgress[idx]) {
            state.runProgress[idx].status = data.status || 'ok';
            state.runProgress[idx].duration = data.duration_s;
            state.runProgress[idx].output = data.output;
            state.runProgress[idx].parsed = data.parsed;
        }
        updateProgressStep(idx, data.status || 'ok', data.duration_s);
    }

    function handleStepError(data) {
        const idx = data.step_index;
        if (state.runProgress[idx]) {
            state.runProgress[idx].status = 'error';
            state.runProgress[idx].duration = data.duration_s;
            state.runProgress[idx].output = data.error;
        }
        updateProgressStep(idx, 'error', data.duration_s);
    }

    function handleRunComplete(data) {
        state.report = data;
        renderReport(data);
    }


    // ──────────────────────────────────────────────
    // Progress rendering
    // ──────────────────────────────────────────────

    function renderProgressStep(idx, status, name, command) {
        const titleWrap = createElement('div', { className: 'progress-step-title-wrap', style: 'flex: 1; display: flex; flex-direction: column; gap: 0.2rem;' });
        titleWrap.appendChild(createElement('span', { className: 'progress-step-name' }, name));
        if (command) {
            titleWrap.appendChild(createElement('span', { style: 'font-family: var(--font-mono); font-size: 0.65rem; color: var(--text-muted); opacity: 0.8;' }, command));
        }

        const step = createElement('div', {
            className: 'progress-step ' + status,
            id: 'progress-step-' + idx,
        }, [
            createElement('div', { className: 'progress-step-icon' }, [
                createStepIcon(status),
            ]),
            titleWrap,
            createElement('span', { className: 'progress-step-duration' }),
        ]);
        els.progressSteps.appendChild(step);
    }

    function updateProgressStep(idx, status, duration) {
        const step = $('progress-step-' + idx);
        if (!step) return;

        const cssStatus = (status === 'ok' || status === 'success') ? 'completed' : status;
        step.className = 'progress-step ' + cssStatus;

        // Update icon
        const iconWrap = step.querySelector('.progress-step-icon');
        iconWrap.innerHTML = '';
        iconWrap.appendChild(createStepIcon(cssStatus));

        // Update duration
        const durEl = step.querySelector('.progress-step-duration');
        if (durEl && duration != null) {
            durEl.textContent = formatDuration(duration);
        }
    }

    function createStepIcon(status) {
        if (status === 'running') {
            return createElement('div', { className: 'progress-step-spinner' });
        }
        if (status === 'completed' || status === 'ok') {
            return svgIcon('M20 6L9 17l-5-5', 'progress-step-check');
        }
        if (status === 'error') {
            return svgIcon(['M18 6L6 18', 'M6 6l12 12'], 'progress-step-error');
        }
        return createElement('div', {});
    }


    // ──────────────────────────────────────────────
    // Report rendering
    // ──────────────────────────────────────────────

    function renderReport(data) {
        els.reportSection.style.display = '';

        // Severity header — backend sends green/amber/red
        const severity = (data.severity || 'green').toLowerCase();
        els.severityHeader.className = 'severity-header severity-' + severity;

        const severityConfig = {
            green:  { icon: '✓', text: 'All Checks Passed' },
            amber:  { icon: '⚠', text: 'Warnings Detected' },
            red:    { icon: '✕', text: 'Critical Issues Found' },
        };
        const sc = severityConfig[severity] || severityConfig.green;
        els.severityIcon.textContent = sc.icon;
        els.severityText.textContent = sc.text;

        // Summary
        if (data.summary) {
            els.reportSummary.style.display = '';
            els.reportSummary.textContent = data.summary;
        } else {
            els.reportSummary.style.display = 'none';
        }

        // Reasoning
        if (data.reasoning) {
            els.reportReasoning.style.display = '';
            els.reportReasoning.textContent = data.reasoning;
        } else {
            els.reportReasoning.style.display = 'none';
        }

        // Errors
        if (data.errors && data.errors.length > 0) {
            els.reportErrors.style.display = '';
            els.reportErrors.innerHTML = '';
            data.errors.forEach(err => {
                els.reportErrors.appendChild(
                    createElement('div', { className: 'report-error-item' }, err)
                );
            });
        } else {
            els.reportErrors.style.display = 'none';
        }

        // Step results
        els.reportSteps.innerHTML = '';
        const steps = data.steps || state.runProgress;
        steps.forEach((step, idx) => {
            const stepEl = createElement('div', {
                className: 'report-step',
                id: 'report-step-' + idx,
            });

            const stepStatus = step.status || 'ok';

            // Header
            const header = createElement('div', {
                className: 'report-step-header',
                onClick: () => toggleReportStep(stepEl),
            }, [
                createReportStepStatusIcon(stepStatus),
                createElement('div', { style: 'flex: 1; display: flex; flex-direction: column; gap: 0.15rem;' }, [
                    createElement('span', { className: 'report-step-name' }, step.name),
                    step.command ? createElement('span', { style: 'font-family: var(--font-mono); font-size: 0.65rem; color: var(--text-muted); opacity: 0.8;' }, step.command) : null
                ]),
                createElement('span', { className: 'report-step-duration' },
                    step.duration_s != null ? formatDuration(step.duration_s) :
                    step.duration != null ? formatDuration(step.duration) : ''),
                createChevronSvg2(),
            ]);

            // Body
            const body = createElement('div', { className: 'report-step-body' });

            const output = step.output || step.error || '';

            // Check if this is a full_report playbook — render markdown
            if (state.selectedPlaybook && state.selectedPlaybook.id === 'full_report' && output) {
                const rendered = createElement('div', { className: 'report-step-rendered' });
                rendered.innerHTML = renderMarkdown(output);
                body.appendChild(rendered);
            } else if (output) {
                const outputEl = createElement('pre', { className: 'report-step-output' });
                outputEl.textContent = output;
                body.appendChild(outputEl);
            }

            stepEl.appendChild(header);
            stepEl.appendChild(body);
            els.reportSteps.appendChild(stepEl);
        });

        // Report save path
        if (data.report_dir) {
            els.reportSavePath.style.display = '';
            els.savePathValue.textContent = data.report_dir;
            els.footerText.textContent = 'Report saved to: ' + data.report_dir;
        }
    }

    function createReportStepStatusIcon(status) {
        const statusClass = status === 'ok' || status === 'completed' || status === 'success' ? 'ok'
            : status === 'warning' ? 'warning' : 'error';

        if (statusClass === 'ok') {
            return svgIcon('M20 6L9 17l-5-5', 'report-step-status-icon ok');
        }
        if (statusClass === 'warning') {
            return svgIcon([
                'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
                '<line x1="12" y1="9" x2="12" y2="13"/>',
                '<line x1="12" y1="17" x2="12.01" y2="17"/>',
            ], 'report-step-status-icon warning');
        }
        return svgIcon(['M18 6L6 18', 'M6 6l12 12'], 'report-step-status-icon error');
    }

    function createChevronSvg2() {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'report-step-chevron');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const path = document.createElementNS(ns, 'polyline');
        path.setAttribute('points', '9 18 15 12 9 6');
        svg.appendChild(path);
        return svg;
    }

    function toggleReportStep(stepEl) {
        stepEl.classList.toggle('expanded');
    }


    // ──────────────────────────────────────────────
    // Report actions
    // ──────────────────────────────────────────────

    function copyReportAsMarkdown() {
        if (!state.report) return;

        let md = '# Diagnostic Report\n\n';
        md += '**Host:** ' + (state.selectedHost || 'N/A') + '\n';
        md += '**Database:** ' + (state.selectedDb ? state.selectedDb.path : 'N/A') + '\n';
        md += '**Playbook:** ' + (state.selectedPlaybook ? (state.selectedPlaybook.label || state.selectedPlaybook.id) : 'N/A') + '\n';
        md += '**Severity:** ' + (state.report.severity || 'ok') + '\n\n';

        if (state.report.summary) {
            md += '## Summary\n\n' + state.report.summary + '\n\n';
        }
        
        if (state.report.reasoning) {
            md += '**Reasoning:** ' + state.report.reasoning + '\n\n';
        }

        if (state.report.errors && state.report.errors.length > 0) {
            md += '## Errors\n\n';
            state.report.errors.forEach(err => {
                md += '- ✕ ' + err + '\n';
            });
            md += '\n';
        }

        const steps = state.report.steps || state.runProgress;
        if (steps.length > 0) {
            md += '## Steps\n\n';
            steps.forEach(step => {
                const dur = step.duration_s != null ? step.duration_s : step.duration;
                md += '### ' + step.name + (dur != null ? ' (' + formatDuration(dur) + ')' : '') + '\n';
                if (step.command) {
                    md += '**Command:** `' + step.command + '`\n';
                }
                md += '**Status:** ' + (step.status || 'ok') + '\n\n';
                const output = step.output || step.error || '';
                if (output) {
                    md += '```\n' + output + '\n```\n\n';
                }
            });
        }

        navigator.clipboard.writeText(md).then(() => {
            showToast('Report copied to clipboard', 'success');
        }).catch(() => {
            showToast('Failed to copy to clipboard', 'error');
        });
    }

    function showSaveReportPath() {
        if (state.report && state.report.report_dir) {
            navigator.clipboard.writeText(state.report.report_dir).then(() => {
                showToast('Report path copied to clipboard', 'success');
            }).catch(() => {
                showToast('Failed to copy path', 'error');
            });
        } else {
            showToast('No report directory available', 'info');
        }
    }

    function runAgain() {
        if (state.selectedHost && state.selectedDb && state.selectedPlaybook) {
            startRun();
        }
    }


    // ──────────────────────────────────────────────
    // Event listeners
    // ──────────────────────────────────────────────

    function setupEventListeners() {
        // Host search input
        els.hostSearchInput.addEventListener('input', (e) => {
            state.hostsFilterText = e.target.value;
            filterHosts();
        });

        els.hostSearchInput.addEventListener('focus', () => {
            if (state.hosts.length > 0) {
                filterHosts();
            }
        });

        // Close dropdown on outside click
        document.addEventListener('click', (e) => {
            const container = $('host-search-container');
            if (!container.contains(e.target)) {
                closeDropdown();
            }
        });

        // Escape to close dropdown / modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeDropdown();
                hideConfirmDialog();
            }
        });

        // Refresh hosts
        els.btnRefreshHosts.addEventListener('click', () => {
            loadHosts(true);
        });

        // Scan storage sizes button
        const scanBtn = document.getElementById('btn-scan-storage');
        if (scanBtn) {
            scanBtn.addEventListener('click', () => {
                if (state.selectedHost) {
                    scanStorageSizes();
                } else {
                    showToast('Please select a host first', 'warning');
                }
            });
        }

        // Run button
        els.runBtn.addEventListener('click', startRun);

        // Confirm dialog
        els.btnConfirmCancel.addEventListener('click', hideConfirmDialog);
        els.btnConfirmProceed.addEventListener('click', executeRun);
        els.modalOverlay.addEventListener('click', (e) => {
            if (e.target === els.modalOverlay) hideConfirmDialog();
        });

        // Report actions
        els.btnCopyMarkdown.addEventListener('click', copyReportAsMarkdown);
        els.btnSaveReport.addEventListener('click', showSaveReportPath);
        els.btnRunAgain.addEventListener('click', runAgain);

        // Copy path button
        els.btnCopyPath.addEventListener('click', () => {
            const path = els.savePathValue.textContent;
            if (path) {
                navigator.clipboard.writeText(path).then(() => {
                    showToast('Path copied to clipboard', 'success');
                }).catch(() => {
                    showToast('Failed to copy path', 'error');
                });
            }
        });
    }


    // ──────────────────────────────────────────────
    // Updater
    // ──────────────────────────────────────────────
    
    async function checkForUpdates() {
        try {
            const res = await apiFetch('/api/update/check');
            if (res && res.current_version) {
                const badge = document.getElementById('version-badge');
                if (badge) {
                    badge.textContent = res.current_version;
                }
            }
            if (res && res.update_available) {
                const container = document.getElementById('update-container');
                const btn = document.getElementById('btn-update-app');
                const verSpan = document.getElementById('update-version');
                
                if (container && btn && verSpan) {
                    verSpan.textContent = res.latest_version;
                    container.style.display = '';
                    
                    btn.onclick = async () => {
                        const modal = document.getElementById('update-modal');
                        if (modal) modal.style.display = 'flex';
                        
                        try {
                            const installRes = await fetch('/api/update/install', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ download_url: res.download_url })
                            });
                            if (!installRes.ok) throw new Error('Update failed');
                            // The backend will restart the app. We can just wait a bit.
                            setTimeout(() => {
                                window.location.reload();
                            }, 5000);
                        } catch (err) {
                            if (modal) modal.style.display = 'none';
                            showToast('Failed to trigger update: ' + err.message, 'error');
                        }
                    };
                }
            }
        } catch (e) {
            console.error('Update check failed', e);
        }
    }


    // ──────────────────────────────────────────────
    // Initialize
    // ──────────────────────────────────────────────

    function init() {
        setupEventListeners();
        checkStatus();
        loadPlaybooks();
        checkForUpdates();
        
        // Init logs modal button
        const logsBtn = document.getElementById('view-logs-btn');
        if (logsBtn) {
            logsBtn.onclick = () => {
                const modal = document.getElementById('logs-modal');
                if (modal) {
                    modal.style.display = 'flex';
                    modal.style.alignItems = 'center';
                    modal.style.justifyContent = 'center';
                }
            };
        }
        startStatusPolling();
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

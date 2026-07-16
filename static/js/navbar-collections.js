// Dynamically load collections into navbar dropdown

// Global (not inside the IIFE below) so the inline onerror="" attribute on the
// nav avatar <img> can reach it — swaps a failed-to-load avatar image for the
// same initial-letter badge used when there's no avatar_url at all.
window.__navAvatarError = function(imgEl) {
    const initial = imgEl.getAttribute('data-fallback-initial') || '?';
    const span = document.createElement('span');
    span.style.cssText = 'width:22px;height:22px;border-radius:50%;background:var(--primary-color);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;flex-shrink:0;';
    span.textContent = initial;
    imgEl.replaceWith(span);
};

(function() {
    async function loadCollections() {
        const dropdown = document.getElementById('collectionsDropdown');
        if (!dropdown) return;

        try {
            const res = await fetch('/api/collections');
            const data = await res.json();
            
            if (!data || !data.collections || typeof data.collections !== 'object') {
                dropdown.innerHTML = '<div class="navbar-dropdown-item" style="color: var(--muted-text); cursor: default;">No collections found</div>';
                return;
            }

            const collections = Object.keys(data.collections).filter(key => key !== 'root');
            
            if (collections.length === 0) {
                dropdown.innerHTML = '<div class="navbar-dropdown-item" style="color: var(--muted-text); cursor: default;">No collections found</div>';
                return;
            }

            // Sort collections alphabetically
            collections.sort((a, b) => a.localeCompare(b));

            // Generate dropdown items
            dropdown.innerHTML = collections.map(name => {
                const iconClass = getCollectionIcon(name);
                const imageCount = data.collections[name].length;
                return `<a href="/collection/${name}" class="navbar-dropdown-item">
                    <i class="${iconClass}"></i> ${name} 
                    <span style="opacity: 0.6; font-size: 0.85em;">(${imageCount})</span>
                </a>`;
            }).join('');
            
        } catch (err) {
            dropdown.innerHTML = '<div class="navbar-dropdown-item" style="color: var(--muted-text); cursor: default;">Error loading collections</div>';
        }
    }

    function getCollectionIcon(name) {
        // Provide appropriate icons based on collection name
        const nameLower = name.toLowerCase();
        if (nameLower.includes('real') || nameLower.includes('photo')) return 'fas fa-camera';
        if (nameLower.includes('ai') || nameLower.includes('generated')) return 'fas fa-robot';
        if (nameLower.includes('nature') || nameLower.includes('landscape')) return 'fas fa-tree';
        if (nameLower.includes('art')) return 'fas fa-palette';
        if (nameLower.includes('game')) return 'fas fa-gamepad';
        return 'fas fa-folder';
    }

    async function loadUserNav() {
        const menu = document.querySelector('.navbar-menu');
        if (!menu) return;
        try {
            const res = await fetch('/api/auth/me');
            const d = await res.json();

            // Remove any existing user-nav element
            document.getElementById('user-nav-item')?.remove();

            const el = document.createElement('div');
            el.id = 'user-nav-item';

            if (d.authenticated) {
                // One compact "Account" dropdown instead of separate admin/avatar/logout
                // items — same navbar-dropdown pattern as "View Collections" — so the
                // authenticated cluster never balloons into 3-4 extra top-level items.
                el.className = 'navbar-dropdown';
                const initial = d.username.charAt(0).toUpperCase();
                // Google's avatar URL can fail to load client-side (ad-blockers/privacy
                // extensions commonly block googleusercontent.com, expired sessions, etc.)
                // even though the URL itself is valid — fall back to the initial-letter
                // badge instead of showing a broken-image icon.
                const avatar = d.avatar_url
                    ? `<img src="${d.avatar_url}" data-fallback-initial="${initial}" style="width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0;" alt="" onerror="window.__navAvatarError(this)">`
                    : `<span style="width:22px;height:22px;border-radius:50%;background:var(--primary-color);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;flex-shrink:0;">${initial}</span>`;
                const adminItem = d.is_admin
                    ? `<a href="/admin" class="navbar-dropdown-item"><i class="fas fa-shield-alt"></i> Admin Dashboard</a>`
                    : '';
                el.innerHTML = `
                    <button type="button" class="navbar-link navbar-dropdown-toggle">
                        ${avatar}
                        <span style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.username}</span>
                        <i class="fas fa-caret-down"></i>
                    </button>
                    <div class="navbar-dropdown-menu">
                        ${adminItem}
                        <a href="/logout" class="navbar-dropdown-item"><i class="fas fa-sign-out-alt"></i> Logout</a>
                    </div>`;
            } else {
                el.style.cssText = 'display:flex;align-items:center;';
                el.innerHTML = `<a href="/login" class="navbar-link"><i class="fas fa-sign-in-alt"></i> Sign In</a>`;
            }

            // Insert before theme toggle
            const themeBtn = menu.querySelector('.navbar-theme-toggle');
            if (themeBtn) menu.insertBefore(el, themeBtn);
            else menu.appendChild(el);

            // Start heartbeat for authenticated users
            if (d.authenticated) {
                setInterval(() => fetch('/api/heartbeat', {method:'POST'}), 120000);
                // Piggyback the restricted-access accept-window reminder on the same
                // interval — most pages in this app never open a Socket.IO connection,
                // so this poll (plus an immediate check on load) is the delivery path
                // that actually reaches someone browsing normally, not just the live
                // push a connected admin page might also receive.
                checkRestrictedAccessReminders();
                setInterval(checkRestrictedAccessReminders, 120000);
            }
        } catch (e) { /* silent */ }
    }

    const _shownAccessReminders = new Set();

    function showAccessReadyToast(collection) {
        if (_shownAccessReminders.has(collection)) return;
        _shownAccessReminders.add(collection);
        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:var(--primary-color);'
            + 'color:#fff;padding:.9rem 1.3rem;border-radius:.8rem;box-shadow:0 4px 20px rgba(0,0,0,.25);'
            + 'z-index:9999;font-size:.88rem;max-width:320px;cursor:pointer;';
        toast.innerHTML = `<i class="fas fa-unlock"></i> You can now accept access to <strong>${collection}</strong> — click here (window closes in 10 min)`;
        toast.addEventListener('click', () => { location.href = `/restricted/${collection}`; });
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 30000);
    }

    async function checkRestrictedAccessReminders() {
        try {
            const res = await fetch('/api/restricted-access/my-status');
            const d = await res.json();
            if (d.success && Array.isArray(d.ready)) {
                d.ready.forEach(showAccessReadyToast);
            }
        } catch (e) { /* silent */ }
    }

    // Mobile hamburger menu: collapse the navbar links into a toggleable panel
    function setupMobileNav() {
        const container = document.querySelector('.navbar-container');
        const menu = document.querySelector('.navbar-menu');
        if (!container || !menu) return;

        let toggle = container.querySelector('.navbar-toggle');
        if (!toggle) {
            toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'navbar-toggle';
            toggle.setAttribute('aria-label', 'Toggle navigation menu');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.innerHTML = '<i class="fas fa-bars"></i>';
            container.insertBefore(toggle, menu);
        }

        function closeMenu() {
            menu.classList.remove('is-open');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.innerHTML = '<i class="fas fa-bars"></i>';
            menu.querySelectorAll('.navbar-dropdown.is-open').forEach(d => d.classList.remove('is-open'));
        }

        toggle.addEventListener('click', () => {
            const isOpen = menu.classList.toggle('is-open');
            toggle.setAttribute('aria-expanded', String(isOpen));
            toggle.innerHTML = isOpen ? '<i class="fas fa-times"></i>' : '<i class="fas fa-bars"></i>';
        });

        // Use delegation so dynamically-added links (collections, user nav) work too
        menu.addEventListener('click', (e) => {
            const dropBtn = e.target.closest('.navbar-dropdown-toggle');
            if (dropBtn && window.innerWidth <= 900) {
                e.preventDefault();
                e.stopPropagation();
                dropBtn.closest('.navbar-dropdown').classList.toggle('is-open');
                return;
            }
            if (e.target.closest('a')) {
                closeMenu();
            }
        });

        document.addEventListener('click', (e) => {
            if (menu.classList.contains('is-open') && !container.contains(e.target)) {
                closeMenu();
            }
        });
    }

    // Load collections when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { loadCollections(); loadUserNav(); setupMobileNav(); });
    } else {
        loadCollections();
        loadUserNav();
        setupMobileNav();
    }
})();

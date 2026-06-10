// Dynamically load collections into navbar dropdown
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
            el.style.cssText = 'display:flex;align-items:center;gap:.5rem;';

            if (d.authenticated) {
                const avatar = d.avatar_url
                    ? `<img src="${d.avatar_url}" style="width:26px;height:26px;border-radius:50%;object-fit:cover;" alt="">`
                    : `<span style="width:26px;height:26px;border-radius:50%;background:var(--primary-color);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;">${d.username[0].toUpperCase()}</span>`;
                const adminLink = d.is_admin
                    ? `<a href="/admin" class="navbar-link" title="Admin"><i class="fas fa-shield-alt"></i></a>`
                    : '';
                el.innerHTML = `
                    ${adminLink}
                    <span class="navbar-link" style="cursor:default;gap:.45rem;">
                        ${avatar}
                        <span style="font-size:.85rem;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.username}</span>
                    </span>
                    <a href="/logout" class="navbar-link" title="Logout"><i class="fas fa-sign-out-alt"></i></a>`;
            } else if (d.is_guest) {
                el.innerHTML = `
                    <span class="navbar-link" style="cursor:default;font-size:.85rem;color:var(--muted-text);">
                        <i class="fas fa-user-secret"></i> ${d.username}
                    </span>
                    <a href="/logout" class="navbar-link" title="Sign In"><i class="fas fa-sign-in-alt"></i></a>`;
            } else {
                el.innerHTML = `<a href="/login" class="navbar-link"><i class="fas fa-sign-in-alt"></i> Sign In</a>`;
            }

            // Insert before theme toggle
            const themeBtn = menu.querySelector('.navbar-theme-toggle');
            if (themeBtn) menu.insertBefore(el, themeBtn);
            else menu.appendChild(el);

            // Start heartbeat for authenticated users
            if (d.authenticated) {
                setInterval(() => fetch('/api/heartbeat', {method:'POST'}), 120000);
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

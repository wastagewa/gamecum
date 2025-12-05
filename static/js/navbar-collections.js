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

    // Load collections when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadCollections);
    } else {
        loadCollections();
    }
})();

// home.js - handle creating new collections and loading high scores on the home page
document.addEventListener('DOMContentLoaded', () => {
    const formBtn = document.getElementById('createCollectionBtn');
    const nameInput = document.getElementById('newCollectionName');
    const msg = document.getElementById('createMsg');
    const list = document.getElementById('collectionsList');

    // Game display names
    const gameNames = {
        'memory': '🎮 Memory Game',
        'flashcards': '📸 Flash Cards',
        'hunt': '🔍 Image Hunt',
        'zoom': '🔍 Zoom Challenge',
        'whack': '🔨 Whack-a-Mole',
        'puzzle': '🧩 Puzzle',
        'sequence': '🧠 Sequence'
    };

    function setMsg(text, isError = true) {
        if (!msg) return;
        msg.textContent = text;
        msg.style.color = isError ? '#c0392b' : '#16a085';
    }

    function createCard(name) {
        const wrap = document.createElement('div');
        wrap.className = 'collection-card';
        wrap.style.background = 'var(--surface-color)';
        wrap.style.padding = '14px';
        wrap.style.borderRadius = '14px';
        wrap.style.boxShadow = '0 8px 24px var(--shadow-color)';
        wrap.style.minWidth = '180px';
        wrap.style.border = '1px solid rgba(255,255,255,0.08)';
        wrap.innerHTML = `
            <div style="font-weight:700;color:var(--text-color);">${name}</div>
            <div style="color:var(--muted-text);margin-top:6px;">Images: <strong style="color:var(--text-color);">0</strong></div>
            <div style="color:var(--muted-text);margin-top:4px;">Best: <em>—</em><br><small style="opacity:0;">by —</small></div>
            <div style="margin-top:8px;display:flex;gap:8px;">
                <a class="custom-upload-btn" href="/collection/${encodeURIComponent(name)}">View</a>
                <a class="custom-upload-btn" href="/collection/${encodeURIComponent(name)}/game">Play</a>
            </div>`;
        return wrap;
    }

    // Load high scores for all leaderboard sections
    function loadHighScores() {
        const leaderboardSections = document.querySelectorAll('.leaderboard-section');
        leaderboardSections.forEach(section => {
            const collection = section.getAttribute('data-collection');
            if (!collection) return;
            
            const scoresContainer = document.getElementById(`scores-${collection}`);
            if (!scoresContainer) return;

            // Load scores from API
            fetch(`/api/high-scores/${collection}`)
                .then(res => res.json())
                .then(data => {
                    renderHighScores(collection, data, scoresContainer, section);
                })
                .catch(err => {
                    console.error('Failed to load high scores', err);
                    scoresContainer.innerHTML = '<div class="no-scores"><i class="fas fa-error"></i> Failed to load scores</div>';
                });
        });
    }

    function renderHighScores(collection, data, container, section) {
        // Setup tab buttons
        const tabBtns = section.querySelectorAll('.score-tab-btn');
        const allGames = Object.keys(data);

        if (allGames.length === 0) {
            container.innerHTML = '<div class="no-scores"><i class="fas fa-medal"></i> No scores yet. Be the first champion!</div>';
            return;
        }

        // Handle tab clicks
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const gameType = btn.getAttribute('data-game');
                tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                if (gameType === 'all') {
                    displayAllGameScores(data, container);
                } else {
                    displayGameScores(gameType, data[gameType] || [], container);
                }
            });
        });

        // Show all games by default
        displayAllGameScores(data, container);
    }

    function displayAllGameScores(data, container) {
        let html = '';
        for (const [gameType, entries] of Object.entries(data)) {
            if (!entries || entries.length === 0) continue;
            
            html += `<div class="game-scores-group">
                <div class="game-scores-title">${gameNames[gameType] || gameType}</div>`;
            
            entries.forEach((entry, idx) => {
                html += formatScoreEntry(entry, idx);
            });
            
            html += '</div>';
        }
        
        if (!html) {
            html = '<div class="no-scores"><i class="fas fa-medal"></i> No scores yet. Be the first champion!</div>';
        }
        
        container.innerHTML = html;
    }

    function displayGameScores(gameType, entries, container) {
        if (!entries || entries.length === 0) {
            container.innerHTML = '<div class="no-scores"><i class="fas fa-medal"></i> No scores yet for this game!</div>';
            return;
        }

        let html = '';
        entries.forEach((entry, idx) => {
            html += formatScoreEntry(entry, idx);
        });
        
        container.innerHTML = html;
    }

    function formatScoreEntry(entry, idx) {
        const medals = ['🥇', '🥈', '🥉'];
        const medal = medals[idx] || '•';
        
        let stats = '';
        if (entry.time !== undefined) stats += `${entry.time}s`;
        if (entry.level !== undefined) stats += ` · Lvl ${entry.level}`;
        if (entry.wrong !== undefined) stats += ` · ${entry.wrong}W`;
        
        return `<div class="leaderboard-entry">
            <div class="entry-rank">${medal}</div>
            <div class="entry-left">
                <span class="entry-username">${entry.username}</span>
                ${stats ? `<span class="entry-stats">${stats}</span>` : ''}
            </div>
            <div class="entry-score">${entry.score}</div>
        </div>`;
    }

    if (formBtn && nameInput) {
        formBtn.addEventListener('click', async () => {
            const raw = nameInput.value.trim();
            if (!raw) return setMsg('Collection name required');
            if (!/^[A-Za-z0-9_-]+$/.test(raw)) return setMsg('Invalid characters. Use A-Za-z0-9_- only');
            try {
                formBtn.disabled = true;
                setMsg('Creating...', false);
                const res = await fetch('/create-collection', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: raw })
                });
                const data = await res.json();
                if (data && data.success) {
                    setMsg('Collection created', false);
                    nameInput.value = '';
                    if (list) list.appendChild(createCard(data.name));
                    // Reload high scores after creating new collection
                    setTimeout(loadHighScores, 500);
                } else {
                    setMsg(data.error || 'Failed to create collection');
                }
            } catch (err) {
                console.error('create collection error', err);
                setMsg('Error creating collection');
            } finally { formBtn.disabled = false; }
        });
    }

    // Load high scores on page load
    loadHighScores();
});

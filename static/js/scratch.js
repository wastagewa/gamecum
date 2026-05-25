/**
 * Striptease Scratch Card Game
 * Image hidden under a grid of opaque tiles.
 * Drag to scratch tiles away; click a thumbnail to guess.
 * Correct = score based on tiles remaining; wrong = lose a life (3 lives).
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container     = document.getElementById('scratchContainer');
    const startBtn      = document.getElementById('startScBtn');
    const resetBtn      = document.getElementById('resetScBtn');
    const fullscreenBtn = document.getElementById('fullscreenScBtn');
    const backBtn       = document.getElementById('backScBtn');
    const scoreEl       = document.getElementById('scScore');
    const roundEl       = document.getElementById('scRound');
    const livesEl       = document.getElementById('scLives');
    const tilesLeftEl   = document.getElementById('scTilesLeft');
    const messageEl     = document.getElementById('scMessage');
    const targetImg     = document.getElementById('scTargetImg');
    const gridEl        = document.getElementById('scGrid');
    const optionsEl     = document.getElementById('scOptions');
    const gridSizeSel   = document.getElementById('scGridSize');
    const usernameInput = document.getElementById('scUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];

    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('Scratch: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ── Tile grid ─────────────────────────────────────────────────────────────
    let tiles      = [];   // array of { el, scratched }
    let totalTiles = 0;
    let isDragging = false;
    let answered   = false;

    function buildGrid(n) {
        gridEl.innerHTML = '';
        gridEl.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
        gridEl.style.gridTemplateRows    = `repeat(${n}, 1fr)`;
        tiles      = [];
        totalTiles = n * n;
        for (let i = 0; i < totalTiles; i++) {
            const tile = document.createElement('div');
            tile.className = 'scratch-tile';
            const t = { el: tile, scratched: false };
            tiles.push(t);
            gridEl.appendChild(tile);
        }
        updateTilesLeft();
    }

    function scratchTile(tileObj) {
        if (tileObj.scratched || answered) return;
        tileObj.scratched = true;
        tileObj.el.classList.add('scratched');
        updateTilesLeft();
    }

    function updateTilesLeft() {
        const remaining = countRemaining();
        tilesLeftEl.textContent = `${remaining}/${totalTiles}`;
    }

    function countRemaining() {
        return tiles.filter(t => !t.scratched).length;
    }

    function revealAllTiles() {
        tiles.forEach(t => {
            if (!t.scratched) { t.scratched = true; t.el.classList.add('scratched'); }
        });
        updateTilesLeft();
    }

    // ── Pointer events on grid ────────────────────────────────────────────────
    function getTileObj(e) {
        const touch = e.touches ? e.touches[0] : e;
        const el    = document.elementFromPoint(touch.clientX, touch.clientY);
        if (!el || !el.classList.contains('scratch-tile')) return null;
        return tiles.find(t => t.el === el) || null;
    }

    gridEl.addEventListener('mousedown', (e) => {
        if (answered) return;
        isDragging = true;
        const t = getTileObj(e);
        if (t) scratchTile(t);
    });
    document.addEventListener('mouseup', () => { isDragging = false; });
    gridEl.addEventListener('mouseover', (e) => {
        if (!isDragging || answered) return;
        const t = getTileObj(e);
        if (t) scratchTile(t);
    });
    gridEl.addEventListener('touchstart', (e) => {
        if (answered) return;
        isDragging = true;
        e.preventDefault();
        const t = getTileObj(e);
        if (t) scratchTile(t);
    }, { passive: false });
    gridEl.addEventListener('touchmove', (e) => {
        if (!isDragging || answered) return;
        e.preventDefault();
        const t = getTileObj(e);
        if (t) scratchTile(t);
    }, { passive: false });
    gridEl.addEventListener('touchend', () => { isDragging = false; });

    // ── State ─────────────────────────────────────────────────────────────────
    let state = {
        active:    false,
        score:     0,
        round:     0,
        lives:     3,
        startTime: null,
        targetUrl: null
    };

    function updateLives() {
        const h = ['❤️','❤️','❤️'];
        for (let i = state.lives; i < 3; i++) h[i] = '🖤';
        livesEl.textContent = h.join('');
    }

    // ── Round ─────────────────────────────────────────────────────────────────
    function startRound() {
        if (!state.active) return;

        state.round++;
        roundEl.textContent = state.round;
        answered   = false;
        isDragging = false;

        const n      = parseInt(gridSizeSel.value, 10) || 6;
        const target = allImages[Math.floor(Math.random() * allImages.length)];
        state.targetUrl = target.url;

        // 4 options always
        const others = shuffle(allImages.filter(img => img.url !== target.url));
        const opts   = shuffle([target, ...others.slice(0, 3)]);

        const doStart = () => {
            buildGrid(n);

            optionsEl.innerHTML = '';
            opts.forEach(opt => {
                const card = document.createElement('div');
                card.className = 'scratch-option-card';
                const img = document.createElement('img');
                img.src = opt.url;
                card.appendChild(img);
                card.addEventListener('click', () => {
                    const remaining = countRemaining();
                    handleAnswer(opt.url, card, remaining);
                });
                optionsEl.appendChild(card);
            });

            messageEl.innerHTML = '<p class="scratch-prompt">Scratch to reveal — then click the right image below!</p>';
        };

        targetImg.onload  = doStart;
        targetImg.onerror = doStart;
        targetImg.src = target.url;
        if (targetImg.complete) doStart();
    }

    // ── Answer ────────────────────────────────────────────────────────────────
    function handleAnswer(url, cardEl, remainingAtAnswer) {
        if (!state.active || answered) return;
        answered = true;
        isDragging = false;
        document.querySelectorAll('.scratch-option-card').forEach(c => c.style.pointerEvents = 'none');

        // Reveal all tiles
        revealAllTiles();

        const isCorrect = (url === state.targetUrl);

        if (isCorrect) {
            const points = Math.round((remainingAtAnswer / totalTiles) * 500) + 100;
            state.score += points;
            scoreEl.textContent = state.score;
            cardEl.classList.add('scratch-correct');
            messageEl.innerHTML = `
                <div class="feedback success">
                    <i class="fas fa-check-circle"></i> Correct! <strong>+${points}</strong>
                    ${remainingAtAnswer > 0
                        ? `<span class="streak-bonus">Scratch bonus: ${remainingAtAnswer} tiles left!</span>`
                        : ''}
                </div>`;
            setTimeout(() => { if (state.active) startRound(); }, 1600);
        } else {
            state.lives--;
            updateLives();
            cardEl.classList.add('scratch-wrong');
            document.querySelectorAll('.scratch-option-card').forEach(c => {
                const img = c.querySelector('img');
                if (img) {
                    // Compare normalized URLs
                    const cUrl = decodeURIComponent(img.src).replace(window.location.origin, '');
                    const tUrl = decodeURIComponent(state.targetUrl).replace(window.location.origin, '');
                    if (cUrl === tUrl || img.src === state.targetUrl) {
                        c.classList.add('scratch-correct');
                    }
                }
            });
            messageEl.innerHTML = `<div class="feedback error"><i class="fas fa-times-circle"></i> Wrong!</div>`;
            if (state.lives <= 0) { setTimeout(() => endGame(), 1800); }
            else { setTimeout(() => { if (state.active) startRound(); }, 2000); }
        }
    }

    // ── End ───────────────────────────────────────────────────────────────────
    function endGame() {
        state.active = false;
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        optionsEl.innerHTML = '';
        gridEl.innerHTML    = '';
        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-hand-sparkles"></i>
                <h2>Game Over!</h2>
                <p>Score: <strong>${state.score}</strong></p>
                <p>Rounds: <strong>${state.round}</strong></p>
            </div>`;
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';
        tilesLeftEl.textContent = '—';

        const user = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION, gameType: 'scratch',
                score: state.score, rounds: state.round,
                time: elapsed, username: user
            })
        }).catch(() => {});
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function initGame() {
        if (allImages.length < 2) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 2 images to play!</div>';
            return;
        }
        state = { active: true, score: 0, round: 0, lives: 3,
                  startTime: Date.now(), targetUrl: null };
        scoreEl.textContent     = '0';
        roundEl.textContent     = '0';
        tilesLeftEl.textContent = '—';
        updateLives();
        messageEl.innerHTML    = '';
        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';
        startRound();
    }

    function resetGame() {
        state.active = false;
        answered     = false;
        isDragging   = false;
        targetImg.src = '';
        gridEl.innerHTML    = '';
        optionsEl.innerHTML = '';
        messageEl.innerHTML = '';
        scoreEl.textContent     = '0';
        roundEl.textContent     = '0';
        livesEl.textContent     = '❤️❤️❤️';
        tilesLeftEl.textContent = '—';
        startBtn.style.display  = 'inline-block';
        resetBtn.style.display  = 'none';
    }

    // ── Fullscreen ────────────────────────────────────────────────────────────
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                container.requestFullscreen().catch(e => console.warn('FS error:', e.message));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === container;
            fullscreenBtn.innerHTML = isFS
                ? '<i class="fas fa-compress"></i> Exit Fullscreen'
                : '<i class="fas fa-expand"></i> Fullscreen';
        });
    }

    // ── Wiring ────────────────────────────────────────────────────────────────
    startBtn.addEventListener('click', initGame);
    resetBtn.addEventListener('click', resetGame);
    backBtn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        window.location.href = `/collection/${COLLECTION}`;
    });

    await loadImages();
    if (allImages.length < 2) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:2rem">Need at least 2 images to play!</div>';
        startBtn.disabled = true;
    }
});

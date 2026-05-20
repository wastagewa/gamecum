/**
 * Flash Memory Game
 * An image is shown for a shrinking window of time, then hidden.
 * Pick it from a lineup. Rounds get faster. Three lives.
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const startBtn      = document.getElementById('startFmBtn');
    const resetBtn      = document.getElementById('resetFmBtn');
    const backBtn       = document.getElementById('backFmBtn');
    const scoreEl       = document.getElementById('fmScore');
    const roundEl       = document.getElementById('fmRound');
    const livesEl       = document.getElementById('fmLives');
    const flashTimeEl   = document.getElementById('fmFlashTime');
    const messageEl     = document.getElementById('fmMessage');
    const flashAreaEl   = document.getElementById('fmFlashArea');
    const hiddenAreaEl  = document.getElementById('fmHiddenArea');
    const flashImgEl    = document.getElementById('fmFlashImg');
    const flashBarEl    = document.getElementById('fmFlashBar');
    const flashLabelEl  = document.getElementById('fmFlashLabel');
    const optionsEl     = document.getElementById('fmOptions');
    const startTimeSel  = document.getElementById('fmStartTime');
    const numOptSel     = document.getElementById('fmNumOptions');
    const usernameInput = document.getElementById('fmUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];

    async function loadImages() {
        try {
            const res = await fetch(`/api/collections/${COLLECTION}/images`);
            const d   = await res.json();
            if (d.success) allImages = d.images;
        } catch (e) { console.error('FlashMemory: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ── Flash duration logic ──────────────────────────────────────────────────
    // Starts at user-selected value, decreases 15% every 3 rounds, min 250ms
    function getFlashMs(round) {
        const base       = parseInt(startTimeSel.value, 10) || 3000;
        const steps      = Math.floor((round - 1) / 3);          // every 3 rounds
        const multiplier = Math.pow(0.85, steps);                 // 15% reduction per step
        return Math.max(250, Math.round(base * multiplier));
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let state = {
        active: false, score: 0, round: 0, lives: 3,
        startTime: null, targetUrl: null, flashTimeout: null,
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
        optionsEl.innerHTML = '';
        hiddenAreaEl.style.display = 'none';
        messageEl.innerHTML = '';

        const flashMs = getFlashMs(state.round);
        flashTimeEl.textContent = flashMs >= 1000
            ? (flashMs / 1000).toFixed(1) + 's'
            : flashMs + 'ms';

        const target = allImages[Math.floor(Math.random() * allImages.length)];
        state.targetUrl = target.url;

        // --- Countdown "Get Ready" ---
        flashAreaEl.style.display = 'block';
        flashImgEl.style.display  = 'none';
        flashBarEl.style.transition  = 'none';
        flashBarEl.style.width       = '100%';
        flashLabelEl.textContent     = 'Get ready…';

        let countdown = 3;
        flashLabelEl.style.fontSize = '2.5rem';
        const tick = () => {
            if (!state.active) return;
            if (countdown > 0) {
                flashLabelEl.textContent = countdown--;
                setTimeout(tick, 500);
            } else {
                startFlash(flashMs, target.url);
            }
        };
        setTimeout(tick, 300);
    }

    function startFlash(flashMs, targetUrl) {
        if (!state.active) return;

        flashLabelEl.textContent  = 'Memorise this!';
        flashLabelEl.style.fontSize = '1rem';
        flashImgEl.src            = targetUrl;
        flashImgEl.style.display  = 'block';

        // Animate the timer bar
        flashBarEl.style.transition = 'none';
        flashBarEl.style.width      = '100%';
        void flashBarEl.offsetWidth;
        flashBarEl.style.transition = `width ${flashMs}ms linear`;
        flashBarEl.style.width      = '0%';

        state.flashTimeout = setTimeout(() => {
            if (!state.active) return;
            hideAndShowOptions(targetUrl);
        }, flashMs);
    }

    function hideAndShowOptions(targetUrl) {
        // Hide flash area
        flashAreaEl.style.display  = 'none';
        flashImgEl.style.display   = 'none';
        hiddenAreaEl.style.display = 'block';
        messageEl.innerHTML = '<p style="text-align:center;color:var(--muted-text)">Which image did you just see?</p>';

        // Build options after brief pause
        setTimeout(() => {
            if (!state.active) return;
            const n = parseInt(numOptSel.value, 10) || 4;
            const others = shuffle(allImages.filter(img => img.url !== targetUrl)).slice(0, n - 1);
            const options = shuffle([{ url: targetUrl }, ...others.map(i => ({ url: i.url }))]);

            optionsEl.innerHTML = '';
            options.forEach(opt => {
                const card = document.createElement('div');
                card.className = 'fm-option-card';
                const img = document.createElement('img');
                img.src = opt.url;
                card.appendChild(img);
                card.addEventListener('click', () => handleAnswer(opt.url, card));
                optionsEl.appendChild(card);
            });
        }, 200);
    }

    // ── Answer ────────────────────────────────────────────────────────────────
    function handleAnswer(url, cardEl) {
        if (!state.active) return;
        clearTimeout(state.flashTimeout);

        document.querySelectorAll('.fm-option-card').forEach(c => c.style.pointerEvents = 'none');

        const isCorrect = (url === state.targetUrl);
        // Difficulty bonus based on flash duration
        const flashMs  = getFlashMs(state.round);
        const hardBonus = Math.round(3000 / Math.max(250, flashMs) * 50);

        if (isCorrect) {
            const points = 100 + hardBonus;
            state.score += points;
            scoreEl.textContent = state.score;
            cardEl.classList.add('fm-correct');
            hiddenAreaEl.style.display = 'none';
            messageEl.innerHTML = `
                <div class="feedback success">
                    <i class="fas fa-brain"></i> Good memory! <strong>+${points}</strong>
                    ${hardBonus > 100 ? `<span class="streak-bonus">Speed bonus +${hardBonus}!</span>` : ''}
                </div>`;
            setTimeout(() => { if (state.active) startRound(); }, 1500);
        } else {
            state.lives--;
            updateLives();
            cardEl.classList.add('fm-wrong');
            // Show correct card
            document.querySelectorAll('.fm-option-card img').forEach(img => {
                if (img.src === state.targetUrl || img.src.endsWith(state.targetUrl.split('/').pop())) {
                    img.parentElement.classList.add('fm-correct');
                }
            });
            messageEl.innerHTML = `<div class="feedback error"><i class="fas fa-times-circle"></i> Wrong! That wasn't it.</div>`;
            if (state.lives <= 0) { setTimeout(() => endGame(), 2000); }
            else { setTimeout(() => { if (state.active) startRound(); }, 2200); }
        }
    }

    // ── End ───────────────────────────────────────────────────────────────────
    function endGame() {
        state.active = false;
        clearTimeout(state.flashTimeout);
        flashAreaEl.style.display  = 'none';
        hiddenAreaEl.style.display = 'none';
        optionsEl.innerHTML = '';
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-bolt"></i>
                <h2>Game Over!</h2>
                <p>Score: <strong>${state.score}</strong></p>
                <p>Rounds: <strong>${state.round}</strong></p>
                <p>Best flash: <strong>${flashTimeEl.textContent}</strong></p>
            </div>`;
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';
        const user = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collection: COLLECTION, gameType: 'flashmemory',
                score: state.score, time: elapsed, username: user })
        }).catch(() => {});
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function initGame() {
        if (allImages.length < 2) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 2 images!</div>';
            return;
        }
        state = { active: true, score: 0, round: 0, lives: 3,
                  startTime: Date.now(), targetUrl: null, flashTimeout: null };
        scoreEl.textContent = '0'; roundEl.textContent = '0';
        updateLives(); optionsEl.innerHTML = '';
        flashAreaEl.style.display = 'none'; hiddenAreaEl.style.display = 'none';
        messageEl.innerHTML = '';
        startBtn.style.display = 'none'; resetBtn.style.display = 'inline-block';
        startRound();
    }

    function resetGame() {
        clearTimeout(state.flashTimeout);
        state.active = false;
        flashAreaEl.style.display  = 'none';
        hiddenAreaEl.style.display = 'none';
        optionsEl.innerHTML = '';
        scoreEl.textContent = '0'; roundEl.textContent = '0';
        livesEl.textContent = '❤️❤️❤️'; flashTimeEl.textContent = '—';
        messageEl.innerHTML = '';
        startBtn.style.display = 'inline-block'; resetBtn.style.display = 'none';
    }

    startBtn.addEventListener('click', initGame);
    resetBtn.addEventListener('click', resetGame);
    backBtn.addEventListener('click', () => { clearTimeout(state.flashTimeout); window.location.href = `/collection/${COLLECTION}`; });

    await loadImages();
    if (allImages.length < 2) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:2rem">Need at least 2 images in this collection!</div>';
        startBtn.disabled = true;
    }
});

/**
 * Silhouette Strike Game
 * Image starts as pure black silhouette: filter: brightness(0) contrast(1000%) saturate(0)
 * Progressively reveals to full colour over time via requestAnimationFrame.
 * speed slider (5s–60s), "Revealed" bar fills as progress increases.
 * 4 option thumbnails; correct = score based on blur remaining, wrong = lose a life.
 * 3 lives.  gameType: 'silhouette'
 *
 * Filter interpolation (progress 0→1):
 *   brightness = Math.pow(progress, 0.5)
 *   contrast   = 1 + (1 - progress) * 8
 *   saturate   = progress
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container     = document.getElementById('silContainer');
    const startBtn      = document.getElementById('startSilBtn');
    const resetBtn      = document.getElementById('resetSilBtn');
    const fullscreenBtn = document.getElementById('fullscreenSilBtn');
    const backBtn       = document.getElementById('backSilBtn');
    const scoreEl       = document.getElementById('silScore');
    const roundEl       = document.getElementById('silRound');
    const livesEl       = document.getElementById('silLives');
    const bonusEl       = document.getElementById('silBonus');
    const messageEl     = document.getElementById('silMessage');
    const targetImg     = document.getElementById('silTargetImg');
    const revealBar     = document.getElementById('silRevealBar');
    const revealPct     = document.getElementById('silRevealPct');
    const optionsEl     = document.getElementById('silOptions');
    const revealSlider  = document.getElementById('silRevealTime');
    const revealValEl   = document.getElementById('silRevealTimeVal');
    const usernameInput = document.getElementById('silUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Slider live preview ───────────────────────────────────────────────────
    revealSlider.addEventListener('input', () => {
        revealValEl.textContent = revealSlider.value + 's';
    });

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];

    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('Silhouette: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ── Animation state ───────────────────────────────────────────────────────
    let animFrame = null;
    let progress  = 0;   // 0 = silhouette, 1 = full colour
    let answered  = false;

    function calcProgressIncrement() {
        const timeSec = parseInt(revealSlider.value, 10) || 20;
        return 1 / (timeSec * 60);
    }

    function applyProgress(p) {
        const brightness = Math.pow(p, 0.5);
        const contrast   = 1 + (1 - p) * 8;
        const saturate   = p;
        targetImg.style.filter =
            `brightness(${brightness.toFixed(4)}) ` +
            `contrast(${contrast.toFixed(4)}) ` +
            `saturate(${saturate.toFixed(4)})`;
    }

    function updateRevealBar(p) {
        const pct = Math.round(p * 100);
        revealBar.style.width = pct + '%';
        // Neon green at full reveal, dark at start
        const h = Math.round(p * 100);   // 0 (dark) → 100 (green)
        revealBar.style.background = `hsl(${h},100%,50%)`;
        revealPct.textContent = pct + '%';
        const bonus = Math.max(0, Math.round(500 * (1 - p)));
        bonusEl.textContent = bonus > 0 ? '+' + bonus : '0';
    }

    function animateReveal() {
        if (answered) return;
        const inc = calcProgressIncrement();
        progress = Math.min(1, progress + inc);
        applyProgress(progress);
        updateRevealBar(progress);

        if (progress >= 1) {
            answered = true;
            revealFull();
            return;
        }
        animFrame = requestAnimationFrame(animateReveal);
    }

    function revealFull() {
        cancelAnimationFrame(animFrame);
        progress = 1;
        applyProgress(1);
        updateRevealBar(1);
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let state = { active: false, score: 0, round: 0, lives: 3,
                  startTime: null, targetUrl: null };

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
        answered = false;
        progress = 0;

        const target = allImages[Math.floor(Math.random() * allImages.length)];
        state.targetUrl = target.url;

        const others = shuffle(allImages.filter(img => img.url !== target.url));
        const opts   = shuffle([target, ...others.slice(0, 3)]);

        const doStart = () => {
            cancelAnimationFrame(animFrame);
            applyProgress(0);
            updateRevealBar(0);

            optionsEl.innerHTML = '';
            opts.forEach(opt => {
                const card = document.createElement('div');
                card.className = 'sil-option-card';
                const img = document.createElement('img');
                img.src = opt.url;
                card.appendChild(img);
                card.addEventListener('click', () => handleAnswer(opt.url, card));
                optionsEl.appendChild(card);
            });

            messageEl.innerHTML = '<p class="sil-prompt">Who is hiding in the shadows?</p>';
            animFrame = requestAnimationFrame(animateReveal);
        };

        targetImg.onload  = doStart;
        targetImg.onerror = doStart;
        targetImg.src = target.url;
        if (targetImg.complete) doStart();
    }

    // ── Answer ────────────────────────────────────────────────────────────────
    function handleAnswer(url, cardEl) {
        if (!state.active || answered) return;
        const progressAtAnswer = progress;
        answered = true;
        cancelAnimationFrame(animFrame);
        document.querySelectorAll('.sil-option-card').forEach(c => c.style.pointerEvents = 'none');

        revealFull();

        const isCorrect = (url === state.targetUrl);

        if (isCorrect) {
            const remaining = 1 - progressAtAnswer;   // how much was still hidden
            const bonus  = Math.max(0, Math.round(500 * remaining));
            const points = 100 + bonus;
            state.score += points;
            scoreEl.textContent = state.score;
            cardEl.classList.add('sil-correct');
            messageEl.innerHTML = `
                <div class="feedback success">
                    <i class="fas fa-check-circle"></i> Correct! <strong>+${points}</strong>
                    ${bonus > 0 ? `<span class="streak-bonus">Shadow bonus +${bonus}!</span>` : ''}
                </div>`;
            setTimeout(() => { if (state.active) startRound(); }, 1600);
        } else {
            state.lives--;
            updateLives();
            cardEl.classList.add('sil-wrong');
            document.querySelectorAll('.sil-option-card').forEach(c => {
                const img = c.querySelector('img');
                if (img) {
                    const cUrl = decodeURIComponent(img.src).replace(window.location.origin, '');
                    const tUrl = decodeURIComponent(state.targetUrl).replace(window.location.origin, '');
                    if (cUrl === tUrl || img.src === state.targetUrl) {
                        c.classList.add('sil-correct');
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
        cancelAnimationFrame(animFrame);
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        optionsEl.innerHTML = '';
        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-user-secret"></i>
                <h2>Game Over!</h2>
                <p>Score: <strong>${state.score}</strong></p>
                <p>Rounds: <strong>${state.round}</strong></p>
            </div>`;
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';

        const user = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION, gameType: 'silhouette',
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
        scoreEl.textContent    = '0';
        roundEl.textContent    = '0';
        bonusEl.textContent    = 'MAX';
        updateLives();
        messageEl.innerHTML    = '';
        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';
        startRound();
    }

    function resetGame() {
        cancelAnimationFrame(animFrame);
        state.active = false;
        answered = false;
        progress = 0;
        targetImg.src          = '';
        targetImg.style.filter = '';
        optionsEl.innerHTML    = '';
        messageEl.innerHTML    = '';
        revealBar.style.width  = '0%';
        revealPct.textContent  = '0%';
        bonusEl.textContent    = 'MAX';
        scoreEl.textContent    = '0';
        roundEl.textContent    = '0';
        livesEl.textContent    = '❤️❤️❤️';
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
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
        cancelAnimationFrame(animFrame);
        if (document.fullscreenElement) document.exitFullscreen();
        window.location.href = `/collection/${COLLECTION}`;
    });

    await loadImages();
    if (allImages.length < 2) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:2rem">Need at least 2 images to play!</div>';
        startBtn.disabled = true;
    }
});

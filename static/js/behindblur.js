/**
 * Behind the Blur Game
 * Image starts at blur(30px), decreases over time via requestAnimationFrame.
 * Speed slider (5s–60s to fully clear).  Clarity bar fills as blur decreases.
 * 4 option thumbnails; click any time — correct = score based on blur remaining.
 * 3 lives.  gameType: 'behindblur'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container     = document.getElementById('bbContainer');
    const startBtn      = document.getElementById('startBbBtn');
    const resetBtn      = document.getElementById('resetBbBtn');
    const fullscreenBtn = document.getElementById('fullscreenBbBtn');
    const backBtn       = document.getElementById('backBbBtn');
    const scoreEl       = document.getElementById('bbScore');
    const roundEl       = document.getElementById('bbRound');
    const livesEl       = document.getElementById('bbLives');
    const bonusEl       = document.getElementById('bbBonus');
    const messageEl     = document.getElementById('bbMessage');
    const targetImg     = document.getElementById('bbTargetImg');
    const clarityBar    = document.getElementById('bbClarityBar');
    const clarityPct    = document.getElementById('bbClarityPct');
    const optionsEl     = document.getElementById('bbOptions');
    const clearSlider   = document.getElementById('bbClearTime');
    const clearValEl    = document.getElementById('bbClearTimeVal');
    const usernameInput = document.getElementById('bbUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    const MAX_BLUR = 30;   // px

    // ── Slider live preview ───────────────────────────────────────────────────
    clearSlider.addEventListener('input', () => {
        clearValEl.textContent = clearSlider.value + 's';
    });

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];

    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('BehindBlur: load error', e); }
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
    let currentBlur = MAX_BLUR;
    let answered    = false;

    function calcBlurDecrement() {
        const timeSec = parseInt(clearSlider.value, 10) || 20;
        return MAX_BLUR / (timeSec * 60);
    }

    function applyBlur(blur) {
        targetImg.style.filter = `blur(${blur.toFixed(2)}px)`;
    }

    function updateClarityBar(blur) {
        const progress = 1 - blur / MAX_BLUR;   // 0 = full blur, 1 = clear
        const pct      = Math.round(progress * 100);
        clarityBar.style.width = pct + '%';
        // Green when clear (progress=1), red when blurry (progress=0) — inverted
        const h = Math.round(progress * 120);
        clarityBar.style.background = `hsl(${h},85%,52%)`;
        clarityPct.textContent = pct + '%';
        const bonus = Math.max(0, Math.round(500 * (1 - progress)));
        bonusEl.textContent = bonus > 0 ? '+' + bonus : '0';
    }

    function animateBlur() {
        if (answered) return;
        const dec = calcBlurDecrement();
        currentBlur = Math.max(0, currentBlur - dec);
        applyBlur(currentBlur);
        updateClarityBar(currentBlur);

        if (currentBlur <= 0) {
            // Fully revealed — auto-end round (penalise)
            answered = true;
            revealFull();
            return;
        }
        animFrame = requestAnimationFrame(animateBlur);
    }

    function revealFull() {
        cancelAnimationFrame(animFrame);
        currentBlur = 0;
        applyBlur(0);
        updateClarityBar(0);
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
        answered    = false;
        currentBlur = MAX_BLUR;

        const target = allImages[Math.floor(Math.random() * allImages.length)];
        state.targetUrl = target.url;

        const others = shuffle(allImages.filter(img => img.url !== target.url));
        const opts   = shuffle([target, ...others.slice(0, 3)]);

        const doStart = () => {
            cancelAnimationFrame(animFrame);
            applyBlur(MAX_BLUR);
            updateClarityBar(MAX_BLUR);

            optionsEl.innerHTML = '';
            opts.forEach(opt => {
                const card = document.createElement('div');
                card.className = 'bb-option-card';
                const img = document.createElement('img');
                img.src = opt.url;
                card.appendChild(img);
                card.addEventListener('click', () => handleAnswer(opt.url, card));
                optionsEl.appendChild(card);
            });

            messageEl.innerHTML = '<p class="bb-prompt">Who is hiding behind the blur?</p>';
            animFrame = requestAnimationFrame(animateBlur);
        };

        targetImg.onload  = doStart;
        targetImg.onerror = doStart;
        targetImg.src = target.url;
        if (targetImg.complete) doStart();
    }

    // ── Answer ────────────────────────────────────────────────────────────────
    function handleAnswer(url, cardEl) {
        if (!state.active || answered) return;
        answered = true;
        cancelAnimationFrame(animFrame);
        document.querySelectorAll('.bb-option-card').forEach(c => c.style.pointerEvents = 'none');

        revealFull();

        const isCorrect = (url === state.targetUrl);

        if (isCorrect) {
            const blurAtAnswer  = currentBlur;
            const remaining     = blurAtAnswer / MAX_BLUR;   // 1 = still blurry, 0 = clear
            const bonus  = Math.max(0, Math.round(500 * remaining));
            const points = 100 + bonus;
            state.score += points;
            scoreEl.textContent = state.score;
            cardEl.classList.add('bb-correct');
            messageEl.innerHTML = `
                <div class="feedback success">
                    <i class="fas fa-check-circle"></i> Correct! <strong>+${points}</strong>
                    ${bonus > 0 ? `<span class="streak-bonus">Blur bonus +${bonus}!</span>` : ''}
                </div>`;
            setTimeout(() => { if (state.active) startRound(); }, 1600);
        } else {
            state.lives--;
            updateLives();
            cardEl.classList.add('bb-wrong');
            document.querySelectorAll('.bb-option-card').forEach(c => {
                const img = c.querySelector('img');
                if (img) {
                    const cUrl = decodeURIComponent(img.src).replace(window.location.origin, '');
                    const tUrl = decodeURIComponent(state.targetUrl).replace(window.location.origin, '');
                    if (cUrl === tUrl || img.src === state.targetUrl) {
                        c.classList.add('bb-correct');
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
                <i class="fas fa-eye"></i>
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
                collection: COLLECTION, gameType: 'behindblur',
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
        scoreEl.textContent = '0';
        roundEl.textContent = '0';
        bonusEl.textContent = 'MAX';
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
        targetImg.src    = '';
        targetImg.style.filter = '';
        optionsEl.innerHTML    = '';
        messageEl.innerHTML    = '';
        clarityBar.style.width = '0%';
        clarityPct.textContent = '0%';
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

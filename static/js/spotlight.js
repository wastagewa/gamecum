/**
 * Spotlight Game
 * A tiny circular peephole drifts across a hidden image.
 * Identify the image from a thumbnail lineup before too much is exposed.
 * The less revealed when you answer correctly, the higher the score.
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container     = document.getElementById('spContainer');
    const startBtn      = document.getElementById('startSpBtn');
    const resetBtn      = document.getElementById('resetSpBtn');
    const backBtn       = document.getElementById('backSpBtn');
    const scoreEl       = document.getElementById('spScore');
    const roundEl       = document.getElementById('spRound');
    const livesEl       = document.getElementById('spLives');
    const bonusEl       = document.getElementById('spBonus');
    const messageEl     = document.getElementById('spMessage');
    const stageEl       = document.getElementById('spStage');
    const targetImg     = document.getElementById('spTargetImg');
    const canvas        = document.getElementById('spCanvas');
    const optionsEl     = document.getElementById('spOptions');
    const exposureBar   = document.getElementById('spExposureBar');
    const exposurePct   = document.getElementById('spExposurePct');
    const diffSel       = document.getElementById('spDifficulty');
    const numOptSel     = document.getElementById('spNumOptions');
    const usernameInput = document.getElementById('spUsername');

    const ctx = canvas.getContext('2d');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];

    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('Spotlight: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ── Spotlight animation ───────────────────────────────────────────────────
    // grow speed (px per frame @ 60 fps)
    const GROW = { easy: 2.5, medium: 1.4, hard: 0.7, insane: 0.35 };

    let spotX, spotY, velX, velY, radius, maxRadius, animFrame, answered;
    let stageW, stageH;

    function initSpot() {
        stageW  = stageEl.offsetWidth  || 380;
        stageH  = stageEl.offsetHeight || 380;
        canvas.width  = stageW;
        canvas.height = stageH;

        // Start spotlight at random position in centre 40%
        spotX = stageW * (0.3 + Math.random() * 0.4);
        spotY = stageH * (0.3 + Math.random() * 0.4);

        // Random drift velocity (slow)
        const speed = 1.2;
        const angle = Math.random() * Math.PI * 2;
        velX = Math.cos(angle) * speed;
        velY = Math.sin(angle) * speed;

        // Start tiny; max radius covers the whole stage diagonal
        radius    = 20;
        maxRadius = Math.sqrt(stageW * stageW + stageH * stageH) / 2;
        answered  = false;
    }

    function drawSpot() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw dark overlay
        ctx.fillStyle = 'rgba(0,0,0,0.96)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Cut circular hole
        ctx.globalCompositeOperation = 'destination-out';
        // Soft edge
        const grd = ctx.createRadialGradient(spotX, spotY, radius * 0.7, spotX, spotY, radius);
        grd.addColorStop(0, 'rgba(0,0,0,1)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(spotX, spotY, radius, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
    }

    function exposureRatio() {
        // Approximate % of image area exposed by the circle
        const circleArea = Math.PI * radius * radius;
        const stageArea  = stageW * stageH;
        return Math.min(1, circleArea / stageArea);
    }

    function updateExposureBar() {
        const pct = Math.round(exposureRatio() * 100);
        exposureBar.style.width = pct + '%';
        // Colour: green → yellow → red
        const h = Math.round(120 - pct * 1.2);
        exposureBar.style.background = `hsl(${h}, 85%, 52%)`;
        exposurePct.textContent = pct + '%';

        // Bonus display: max when <10% exposed
        const bonus = Math.max(0, Math.round(500 * (1 - exposureRatio())));
        bonusEl.textContent = bonus > 0 ? '+' + bonus : '0';
    }

    function animateSpot() {
        if (answered) return;

        const grow = GROW[diffSel.value] || GROW.medium;
        radius = Math.min(radius + grow, maxRadius);

        // Drift
        spotX += velX;
        spotY += velY;
        const pad = 60;
        if (spotX < pad || spotX > stageW - pad) { velX *= -1; spotX = Math.max(pad, Math.min(stageW - pad, spotX)); }
        if (spotY < pad || spotY > stageH - pad) { velY *= -1; spotY = Math.max(pad, Math.min(stageH - pad, spotY)); }

        drawSpot();
        updateExposureBar();

        // Auto-answer when fully exposed
        if (radius >= maxRadius) {
            answered = true;
            revealAll();
            return;
        }

        animFrame = requestAnimationFrame(animateSpot);
    }

    function revealAll() {
        cancelAnimationFrame(animFrame);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        exposureBar.style.width = '100%';
        exposurePct.textContent = '100%';
        bonusEl.textContent = '0';
    }

    // ── Round generation ──────────────────────────────────────────────────────
    function generateOptions(targetUrl) {
        const n = parseInt(numOptSel.value, 10) || 4;
        const others = allImages.filter(img => img.url !== targetUrl);
        return shuffle([{ url: targetUrl }, ...shuffle(others).slice(0, n - 1).map(i => ({ url: i.url }))]);
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let state = { active: false, score: 0, round: 0, lives: 3, startTime: null,
                  globalTimer: null, targetUrl: null };

    function updateLives() {
        const h = ['❤️','❤️','❤️'];
        for (let i = state.lives; i < 3; i++) h[i] = '🖤';
        livesEl.textContent = h.join('');
    }

    function startGlobalTimer() {
        state.globalTimer = setInterval(() => {
            const e = Math.floor((Date.now() - state.startTime) / 1000);
            // (no time display needed here — bonus bar takes that role)
        }, 500);
    }

    // ── Round start ───────────────────────────────────────────────────────────
    function startRound() {
        if (!state.active) return;

        state.round++;
        roundEl.textContent = state.round;

        // Pick target
        const target = allImages[Math.floor(Math.random() * allImages.length)];
        state.targetUrl = target.url;

        // Set image (hidden under spotlight)
        targetImg.src = target.url;

        targetImg.onload = () => {
            initSpot();
            updateExposureBar();
            drawSpot();

            // Build options
            const opts = generateOptions(target.url);
            optionsEl.innerHTML = '';
            opts.forEach(opt => {
                const card = document.createElement('div');
                card.className = 'sp-option-card';
                const img = document.createElement('img');
                img.src = opt.url;
                img.alt = '';
                card.appendChild(img);
                card.addEventListener('click', () => handleAnswer(opt.url, card));
                optionsEl.appendChild(card);
            });

            messageEl.innerHTML = '<p class="sp-prompt">Which image is hiding in the spotlight?</p>';
            animFrame = requestAnimationFrame(animateSpot);
        };

        if (targetImg.complete) targetImg.onload();
    }

    // ── Answer ────────────────────────────────────────────────────────────────
    function handleAnswer(url, cardEl) {
        if (!state.active || answered) return;
        answered = true;
        cancelAnimationFrame(animFrame);

        // Disable all cards
        document.querySelectorAll('.sp-option-card').forEach(c => c.style.pointerEvents = 'none');

        const isCorrect = (url === state.targetUrl);

        if (isCorrect) {
            const bonus  = Math.max(0, Math.round(500 * (1 - exposureRatio())));
            const points = 100 + bonus;
            state.score += points;
            scoreEl.textContent = state.score;
            cardEl.classList.add('sp-correct');
            revealAll();
            messageEl.innerHTML = `
                <div class="feedback success">
                    <i class="fas fa-check-circle"></i> Correct! <strong>+${points}</strong>
                    ${bonus > 0 ? `<span class="streak-bonus">Peep bonus +${bonus}!</span>` : ''}
                </div>`;
            setTimeout(() => { if (state.active) startRound(); }, 1600);
        } else {
            state.lives--;
            updateLives();
            cardEl.classList.add('sp-wrong');
            // Show correct
            document.querySelectorAll('.sp-option-card').forEach(c => {
                if (c.querySelector('img').src === state.targetUrl ||
                    c.querySelector('img').src.endsWith(state.targetUrl.replace(/^.*\//, ''))) {
                    c.classList.add('sp-correct');
                }
            });
            revealAll();
            messageEl.innerHTML = `<div class="feedback error"><i class="fas fa-times-circle"></i> Wrong!</div>`;

            if (state.lives <= 0) { setTimeout(() => endGame(), 1800); }
            else { setTimeout(() => { if (state.active) startRound(); }, 2000); }
        }
    }

    // ── End ───────────────────────────────────────────────────────────────────
    function endGame() {
        state.active = false;
        cancelAnimationFrame(animFrame);
        clearInterval(state.globalTimer);
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
        fetch('/api/submit-score', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collection: COLLECTION, gameType: 'spotlight',
                score: state.score, time: elapsed, username: user })
        }).catch(() => {});
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function initGame() {
        if (allImages.length < 2) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 2 images to play!</div>';
            return;
        }
        state = { active: true, score: 0, round: 0, lives: 3,
                  startTime: Date.now(), globalTimer: null, targetUrl: null };
        scoreEl.textContent = '0'; roundEl.textContent = '0';
        updateLives(); bonusEl.textContent = 'MAX';
        messageEl.innerHTML = '';
        startBtn.style.display  = 'none';
        resetBtn.style.display  = 'inline-block';
        startGlobalTimer();
        startRound();
    }

    function resetGame() {
        cancelAnimationFrame(animFrame);
        clearInterval(state.globalTimer);
        state.active = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        targetImg.src = '';
        optionsEl.innerHTML = '';
        messageEl.innerHTML = '';
        exposureBar.style.width = '0%';
        exposurePct.textContent = '0%';
        bonusEl.textContent = 'MAX';
        scoreEl.textContent = '0'; roundEl.textContent = '0'; livesEl.textContent = '❤️❤️❤️';
        startBtn.style.display = 'inline-block'; resetBtn.style.display = 'none';
    }

    // ── Wiring ─────────────────────────────────────────────────────────────────
    startBtn.addEventListener('click', initGame);
    resetBtn.addEventListener('click', resetGame);
    backBtn.addEventListener('click', () => { cancelAnimationFrame(animFrame); window.location.href = `/collection/${COLLECTION}`; });

    await loadImages();
    if (allImages.length < 2) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:2rem">Need at least 2 images to play!</div>';
        startBtn.disabled = true;
    }
});

/**
 * Spotlight Game
 * A tiny circular peephole drifts across a hidden image.
 * Identify the image from a thumbnail lineup before too much is exposed.
 * The less revealed when you answer correctly, the higher the score.
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container      = document.getElementById('spContainer');
    const startBtn       = document.getElementById('startSpBtn');
    const resetBtn       = document.getElementById('resetSpBtn');
    const fullscreenBtn  = document.getElementById('fullscreenSpBtn');
    const backBtn        = document.getElementById('backSpBtn');
    const scoreEl        = document.getElementById('spScore');
    const roundEl        = document.getElementById('spRound');
    const livesEl        = document.getElementById('spLives');
    const bonusEl        = document.getElementById('spBonus');
    const messageEl      = document.getElementById('spMessage');
    const stageEl        = document.getElementById('spStage');
    const targetImg      = document.getElementById('spTargetImg');
    const canvas         = document.getElementById('spCanvas');
    const optionsEl      = document.getElementById('spOptions');
    const exposureBar    = document.getElementById('spExposureBar');
    const exposurePct    = document.getElementById('spExposurePct');
    const exposeSlider   = document.getElementById('spExposeTime');
    const exposeValEl    = document.getElementById('spExposeTimeVal');
    const spotSizeSlider = document.getElementById('spSpotSize');
    const spotSizeValEl  = document.getElementById('spSpotSizeVal');
    const fixedCheckbox  = document.getElementById('spFixedSize');
    const fixedIcon      = document.getElementById('spFixedIcon');
    const numOptSel      = document.getElementById('spNumOptions');
    const usernameInput  = document.getElementById('spUsername');

    const ctx = canvas.getContext('2d');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Slider / toggle live preview ──────────────────────────────────────────
    exposeSlider.addEventListener('input', () => {
        exposeValEl.textContent = exposeSlider.value + 's';
    });

    spotSizeSlider.addEventListener('input', () => {
        spotSizeValEl.textContent = spotSizeSlider.value + 'px';
    });

    fixedCheckbox.addEventListener('change', () => {
        if (fixedIcon) {
            fixedIcon.className = fixedCheckbox.checked
                ? 'fas fa-lock'
                : 'fas fa-lock-open';
        }
    });

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
    // growSpeed: px per frame so full reveal takes exactly `expose time` seconds.
    function calcGrowSpeed() {
        const timeSec   = parseInt(exposeSlider.value, 10) || 20;
        const startR    = parseInt(spotSizeSlider.value, 10) || 22;
        const approxMax = Math.sqrt(stageW * stageW + stageH * stageH) / 2;
        return (approxMax - startR) / (timeSec * 60);
    }

    let spotX, spotY, velX, velY, radius, maxRadius, animFrame, answered;
    let stageW = 350, stageH = 350;
    let roundStartTime = 0;   // used for fixed-size countdown

    function initSpot() {
        stageW  = stageEl.offsetWidth  || 350;
        stageH  = stageEl.offsetHeight || 350;
        canvas.width  = stageW;
        canvas.height = stageH;

        spotX = stageW * (0.3 + Math.random() * 0.4);
        spotY = stageH * (0.3 + Math.random() * 0.4);

        const speed = 1.2;
        const angle = Math.random() * Math.PI * 2;
        velX = Math.cos(angle) * speed;
        velY = Math.sin(angle) * speed;

        radius       = parseInt(spotSizeSlider.value, 10) || 22;
        maxRadius    = Math.sqrt(stageW * stageW + stageH * stageH) / 2;
        answered     = false;
        roundStartTime = Date.now();
    }

    // Resize canvas while preserving exposure level (for fullscreen transitions)
    function resizeCanvas() {
        const prevRatio = maxRadius > 0 ? radius / maxRadius : 0;
        stageW  = stageEl.offsetWidth  || 350;
        stageH  = stageEl.offsetHeight || 350;
        canvas.width  = stageW;
        canvas.height = stageH;
        maxRadius = Math.sqrt(stageW * stageW + stageH * stageH) / 2;
        radius    = prevRatio * maxRadius;
        spotX     = Math.max(60, Math.min(stageW - 60, spotX));
        spotY     = Math.max(60, Math.min(stageH - 60, spotY));
        if (!answered) drawSpot();
    }

    function drawSpot() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(0,0,0,0.96)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'destination-out';
        const grd = ctx.createRadialGradient(spotX, spotY, radius * 0.65, spotX, spotY, radius);
        grd.addColorStop(0, 'rgba(0,0,0,1)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(spotX, spotY, radius, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
    }

    function exposureRatio() {
        return Math.min(1, (Math.PI * radius * radius) / (stageW * stageH));
    }

    function updateExposureBar() {
        const isFixed  = fixedCheckbox && fixedCheckbox.checked;
        const timeSec  = parseInt(exposeSlider.value, 10) || 20;

        if (isFixed) {
            // In fixed mode: bar shows time remaining as countdown
            const elapsed   = (Date.now() - roundStartTime) / 1000;
            const remaining = Math.max(0, 1 - elapsed / timeSec);
            const pct       = Math.round(remaining * 100);
            exposureBar.style.width      = pct + '%';
            const h = Math.round(120 * remaining);   // green → red
            exposureBar.style.background = `hsl(${h},85%,52%)`;
            const secsLeft = Math.ceil(remaining * timeSec);
            exposurePct.textContent = secsLeft + 's';
            bonusEl.textContent     = '+' + Math.round(500 * remaining);
        } else {
            // Grow mode: bar shows how much has been exposed
            const pct = Math.round(exposureRatio() * 100);
            exposureBar.style.width      = pct + '%';
            const h = Math.round(120 - pct * 1.2);
            exposureBar.style.background = `hsl(${h},85%,52%)`;
            exposurePct.textContent = pct + '%';
            const bonus = Math.max(0, Math.round(500 * (1 - exposureRatio())));
            bonusEl.textContent = bonus > 0 ? '+' + bonus : '0';
        }
    }

    function animateSpot() {
        if (answered) return;

        const isFixed = fixedCheckbox && fixedCheckbox.checked;
        const timeSec = parseInt(exposeSlider.value, 10) || 20;

        if (isFixed) {
            // Fixed size: drift but don't grow; end round when time expires
            const elapsed = (Date.now() - roundStartTime) / 1000;
            if (elapsed >= timeSec) {
                answered = true;
                revealAll();
                return;
            }
        } else {
            // Grow mode: expand radius over time
            const grow = calcGrowSpeed();
            radius = Math.min(radius + grow, maxRadius);
            if (radius >= maxRadius) {
                answered = true;
                revealAll();
                return;
            }
        }

        // Drift spotlight
        spotX += velX;
        spotY += velY;
        const pad = Math.max(40, radius);
        if (spotX < pad || spotX > stageW - pad) { velX *= -1; spotX = Math.max(pad, Math.min(stageW - pad, spotX)); }
        if (spotY < pad || spotY > stageH - pad) { velY *= -1; spotY = Math.max(pad, Math.min(stageH - pad, spotY)); }

        drawSpot();
        updateExposureBar();
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
    let state = { active: false, score: 0, round: 0, lives: 3,
                  startTime: null, globalTimer: null, targetUrl: null };

    function updateLives() {
        const h = ['❤️','❤️','❤️'];
        for (let i = state.lives; i < 3; i++) h[i] = '🖤';
        livesEl.textContent = h.join('');
    }

    // ── Round start ───────────────────────────────────────────────────────────
    function startRound() {
        if (!state.active) return;

        state.round++;
        roundEl.textContent = state.round;

        const target = allImages[Math.floor(Math.random() * allImages.length)];
        state.targetUrl = target.url;
        targetImg.src = target.url;

        const doStart = () => {
            initSpot();
            updateExposureBar();
            drawSpot();

            const opts = generateOptions(target.url);
            optionsEl.innerHTML = '';
            opts.forEach(opt => {
                const card = document.createElement('div');
                card.className = 'sp-option-card';
                const img = document.createElement('img');
                img.src = opt.url;
                card.appendChild(img);
                card.addEventListener('click', () => handleAnswer(opt.url, card));
                optionsEl.appendChild(card);
            });

            messageEl.innerHTML = '<p class="sp-prompt">Which image is hiding in the spotlight?</p>';
            animFrame = requestAnimationFrame(animateSpot);
        };

        if (targetImg.complete) { doStart(); }
        else { targetImg.onload = doStart; }
    }

    // ── Answer ────────────────────────────────────────────────────────────────
    function handleAnswer(url, cardEl) {
        if (!state.active || answered) return;
        answered = true;
        cancelAnimationFrame(animFrame);
        document.querySelectorAll('.sp-option-card').forEach(c => c.style.pointerEvents = 'none');

        const isCorrect = (url === state.targetUrl);

        if (isCorrect) {
            const isFixed   = fixedCheckbox && fixedCheckbox.checked;
            const timeSec   = parseInt(exposeSlider.value, 10) || 20;
            const remaining = isFixed
                ? Math.max(0, 1 - (Date.now() - roundStartTime) / 1000 / timeSec)
                : (1 - exposureRatio());
            const bonus  = Math.max(0, Math.round(500 * remaining));
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
            document.querySelectorAll('.sp-option-card').forEach(c => {
                const imgEl = c.querySelector('img');
                if (imgEl && (imgEl.src === state.targetUrl ||
                    imgEl.src.split('/').pop() === state.targetUrl.split('/').pop())) {
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
        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';
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

    // ── Native Fullscreen ─────────────────────────────────────────────────────
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
            // Resize canvas after fullscreen transition (150ms CSS transition)
            setTimeout(() => {
                if (!answered || state.active) resizeCanvas();
            }, 150);
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

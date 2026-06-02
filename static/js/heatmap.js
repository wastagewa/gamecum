/**
 * Heat Map
 *
 * One image shown at a time inside a fixed stage.
 * Player holds and drags to paint a radial gradient "heat" wherever they look.
 * A countdown timer runs; when it hits zero the round ends.
 * Coverage % = painted pixels / total pixels on the canvas.
 * Score = coverage × timeLimit × 0.8 per image.
 *
 * gameType: 'heatmap'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container    = document.getElementById('hmContainer');
    const startBtn     = document.getElementById('startHmBtn');
    const nextBtn      = document.getElementById('nextHmBtn');
    const resetBtn     = document.getElementById('resetHmBtn');
    const fsBtn        = document.getElementById('fullscreenHmBtn');
    const backBtn      = document.getElementById('backHmBtn');
    const roundEl      = document.getElementById('hmRound');
    const totalEl      = document.getElementById('hmTotal');
    const timerEl      = document.getElementById('hmTimer');
    const coverageEl   = document.getElementById('hmCoverage');
    const scoreEl      = document.getElementById('hmScore');
    const messageEl    = document.getElementById('hmMessage');
    const stageEl      = document.getElementById('hmStage');
    const imgEl        = document.getElementById('hmImg');
    const canvasEl     = document.getElementById('hmCanvas');
    const timerBarEl   = document.getElementById('hmTimerBar');
    const timeLimitSel    = document.getElementById('hmTimeLimit');
    const timeLimitValEl  = document.getElementById('hmTimeLimitVal');
    const brushSlider     = document.getElementById('hmBrush');
    const brushValEl      = document.getElementById('hmBrushVal');
    const usernameInput   = document.getElementById('hmUsername');

    const ctx = canvasEl.getContext('2d');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    timeLimitSel.addEventListener('input', () => {
        timeLimitValEl.textContent = timeLimitSel.value;
        // Keep the stats timer display in sync when not in a round
        if (!state.active) timerEl.textContent = timeLimitSel.value;
    });

    brushSlider.addEventListener('input', () => {
        brushValEl.textContent = brushSlider.value;
    });

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];

    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('HeatMap: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let state = {
        active:    false,
        round:     0,
        score:     0,
        timeLeft:  30,
        startTime: null,
        queue:     [],
    };

    let isPainting    = false;
    let timerInterval = null;
    let lastPaintPos  = null;

    // ── Helpers ───────────────────────────────────────────────────────────────
    function getTimeLimit()  { return parseInt(timeLimitSel.value, 10); }
    function getBrushRadius(){ return parseInt(brushSlider.value,  10); }

    /** Resize the canvas to exactly match the rendered image dimensions.
     *  We derive height from the image's natural aspect ratio so the canvas
     *  is accurate even if the browser hasn't reflowed yet after image load. */
    function sizeCanvas() {
        const w  = stageEl.offsetWidth;
        const nw = imgEl.naturalWidth;
        const nh = imgEl.naturalHeight;
        const h  = nw > 0 ? Math.round(w * nh / nw) : stageEl.offsetHeight;
        canvasEl.width  = w;
        canvasEl.height = h;
    }

    /** Convert a mouse or touch event to canvas-local coordinates. */
    function canvasPos(e) {
        const rect   = canvasEl.getBoundingClientRect();
        const src    = e.touches ? e.touches[0] : e;
        return {
            x: (src.clientX - rect.left) * (canvasEl.width  / rect.width),
            y: (src.clientY - rect.top)  * (canvasEl.height / rect.height),
        };
    }

    /** Paint a soft radial gradient at (x, y). */
    function paint(x, y) {
        const r    = getBrushRadius();
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0,    'rgba(255,  50,  0, 0.28)');
        grad.addColorStop(0.35, 'rgba(255, 140,  0, 0.14)');
        grad.addColorStop(0.75, 'rgba(255, 220,  0, 0.05)');
        grad.addColorStop(1,    'rgba(255,   0,  0, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    /** Interpolate painting between two positions so fast drags don't skip. */
    function paintLine(x0, y0, x1, y1) {
        const dist  = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(1, Math.ceil(dist / (getBrushRadius() * 0.4)));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            paint(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        }
    }

    /** Return the % of canvas pixels that have been painted (alpha > threshold). */
    function calcCoverage() {
        const data    = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height).data;
        let   painted = 0;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 8) painted++;
        }
        const total = canvasEl.width * canvasEl.height;
        return total > 0 ? Math.round((painted / total) * 100) : 0;
    }

    // ── Canvas events ─────────────────────────────────────────────────────────
    function onDown(e) {
        if (!state.active) return;
        e.preventDefault();
        isPainting   = true;
        lastPaintPos = canvasPos(e);
        paint(lastPaintPos.x, lastPaintPos.y);
    }
    function onMove(e) {
        if (!isPainting || !state.active) return;
        e.preventDefault();
        const pos = canvasPos(e);
        if (lastPaintPos) paintLine(lastPaintPos.x, lastPaintPos.y, pos.x, pos.y);
        else paint(pos.x, pos.y);
        lastPaintPos = pos;
    }
    function onUp() { isPainting = false; lastPaintPos = null; }

    canvasEl.addEventListener('mousedown',  onDown);
    canvasEl.addEventListener('mousemove',  onMove);
    canvasEl.addEventListener('mouseup',    onUp);
    canvasEl.addEventListener('mouseleave', onUp);
    canvasEl.addEventListener('touchstart', onDown, { passive: false });
    canvasEl.addEventListener('touchmove',  onMove, { passive: false });
    canvasEl.addEventListener('touchend',   onUp);

    // ── Timer ─────────────────────────────────────────────────────────────────
    function startTimer() {
        const limit      = getTimeLimit();
        state.timeLeft   = limit;
        timerEl.textContent         = limit;
        timerBarEl.style.transition = 'none';
        timerBarEl.style.width      = '100%';
        // Force reflow, then animate
        timerBarEl.getBoundingClientRect();
        timerBarEl.style.transition = `width ${limit}s linear`;
        timerBarEl.style.width      = '0%';

        clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            state.timeLeft--;
            timerEl.textContent = Math.max(0, state.timeLeft);
            // live coverage update every second
            const cov = calcCoverage();
            coverageEl.textContent = cov + '%';
            if (state.timeLeft <= 0) {
                clearInterval(timerInterval);
                endRound(true);
            }
        }, 1000);
    }

    // ── Round lifecycle ───────────────────────────────────────────────────────
    function startRound() {
        if (state.queue.length === 0) { endGame(); return; }

        state.active = false;
        isPainting   = false;
        clearInterval(timerInterval);
        nextBtn.style.display = 'none';

        const imgObj = state.queue.shift();
        state.round++;
        roundEl.textContent = state.round;
        totalEl.textContent = state.round + state.queue.length;
        coverageEl.textContent = '0%';
        messageEl.innerHTML = '<p class="hm-loading-hint">Loading…</p>';

        const doStart = () => {
            sizeCanvas();
            ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
            state.active = true;
            messageEl.innerHTML =
                '<p class="hm-prompt-hint"><i class="fas fa-paint-brush"></i> Paint what draws your eye!</p>';
            startTimer();
        };

        imgEl.onload  = doStart;
        imgEl.onerror = doStart;
        imgEl.src = imgObj.url;
        if (imgEl.complete && imgEl.naturalWidth > 0) doStart();
    }

    function endRound(autoAdvance) {
        state.active = false;
        isPainting   = false;
        clearInterval(timerInterval);

        const cov        = calcCoverage();
        const limit      = getTimeLimit();
        const roundScore = Math.round(cov * limit * 0.8);
        state.score     += roundScore;

        coverageEl.textContent = cov + '%';
        scoreEl.textContent    = state.score;

        messageEl.innerHTML = `
            <div class="feedback success">
                <i class="fas fa-fire"></i>
                Coverage <strong>${cov}%</strong>
                &nbsp;·&nbsp; <strong>+${roundScore}</strong> pts
            </div>`;

        if (state.queue.length > 0) {
            nextBtn.style.display = 'inline-block';
            if (autoAdvance) setTimeout(() => { if (state.queue.length > 0) startRound(); }, 2400);
        } else {
            setTimeout(endGame, 2400);
        }
    }

    function endGame() {
        state.active = false;
        clearInterval(timerInterval);
        nextBtn.style.display  = 'none';
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';

        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-fire"></i>
                <h2>Session Complete!</h2>
                <p>Images explored: <strong>${state.round}</strong></p>
                <p>Total Score: <strong>${state.score}</strong></p>
            </div>`;

        const user    = (usernameInput.value.trim()) || 'Anonymous';
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType:   'heatmap',
                score:      state.score,
                time:       elapsed,
                username:   user,
            })
        }).catch(() => {});
    }

    // ── Init / Reset ──────────────────────────────────────────────────────────
    function initGame() {
        if (allImages.length < 1) {
            messageEl.innerHTML = '<div class="feedback error">No images found!</div>';
            return;
        }
        clearInterval(timerInterval);
        state = {
            active:    false,
            round:     0,
            score:     0,
            timeLeft:  getTimeLimit(),
            startTime: Date.now(),
            queue:     shuffle(allImages).slice(),
        };
        scoreEl.textContent  = '0';
        roundEl.textContent  = '0';
        totalEl.textContent  = allImages.length;
        timerEl.textContent  = getTimeLimit();
        coverageEl.textContent = '0%';
        messageEl.innerHTML  = '';
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        startBtn.style.display = 'none';
        resetBtn.style.display = 'none';
        nextBtn.style.display  = 'none';
        startRound();
    }

    function resetGame() {
        clearInterval(timerInterval);
        state.active = false;
        isPainting   = false;
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        imgEl.src              = '';
        messageEl.innerHTML    = '';
        scoreEl.textContent    = '0';
        roundEl.textContent    = '0';
        timerEl.textContent    = getTimeLimit();
        coverageEl.textContent = '0%';
        timerBarEl.style.transition = 'none';
        timerBarEl.style.width      = '0%';
        nextBtn.style.display  = 'none';
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
    }

    // ── Fullscreen ────────────────────────────────────────────────────────────
    if (fsBtn) {
        fsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                container.requestFullscreen().catch(e => console.warn(e));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === container;
            fsBtn.innerHTML = isFS
                ? '<i class="fas fa-compress"></i> Exit Fullscreen'
                : '<i class="fas fa-expand"></i> Fullscreen';
            if (state.active) setTimeout(sizeCanvas, 80);
        });
    }

    window.addEventListener('resize', () => { if (state.active) sizeCanvas(); });

    // ── Wiring ────────────────────────────────────────────────────────────────
    startBtn.addEventListener('click', initGame);
    resetBtn.addEventListener('click', resetGame);
    nextBtn.addEventListener('click',  () => { clearInterval(timerInterval); endRound(false); });
    backBtn.addEventListener('click',  () => {
        clearInterval(timerInterval);
        if (document.fullscreenElement) document.exitFullscreen();
        window.location.href = `/collection/${COLLECTION}`;
    });

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    timerEl.textContent = timeLimitSel.value;   // sync stat display on page load
    await loadImages();
    totalEl.textContent = allImages.length > 0 ? allImages.length : '—';
    if (allImages.length < 1) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:2rem">No images found in this collection!</div>';
        startBtn.disabled = true;
    }
});

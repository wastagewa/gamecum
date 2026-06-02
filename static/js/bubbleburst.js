/**
 * Bubble Burst
 *
 * A target image is shown above the canvas.
 * Soap-bubble thumbnails float up from the bottom — some contain the target,
 * most are decoys.  Click / tap to pop:
 *   • Correct bubble → +points (100 × combo × size bonus). Combo builds.
 *   • Decoy bubble   → −75 pts, combo resets, −1 life.
 *   • Bubble escapes past the top → no penalty (just a miss).
 *
 * Difficulty scales with score: bubbles get faster and spawn more frequently.
 * 3 lives.  Fixed timer (30–120 s, set by slider).
 * Game ends when timer hits 0 or lives reach 0.
 *
 * gameType: 'bubbleburst'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container      = document.getElementById('bubContainer');
    const canvas         = document.getElementById('bubCanvas');
    const ctx            = canvas.getContext('2d');
    const startBtn       = document.getElementById('startBubBtn');
    const resetBtn       = document.getElementById('resetBubBtn');
    const fsBtn          = document.getElementById('fullscreenBubBtn');
    const backBtn        = document.getElementById('backBubBtn');
    const scoreEl        = document.getElementById('bubScore');
    const timerEl        = document.getElementById('bubTimer');
    const livesEl        = document.getElementById('bubLives');
    const comboEl        = document.getElementById('bubCombo');
    const messageEl      = document.getElementById('bubMessage');
    const targetImgEl    = document.getElementById('bubTargetImg');
    const targetRingEl   = document.getElementById('bubTargetRing');
    const durationSlider = document.getElementById('bubDuration');
    const durationValEl  = document.getElementById('bubDurationVal');
    const usernameInput  = document.getElementById('bubUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    durationSlider.addEventListener('input', () => {
        durationValEl.textContent = durationSlider.value;
    });

    // ── Canvas logical size ───────────────────────────────────────────────────
    const GW = 640;
    const GH = 500;
    canvas.width  = GW;
    canvas.height = GH;

    // ── Bubble constants ──────────────────────────────────────────────────────
    const R_MIN   = 42;   // minimum bubble radius (px)
    const R_MAX   = 66;   // maximum bubble radius
    const BASE_VY = -90;  // base upward speed (px/s, negative = up)
    const MAX_VY  = -220; // maximum upward speed at full difficulty
    const TARGET_RATIO = 0.28;  // 28 % of spawned bubbles are targets

    // ── Colour palette per bubble state ──────────────────────────────────────
    const TARGET_RIM  = { r: 0,   g: 255, b: 140 }; // green
    const DECOY_RIM   = { r: 190, g: 100, b: 255 }; // purple

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages  = [];
    let imageEls   = {};  // url → HTMLImageElement (lazy-loaded)

    async function loadCollection() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('BubbleBurst: load error', e); }
    }

    function getOrLoadImg(url) {
        if (imageEls[url]) return imageEls[url];
        const el = new Image();
        el.crossOrigin = 'anonymous';
        el.src         = url;
        imageEls[url]  = el;
        return el;
    }

    function preloadPool(urls) {
        urls.forEach(url => getOrLoadImg(url));
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ── Game state ────────────────────────────────────────────────────────────
    let state = {
        active:    false,
        score:     0,
        lives:     3,
        combo:     1,
        timeLeft:  60,
        startTime: null,
        target:    null,  // { url, ... }
    };

    // ── Entity arrays ─────────────────────────────────────────────────────────
    let bubbles   = [];
    let particles = [];
    let floatTexts = [];

    // ── Spawn scheduling ──────────────────────────────────────────────────────
    let lastSpawnTs  = 0;
    let spawnCounter = 0;   // used to guarantee minimum target density

    function getSpawnDelay() {
        // 1500 ms → 420 ms as score climbs
        return Math.max(420, 1500 - Math.floor(state.score / 800) * 80);
    }

    function getCurrentVY() {
        const t = Math.min(1, state.score / 4000);
        return BASE_VY + (MAX_VY - BASE_VY) * t;
    }

    // ── Bubble factory ────────────────────────────────────────────────────────
    let bubbleId = 0;

    function spawnBubble(ts) {
        lastSpawnTs = ts;
        spawnCounter++;

        // Guarantee a target bubble at least every 4 spawns
        const forceTarget = (spawnCounter % 4 === 0);
        const isTarget     = forceTarget || Math.random() < TARGET_RATIO;

        const imgObj = isTarget
            ? state.target
            : allImages[Math.floor(Math.random() * allImages.length)];

        if (!imgObj) return;

        const radius = R_MIN + Math.random() * (R_MAX - R_MIN);
        const margin = radius + 10;
        const x      = margin + Math.random() * (GW - margin * 2);
        const vy     = getCurrentVY() * (0.85 + Math.random() * 0.3);

        bubbles.push({
            id:          bubbleId++,
            x,
            originX:    x,
            y:          GH + radius,
            vy,
            radius,
            imgObj,
            isTarget,
            // Sine-wave lateral drift
            phase:      Math.random() * Math.PI * 2,
            driftAmp:   12 + Math.random() * 20,
            driftFreq:  0.4 + Math.random() * 0.5,
            // Wobble
            wobblePhase: Math.random() * Math.PI * 2,
            // Display
            opacity:    0,
            state:      'rising',  // 'rising' | 'popping' | 'done'
            popT:       0,
        });

        // Eagerly load the image so it's ready before the bubble is visible
        getOrLoadImg(imgObj.url);
    }

    // ── Particle factory ──────────────────────────────────────────────────────
    function spawnParticles(x, y, rim, count) {
        const { r, g, b } = rim;
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const spd   = 80 + Math.random() * 180;
            particles.push({
                x, y,
                vx:      Math.cos(angle) * spd,
                vy:      Math.sin(angle) * spd,
                life:    1,
                maxLife: 0.35 + Math.random() * 0.3,
                color:   `rgb(${r},${g},${b})`,
                r:       2.5 + Math.random() * 3.5,
            });
        }
    }

    // ── Floating text factory ─────────────────────────────────────────────────
    function spawnFloatText(x, y, text, color) {
        floatTexts.push({ x, y, vy: -75, text, color, opacity: 1, life: 1.1 });
    }

    // ── Background (pre-built gradient + starfield) ───────────────────────────
    let bgGrad = null;
    const STARS = Array.from({ length: 55 }, () => ({
        x: Math.random() * GW,
        y: Math.random() * GH,
        r: 0.5 + Math.random() * 1.5,
        a: 0.1 + Math.random() * 0.35,
    }));

    function drawBackground() {
        if (!bgGrad) {
            bgGrad = ctx.createLinearGradient(0, 0, 0, GH);
            bgGrad.addColorStop(0,    '#010015');
            bgGrad.addColorStop(0.45, '#05022a');
            bgGrad.addColorStop(1,    '#0d0545');
        }
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, GW, GH);

        // Stars
        for (const s of STARS) {
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,255,255,${s.a})`;
            ctx.fill();
        }
    }

    // ── Draw one glass bubble ─────────────────────────────────────────────────
    function drawBubble(b) {
        if (b.state === 'done') return;

        const wobble = 1 + 0.03 * Math.sin(b.wobblePhase);
        let   scale  = wobble;
        let   alpha  = b.opacity;

        if (b.state === 'popping') {
            scale *= 1 + b.popT * 0.9;
            alpha  = b.opacity * (1 - b.popT);
        }

        const r   = b.radius * scale;
        const rim = b.isTarget ? TARGET_RIM : DECOY_RIM;

        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.translate(b.x, b.y);

        // ── Drop shadow ───────────────────────────────────────────
        ctx.save();
        ctx.globalAlpha *= 0.28;
        const sg = ctx.createRadialGradient(5, 8, 0, 5, 8, r * 1.15);
        sg.addColorStop(0, 'rgba(0,0,0,0.7)');
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(5, 8, r * 1.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // ── Image clipped to inner circle ─────────────────────────
        const inner = r * 0.86;
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, inner, 0, Math.PI * 2);
        ctx.clip();
        const el = imageEls[b.imgObj.url];
        if (el && el.complete && el.naturalWidth > 0) {
            // Centre-crop: draw source as a square from its shortest dimension
            const nw  = el.naturalWidth, nh = el.naturalHeight;
            const dim = Math.min(nw, nh);
            const sx  = (nw - dim) / 2, sy = (nh - dim) / 2;
            ctx.drawImage(el, sx, sy, dim, dim, -inner, -inner, inner * 2, inner * 2);
        } else {
            // Placeholder while image loads
            ctx.fillStyle = `rgba(${rim.r},${rim.g},${rim.b},0.12)`;
            ctx.fillRect(-inner, -inner, inner * 2, inner * 2);
        }
        ctx.restore();

        // ── Outer rim (coloured ring) ─────────────────────────────
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rim.r},${rim.g},${rim.b},0.92)`;
        ctx.lineWidth   = b.isTarget ? 3.8 : 2.6;
        ctx.stroke();

        // ── Inner soft glow ring ──────────────────────────────────
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.91, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rim.r},${rim.g},${rim.b},0.18)`;
        ctx.lineWidth   = 6;
        ctx.stroke();

        // ── Main top-left lens flare ──────────────────────────────
        const hlx = -r * 0.24, hly = -r * 0.30;
        const hlg = ctx.createRadialGradient(hlx, hly, 0, hlx, hly, r * 0.46);
        hlg.addColorStop(0,   'rgba(255,255,255,0.65)');
        hlg.addColorStop(0.4, 'rgba(255,255,255,0.22)');
        hlg.addColorStop(1,   'rgba(255,255,255,0)');
        ctx.fillStyle = hlg;
        ctx.beginPath();
        ctx.ellipse(hlx, hly, r * 0.40, r * 0.24, -0.45, 0, Math.PI * 2);
        ctx.fill();

        // ── Small secondary reflection bottom-right ────────────────
        const brg = ctx.createRadialGradient(r*0.22, r*0.56, 0, r*0.22, r*0.56, r*0.16);
        brg.addColorStop(0, 'rgba(255,255,255,0.28)');
        brg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = brg;
        ctx.beginPath();
        ctx.ellipse(r*0.22, r*0.56, r*0.14, r*0.08, 0.38, 0, Math.PI * 2);
        ctx.fill();

        // ── Rim glow for target bubbles (pulsing) ─────────────────
        if (b.isTarget) {
            const pulse = 0.5 + 0.5 * Math.sin(b.wobblePhase * 1.4);
            ctx.beginPath();
            ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(0,255,140,${0.12 + pulse * 0.14})`;
            ctx.lineWidth   = 5;
            ctx.stroke();
        }

        ctx.restore();
    }

    // ── Particles ─────────────────────────────────────────────────────────────
    function updateParticles(dt) {
        particles = particles.filter(p => p.life > 0);
        for (const p of particles) {
            p.x   += p.vx * dt;
            p.y   += p.vy * dt;
            p.vy  += 220 * dt; // gravity
            p.vx  *= 0.97;
            p.life -= dt / p.maxLife;
        }
    }

    function drawParticles() {
        for (const p of particles) {
            ctx.globalAlpha = Math.max(0, p.life) * 0.9;
            ctx.fillStyle   = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * Math.max(0.1, p.life), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    // ── Floating texts ────────────────────────────────────────────────────────
    function updateFloatTexts(dt) {
        floatTexts = floatTexts.filter(t => t.life > 0);
        for (const t of floatTexts) {
            t.y    += t.vy * dt;
            t.life -= dt / 1.1;
            t.opacity = Math.max(0, t.life);
        }
    }

    function drawFloatTexts() {
        ctx.save();
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.font         = 'bold 22px Segoe UI, sans-serif';
        for (const t of floatTexts) {
            ctx.globalAlpha = t.opacity;
            // Outline for readability
            ctx.strokeStyle = 'rgba(0,0,0,0.65)';
            ctx.lineWidth   = 4;
            ctx.strokeText(t.text, t.x, t.y);
            ctx.fillStyle   = t.color;
            ctx.fillText(t.text, t.x, t.y);
        }
        ctx.globalAlpha  = 1;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.restore();
    }

    // ── Update ────────────────────────────────────────────────────────────────
    function update(dt, ts) {
        if (!state.active) return;

        // Timer
        state.timeLeft = Math.max(0, state.timeLeft - dt);
        timerEl.textContent = Math.ceil(state.timeLeft);
        if (state.timeLeft <= 0) { endGame(); return; }

        // Spawn
        if (ts - lastSpawnTs >= getSpawnDelay()) spawnBubble(ts);

        // Move bubbles
        for (const b of bubbles) {
            if (b.state === 'done') continue;
            if (b.state === 'popping') {
                b.popT = Math.min(1, b.popT + dt * 3.2);
                if (b.popT >= 1) b.state = 'done';
                continue;
            }

            // Lateral sine drift
            b.phase       += dt * b.driftFreq;
            b.wobblePhase += dt * 2.5;
            b.x = b.originX + Math.sin(b.phase) * b.driftAmp;
            // Clamp to canvas
            const edge = b.radius + 4;
            b.x = Math.max(edge, Math.min(GW - edge, b.x));

            // Rise
            b.y += b.vy * dt;

            // Opacity: fade in from spawn, fade out near top
            const fadeInZone  = b.radius * 3;
            const fadeOutZone = b.radius * 2.5;
            if (GH - b.y < fadeInZone) {
                b.opacity = Math.min(1, (GH - b.y) / fadeInZone);
            } else if (b.y - b.radius < fadeOutZone) {
                b.opacity = Math.max(0, (b.y - b.radius) / fadeOutZone);
            } else {
                b.opacity = 1;
            }

            // Escaped past top
            if (b.y + b.radius < 0) b.state = 'done';
        }

        // Prune done bubbles
        bubbles = bubbles.filter(b => b.state !== 'done');

        updateParticles(dt);
        updateFloatTexts(dt);
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function render() {
        drawBackground();

        // Sort rising bubbles so smaller (harder) ones appear on top
        const visible = bubbles.filter(b => b.state !== 'done');
        visible.sort((a, b_) => b_.radius - a.radius);
        for (const b of visible) drawBubble(b);

        drawParticles();
        drawFloatTexts();
    }

    // ── Game loop ─────────────────────────────────────────────────────────────
    let rafId  = null;
    let lastTs = null;

    function frame(ts) {
        if (!state.active) return;
        const dt = Math.min((ts - (lastTs || ts)) / 1000, 0.05);
        lastTs   = ts;
        update(dt, ts);
        render();
        rafId = requestAnimationFrame(frame);
    }

    // ── Click / tap handler ───────────────────────────────────────────────────
    function handleCanvasClick(clientX, clientY) {
        if (!state.active) return;

        const rect   = canvas.getBoundingClientRect();
        const scale  = GW / rect.width;
        const cx     = (clientX - rect.left) * scale;
        const cy     = (clientY - rect.top)  * scale;

        // Find topmost rising bubble under the click (iterate backwards = rendered-on-top first)
        let hit = null;
        for (let i = visible_snapshot.length - 1; i >= 0; i--) {
            const b  = visible_snapshot[i];
            const dx = cx - b.x, dy = cy - b.y;
            if (dx * dx + dy * dy <= b.radius * b.radius) { hit = b; break; }
        }
        if (!hit) return;

        // Pop it
        hit.state = 'popping';
        hit.popT  = 0;

        const rim = hit.isTarget ? TARGET_RIM : DECOY_RIM;
        spawnParticles(cx, cy, rim, 14);

        if (hit.isTarget) {
            // ── Correct ──────────────────────────────────────────────
            state.combo = Math.min(10, state.combo + 1);
            // Size bonus: smaller bubble = harder = more points (1.0–1.5×)
            const sizeBonus = 1 + (R_MAX - hit.radius) / (R_MAX - R_MIN) * 0.5;
            const pts       = Math.round(100 * state.combo * sizeBonus);
            state.score    += pts;
            scoreEl.textContent = state.score;
            comboEl.textContent = `×${state.combo}`;
            comboEl.classList.toggle('bub-combo--hot', state.combo >= 4);
            spawnFloatText(cx, cy - hit.radius - 10, `+${pts}`, '#00ff8c');

        } else {
            // ── Wrong decoy ──────────────────────────────────────────
            state.combo  = 1;
            state.lives  = Math.max(0, state.lives - 1);
            state.score  = Math.max(0, state.score - 75);
            scoreEl.textContent = state.score;
            comboEl.textContent = '×1';
            comboEl.classList.remove('bub-combo--hot');
            renderLives();
            spawnFloatText(cx, cy - hit.radius - 10, '−75', '#ff4d6d');
            // Shake the lives counter for emphasis
            livesEl.classList.add('bub-shake');
            setTimeout(() => livesEl.classList.remove('bub-shake'), 400);

            if (state.lives <= 0) {
                // Small delay so the pop animation shows
                setTimeout(endGame, 600);
            }
        }
    }

    // We snapshot the visible bubbles list each frame so click handler
    // can check the same list that was just rendered.
    let visible_snapshot = [];

    // Patch the render loop to capture snapshot
    const _origRender = render;
    const patchedRender = function () {
        visible_snapshot = bubbles.filter(b => b.state === 'rising');
        _origRender();
    };

    canvas.addEventListener('click', e => {
        handleCanvasClick(e.clientX, e.clientY);
    });
    canvas.addEventListener('touchstart', e => {
        e.preventDefault();
        handleCanvasClick(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    // Patch frame to use patched render
    function frameFinal(ts) {
        if (!state.active) return;
        const dt = Math.min((ts - (lastTs || ts)) / 1000, 0.05);
        lastTs   = ts;
        update(dt, ts);
        patchedRender();
        rafId = requestAnimationFrame(frameFinal);
    }

    // ── Lives display ─────────────────────────────────────────────────────────
    function renderLives() {
        livesEl.textContent = '❤️'.repeat(state.lives) + '🖤'.repeat(3 - state.lives);
    }

    // ── Game lifecycle ────────────────────────────────────────────────────────
    async function initGame() {
        if (allImages.length < 4) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 4 images to play!</div>';
            return;
        }

        cancelAnimationFrame(rafId);

        const duration = parseInt(durationSlider.value, 10);

        // Pick a random target
        const target = allImages[Math.floor(Math.random() * allImages.length)];

        // Preload target + first batch of decoys eagerly
        const decoys = shuffle(allImages.filter(i => i.url !== target.url)).slice(0, 25);
        preloadPool([target, ...decoys].map(i => i.url));

        state = {
            active:    true,
            score:     0,
            lives:     3,
            combo:     1,
            timeLeft:  duration,
            startTime: Date.now(),
            target,
        };

        bubbles    = [];
        particles  = [];
        floatTexts = [];
        visible_snapshot = [];
        lastSpawnTs  = 0;
        spawnCounter = 0;

        scoreEl.textContent = '0';
        timerEl.textContent = duration;
        comboEl.textContent = '×1';
        comboEl.classList.remove('bub-combo--hot');
        renderLives();
        messageEl.innerHTML = '';

        // Show target in the HUD
        targetImgEl.src    = target.url;
        targetRingEl.classList.add('bub-target-ring--active');

        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';

        lastTs = null;
        rafId  = requestAnimationFrame(frameFinal);
    }

    function endGame() {
        if (!state.active) return;
        state.active = false;
        cancelAnimationFrame(rafId);

        targetRingEl.classList.remove('bub-target-ring--active');

        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-soap"></i>
                <h2>${state.lives > 0 ? 'Time\'s Up!' : 'Game Over!'}</h2>
                <p>Final Score: <strong>${state.score}</strong></p>
                <p>Best Combo: <strong>×${comboEl.textContent.replace('×','')}</strong></p>
            </div>`;

        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';

        const user = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType:   'bubbleburst',
                score:      state.score,
                time:       elapsed,
                username:   user,
            })
        }).catch(() => {});
    }

    function resetGame() {
        cancelAnimationFrame(rafId);
        state.active = false;
        bubbles      = [];
        particles    = [];
        floatTexts   = [];
        visible_snapshot = [];
        targetRingEl.classList.remove('bub-target-ring--active');
        targetImgEl.src = '';
        messageEl.innerHTML = '';
        scoreEl.textContent = '0';
        timerEl.textContent = durationSlider.value;
        comboEl.textContent = '×1';
        comboEl.classList.remove('bub-combo--hot');
        livesEl.textContent = '❤️❤️❤️';
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
        // Draw idle canvas
        drawBackground();
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
        });
    }

    // ── Wiring ────────────────────────────────────────────────────────────────
    startBtn.addEventListener('click', initGame);
    resetBtn.addEventListener('click', resetGame);
    backBtn.addEventListener('click', () => {
        cancelAnimationFrame(rafId);
        if (document.fullscreenElement) document.exitFullscreen();
        window.location.href = `/collection/${COLLECTION}`;
    });

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    await loadCollection();
    timerEl.textContent = durationSlider.value;

    if (allImages.length < 4) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:2rem">Need at least 4 images to play!</div>';
        startBtn.disabled = true;
    }

    // Draw idle background
    drawBackground();
    ctx.fillStyle    = 'rgba(255,255,255,0.07)';
    ctx.font         = '17px Segoe UI, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Press Start to begin', GW / 2, GH / 2);
});

/**
 * Image Pong — Arkanoid / Breakout with collection images
 *
 * Each round:
 *   • An image from the collection is hidden behind a grid of coloured tiles.
 *   • A ball bounces around, smashing tiles and revealing the image beneath.
 *   • The player controls a paddle (mouse / touch / arrow keys).
 *   • At any time click one of the 4 option thumbnails to guess.
 *       Correct  → +200 base + up to +800 early-guess bonus (tiles still covered).
 *       Wrong    → −1 life; ball keeps going; try again.
 *   • Ball falls below paddle → −1 life; ball resets on paddle.
 *   • All tiles broken with no guess → round ends, no guess bonus.
 *   • 3 lives total; game over when lives reach 0.
 *
 * gameType: 'breakout'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container     = document.getElementById('bkContainer');
    const canvas        = document.getElementById('bkCanvas');
    const ctx           = canvas.getContext('2d');
    const startBtn      = document.getElementById('startBkBtn');
    const resetBtn      = document.getElementById('resetBkBtn');
    const fsBtn         = document.getElementById('fullscreenBkBtn');
    const backBtn       = document.getElementById('backBkBtn');
    const scoreEl       = document.getElementById('bkScore');
    const roundEl       = document.getElementById('bkRound');
    const livesEl       = document.getElementById('bkLives');
    const tilesEl       = document.getElementById('bkTiles');
    const messageEl     = document.getElementById('bkMessage');
    const optionsEl     = document.getElementById('bkOptions');
    const speedSlider   = document.getElementById('bkSpeed');
    const speedValEl    = document.getElementById('bkSpeedVal');
    const gridSizeSel   = document.getElementById('bkGridSize');
    const usernameInput = document.getElementById('bkUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    const SPEED_LABELS = ['Slow', 'Normal', 'Fast', 'Faster', 'Extreme'];
    speedSlider.addEventListener('input', () => {
        speedValEl.textContent = SPEED_LABELS[speedSlider.value - 1];
    });

    // ── Logical game dimensions (canvas coords) ───────────────────────────────
    const GW = 640;
    const GH = 580;   // taller canvas so the tile zone can hold a full image

    // Tile zone — tall enough to contain portrait images without cropping.
    // Tiles go from TILE_PAD_TOP → TILE_ZONE_H (y-axis).
    // Width: TILE_PAD_SIDE → GW-TILE_PAD_SIDE.
    // Tile zone ratio: (GW-2*TILE_PAD_SIDE) / (TILE_ZONE_H-TILE_PAD_TOP)
    //               = 608 / 418 ≈ 1.45 : 1  — works for portrait, square, landscape.
    const TILE_PAD_TOP  = 28;   // gap above first tile row
    const TILE_PAD_SIDE = 16;   // left/right margin
    const TILE_GAP      = 3;    // gap between tiles
    const TILE_ZONE_H   = 446;  // bottom y of tile area; leaves ~90px for ball play

    // Ball
    const BALL_R = 8;

    // Paddle — sits below the tile zone with enough ball-play space
    const PAD_H    = 13;
    const PAD_Y    = GH - 44;   // paddle top-edge y (= 536)
    const PAD_MINW = 80;

    // Row colours (top = hardest, red; fading to cool blues at bottom)
    const ROW_COLORS = [
        '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
        '#1abc9c', '#3498db', '#9b59b6', '#e84393',
        '#00b894', '#fd79a8', '#6c5ce7', '#74b9ff',
    ];

    canvas.width  = GW;
    canvas.height = GH;

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];

    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('Breakout: load error', e); }
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
        active:     false,
        round:      0,
        score:      0,
        lives:      3,
        startTime:  null,
        target:     null,   // { url, tags, ... }
        answered:   false,
        tilesTotal: 0,
        tilesLeft:  0,
    };

    // ── Physics objects ───────────────────────────────────────────────────────
    let tiles   = [];  // { x, y, w, h, alive, row }
    let ball    = { x: GW / 2, y: PAD_Y - BALL_R - 2, vx: 0, vy: 0, launched: false };
    let paddle  = { x: (GW - 100) / 2, y: PAD_Y, w: 100 };
    let currentImg = null;

    let rafId  = null;
    let lastTs = null;
    let keys   = {};

    // Particle effects
    let particles = [];  // { x, y, vx, vy, life, maxLife, color, r }

    // ── Settings helpers ──────────────────────────────────────────────────────
    function getBallSpeed() {
        // Slider 1-5 → 210-440 px/s
        return 210 + (parseInt(speedSlider.value, 10) - 1) * 57;
    }

    function getGridDims() {
        const [c, r] = gridSizeSel.value.split('x').map(Number);
        return { cols: c, rows: r };
    }

    function getPaddleWidth() {
        // Wider paddle on easy grids, narrower on brutal
        const w = parseInt(gridSizeSel.value.split('x')[0], 10);
        return Math.max(PAD_MINW, 130 - (w - 8) * 6);
    }

    // ── Tile builder ──────────────────────────────────────────────────────────
    function buildTiles(cols, rows) {
        tiles = [];
        const availW = GW - TILE_PAD_SIDE * 2;
        const availH = TILE_ZONE_H - TILE_PAD_TOP;
        const tileW  = (availW - TILE_GAP * (cols - 1)) / cols;
        const tileH  = (availH - TILE_GAP * (rows - 1)) / rows;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                tiles.push({
                    x:     TILE_PAD_SIDE + c * (tileW + TILE_GAP),
                    y:     TILE_PAD_TOP  + r * (tileH + TILE_GAP),
                    w:     tileW,
                    h:     tileH,
                    alive: true,
                    row:   r,
                });
            }
        }

        state.tilesTotal = tiles.length;
        state.tilesLeft  = tiles.length;
        tilesEl.textContent = tiles.length;
    }

    // ── Ball helpers ──────────────────────────────────────────────────────────
    function resetBall() {
        paddle.w  = getPaddleWidth();
        ball.x    = paddle.x + paddle.w / 2;
        ball.y    = PAD_Y - BALL_R - 2;
        ball.vx   = 0;
        ball.vy   = 0;
        ball.launched = false;
    }

    function launchBall() {
        if (ball.launched) return;
        const speed = getBallSpeed();
        // Random launch angle: between -30° and +30° from straight up
        const angle = (Math.random() * 0.55 - 0.275) * Math.PI;
        ball.vx = speed * Math.sin(angle);
        ball.vy = -speed * Math.cos(angle);
        ball.launched = true;
    }

    // Keep ball speed constant (repeated bounces can slow it)
    function normaliseBallSpeed() {
        const spd    = Math.hypot(ball.vx, ball.vy);
        const target = getBallSpeed();
        if (spd < target * 0.8 || spd > target * 1.25) {
            const k = target / spd;
            ball.vx *= k;
            ball.vy *= k;
        }
    }

    // ── Tile collision ────────────────────────────────────────────────────────
    function ballHitsTile(t) {
        const cx = Math.max(t.x, Math.min(ball.x, t.x + t.w));
        const cy = Math.max(t.y, Math.min(ball.y, t.y + t.h));
        return (ball.x - cx) ** 2 + (ball.y - cy) ** 2 <= BALL_R ** 2;
    }

    function resolveTileBounce(t) {
        // Compute overlaps on each side to determine axis of collision
        const overlapL = (ball.x + BALL_R) - t.x;
        const overlapR = (t.x + t.w) - (ball.x - BALL_R);
        const overlapT = (ball.y + BALL_R) - t.y;
        const overlapB = (t.y + t.h) - (ball.y - BALL_R);

        const minH = Math.min(overlapL, overlapR);
        const minV = Math.min(overlapT, overlapB);

        if (minV <= minH) {
            // Vertical bounce — push ball out
            ball.vy *= -1;
            if (overlapT < overlapB) ball.y -= (overlapT - BALL_R * 0.5);
            else                      ball.y += (overlapB - BALL_R * 0.5);
        } else {
            // Horizontal bounce — push ball out
            ball.vx *= -1;
            if (overlapL < overlapR) ball.x -= (overlapL - BALL_R * 0.5);
            else                      ball.x += (overlapR - BALL_R * 0.5);
        }
    }

    // ── Particles ─────────────────────────────────────────────────────────────
    function spawnParticles(x, y, color) {
        for (let i = 0; i < 8; i++) {
            const angle = Math.random() * Math.PI * 2;
            const spd   = 60 + Math.random() * 120;
            particles.push({
                x, y,
                vx:      Math.cos(angle) * spd,
                vy:      Math.sin(angle) * spd,
                life:    1,
                maxLife: 0.45 + Math.random() * 0.3,
                color,
                r:       2 + Math.random() * 3,
            });
        }
    }

    function updateParticles(dt) {
        particles = particles.filter(p => p.life > 0);
        for (const p of particles) {
            p.x  += p.vx * dt;
            p.y  += p.vy * dt;
            p.vy += 180 * dt; // gravity
            p.life -= dt / p.maxLife;
        }
    }

    function drawParticles() {
        for (const p of particles) {
            ctx.globalAlpha = Math.max(0, p.life) * 0.85;
            ctx.fillStyle   = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * Math.max(0, p.life), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    // ── Update ────────────────────────────────────────────────────────────────
    function update(dt) {
        if (!state.active || state.answered) return;

        updateParticles(dt);

        // ── Keyboard / gamepad paddle ──────────────────────────────────────
        const padSpd = 450;
        if (keys['ArrowLeft']  || keys['a'] || keys['A']) paddle.x -= padSpd * dt;
        if (keys['ArrowRight'] || keys['d'] || keys['D']) paddle.x += padSpd * dt;
        paddle.x = Math.max(0, Math.min(GW - paddle.w, paddle.x));

        // ── Ball follows paddle before launch ──────────────────────────────
        if (!ball.launched) {
            ball.x = paddle.x + paddle.w / 2;
            ball.y = PAD_Y - BALL_R - 2;
            return;
        }

        // ── Move ball ─────────────────────────────────────────────────────
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;

        // ── Wall bounces ──────────────────────────────────────────────────
        if (ball.x - BALL_R < 0)  { ball.x = BALL_R;        ball.vx =  Math.abs(ball.vx); }
        if (ball.x + BALL_R > GW) { ball.x = GW - BALL_R;   ball.vx = -Math.abs(ball.vx); }
        if (ball.y - BALL_R < 0)  { ball.y = BALL_R;         ball.vy =  Math.abs(ball.vy); }

        // ── Ball lost ─────────────────────────────────────────────────────
        if (ball.y - BALL_R > GH + 30) {
            onBallLost();
            return;
        }

        // ── Paddle bounce ─────────────────────────────────────────────────
        if (ball.vy > 0
            && ball.y + BALL_R >= paddle.y
            && ball.y - BALL_R <= paddle.y + PAD_H
            && ball.x + BALL_R >= paddle.x
            && ball.x - BALL_R <= paddle.x + paddle.w)
        {
            // Angle based on hit position (±60° max)
            const hitPos = (ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2);
            const angle  = hitPos * (Math.PI / 3);
            const spd    = Math.hypot(ball.vx, ball.vy);
            ball.vx = spd * Math.sin(angle);
            ball.vy = -Math.abs(spd * Math.cos(angle));
            // Prevent ball embedding in paddle
            ball.y  = paddle.y - BALL_R - 1;
        }

        // ── Tile collisions (one per frame to prevent tunnelling issues) ──
        let hitTile = null;
        for (const t of tiles) {
            if (!t.alive) continue;
            if (ballHitsTile(t)) { hitTile = t; break; }
        }

        if (hitTile) {
            const color = ROW_COLORS[hitTile.row % ROW_COLORS.length];
            hitTile.alive = false;
            state.tilesLeft--;
            state.score  += 10;
            scoreEl.textContent = state.score;
            tilesEl.textContent = state.tilesLeft;
            resolveTileBounce(hitTile);
            spawnParticles(
                hitTile.x + hitTile.w / 2,
                hitTile.y + hitTile.h / 2,
                color
            );

            if (state.tilesLeft === 0) {
                onAllTilesCleared();
                return;
            }
        }

        normaliseBallSpeed();
    }

    // ── Events ────────────────────────────────────────────────────────────────
    function onBallLost() {
        state.lives--;
        renderLives();

        if (state.lives <= 0) {
            endGame();
            return;
        }

        messageEl.innerHTML =
            '<div class="feedback error"><i class="fas fa-circle-xmark"></i> Ball lost! Relaunch…</div>';
        setTimeout(() => { if (state.active) messageEl.innerHTML = ''; }, 1400);
        resetBall();
    }

    function onAllTilesCleared() {
        // Image fully revealed — no guess bonus this round
        state.answered = true;
        ball.launched  = false;
        ball.vx = ball.vy = 0;
        revealCorrectOption();
        render(); // show fully revealed image immediately

        messageEl.innerHTML =
            '<div class="feedback info"><i class="fas fa-eye"></i> Fully revealed — no bonus this round!</div>';
        setTimeout(() => { if (state.active) startRound(); }, 2600);
    }

    // ── Guess handler ─────────────────────────────────────────────────────────
    function handleGuess(url, cardEl) {
        if (!state.active || state.lives <= 0) return;
        // Disable all options briefly on any click
        document.querySelectorAll('.bk-opt').forEach(c => (c.style.pointerEvents = 'none'));

        if (url === state.target.url) {
            // ─── CORRECT ───────────────────────────────────────────────
            state.answered = true;
            ball.launched  = false;
            ball.vx = ball.vy = 0;

            // Calculate bonus BEFORE clearing tiles (uses current tilesLeft).
            const bonus = Math.round((state.tilesLeft / state.tilesTotal) * 800);
            state.score += 200 + bonus;

            // Destroy every remaining tile so the full image is revealed
            // in the game panel immediately (render loop picks this up).
            tiles.forEach(t => { t.alive = false; });
            state.tilesLeft = 0;
            tilesEl.textContent = 0;
            scoreEl.textContent = state.score;

            cardEl.classList.add('bk-opt--correct');
            spawnWinParticles();

            messageEl.innerHTML = `
                <div class="feedback success">
                    <i class="fas fa-check-circle"></i>
                    Correct! <strong>+${200 + bonus}</strong>
                    ${bonus > 50 ? `<span class="streak-bonus">Early bonus +${bonus}!</span>` : ''}
                </div>`;

            setTimeout(() => { if (state.active) startRound(); }, 2200);

        } else {
            // ─── WRONG ─────────────────────────────────────────────────
            state.lives--;
            renderLives();
            cardEl.classList.add('bk-opt--wrong');

            if (state.lives <= 0) {
                state.answered = true;
                ball.launched  = false;
                revealCorrectOption();
                setTimeout(endGame, 1800);
            } else {
                messageEl.innerHTML =
                    '<div class="feedback error"><i class="fas fa-times-circle"></i> Wrong! Keep guessing…</div>';
                // Re-enable after brief flash (remove wrong class + re-enable pointer)
                setTimeout(() => {
                    if (state.active && !state.answered) {
                        cardEl.classList.remove('bk-opt--wrong');
                        document.querySelectorAll('.bk-opt').forEach(c => {
                            c.style.pointerEvents = 'auto';
                        });
                        messageEl.innerHTML = '';
                    }
                }, 900);
            }
        }
    }

    function revealCorrectOption() {
        document.querySelectorAll('.bk-opt').forEach(card => {
            const img = card.querySelector('img');
            if (!img) return;
            const src = decodeURIComponent(img.src).replace(window.location.origin, '');
            const tgt = decodeURIComponent(state.target.url).replace(window.location.origin, '');
            if (src === tgt || img.src === state.target.url) {
                card.classList.add('bk-opt--correct');
            }
        });
    }

    function spawnWinParticles() {
        // Burst of gold/pink particles across the canvas
        const colors = ['#ffd700','#ff6b9d','#a29bfe','#00cec9'];
        for (let i = 0; i < 40; i++) {
            const color = colors[Math.floor(Math.random() * colors.length)];
            particles.push({
                x:       Math.random() * GW,
                y:       Math.random() * GH * 0.6,
                vx:      (Math.random() - 0.5) * 160,
                vy:      -60 - Math.random() * 100,
                life:    1,
                maxLife: 0.7 + Math.random() * 0.5,
                color,
                r:       3 + Math.random() * 4,
            });
        }
    }

    // ── Image draw rect (contain inside tile zone — no stretching, no cropping) ─
    // Fits the image within the tile zone rectangle preserving natural aspect ratio.
    // The tile zone is the only area the image ever appears in (clip-based reveal),
    // so fitting here guarantees the full image is visible when all tiles are gone.
    function imgDrawRect(img) {
        const tzX = TILE_PAD_SIDE;
        const tzY = TILE_PAD_TOP;
        const tzW = GW - TILE_PAD_SIDE * 2;   // 608
        const tzH = TILE_ZONE_H - TILE_PAD_TOP; // 418

        const ir = img.naturalWidth / img.naturalHeight;
        const tr = tzW / tzH;   // tile-zone aspect ratio ≈ 1.45

        let dw, dh, dx, dy;
        if (ir > tr) {   // image wider than zone → fit width, centre vertically
            dw = tzW;  dh = tzW / ir;
            dx = tzX;  dy = tzY + (tzH - dh) / 2;
        } else {         // image taller than zone → fit height, centre horizontally
            dh = tzH;  dw = tzH * ir;
            dy = tzY;  dx = tzX + (tzW - dw) / 2;
        }
        return { dx, dy, dw, dh };
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function render() {
        ctx.clearRect(0, 0, GW, GH);

        // ── 1. Solid opaque background — nothing visible yet ───────────
        ctx.fillStyle = '#07050f';
        ctx.fillRect(0, 0, GW, GH);

        // ── 2. Image revealed ONLY through destroyed tile rectangles ────
        //    Canvas clipping ensures the image is invisible everywhere
        //    else: tile gaps, paddle zone, margins — all stay dark.
        if (currentImg && currentImg.complete && currentImg.naturalWidth > 0) {
            const destroyed = tiles.filter(t => !t.alive);
            if (destroyed.length > 0) {
                ctx.save();
                ctx.beginPath();
                for (const t of destroyed) ctx.rect(t.x, t.y, t.w, t.h);
                ctx.clip();
                const { dx, dy, dw, dh } = imgDrawRect(currentImg);
                ctx.drawImage(currentImg, dx, dy, dw, dh);
                ctx.restore();
            }
        }

        // ── 3. Solid cover for paddle / ball zone (below tile grid) ────
        //    TILE_ZONE_H is the absolute y of the tile zone's bottom edge,
        //    so the fill starts exactly there — no gap, no image bleed.
        ctx.fillStyle = '#07050f';
        ctx.fillRect(0, TILE_ZONE_H, GW, GH - TILE_ZONE_H);

        // ── 4. Alive tiles — fully opaque, no alpha bleed ──────────────
        for (const t of tiles) {
            if (!t.alive) continue;
            const color = ROW_COLORS[t.row % ROW_COLORS.length];

            // Tile body — solid
            ctx.fillStyle = color;
            ctx.fillRect(t.x, t.y, t.w, t.h);

            // Top-left highlight
            ctx.fillStyle = 'rgba(255,255,255,0.28)';
            ctx.fillRect(t.x, t.y, t.w, 2);
            ctx.fillRect(t.x, t.y, 2, t.h);

            // Bottom-right shadow
            ctx.fillStyle = 'rgba(0,0,0,0.22)';
            ctx.fillRect(t.x, t.y + t.h - 2, t.w, 2);
            ctx.fillRect(t.x + t.w - 2, t.y, 2, t.h);
        }

        // ── Particles ──────────────────────────────────────────────────
        drawParticles();

        // ── Paddle ─────────────────────────────────────────────────────
        const padGrad = ctx.createLinearGradient(0, paddle.y, 0, paddle.y + PAD_H);
        padGrad.addColorStop(0, '#ffffff');
        padGrad.addColorStop(0.6, '#ddd8f8');
        padGrad.addColorStop(1,   '#b0a8d8');
        ctx.fillStyle   = padGrad;
        ctx.shadowBlur  = 10;
        ctx.shadowColor = 'rgba(180,160,255,0.7)';
        ctx.beginPath();
        roundRectPath(ctx, paddle.x, paddle.y, paddle.w, PAD_H, 7);
        ctx.fill();
        ctx.shadowBlur  = 0;

        // ── Ball ───────────────────────────────────────────────────────
        // Outer glow
        const glow = ctx.createRadialGradient(ball.x, ball.y, 0, ball.x, ball.y, BALL_R * 3);
        glow.addColorStop(0,   'rgba(255,240,180,0.45)');
        glow.addColorStop(0.5, 'rgba(255,200,100,0.15)');
        glow.addColorStop(1,   'rgba(255,200,100,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, BALL_R * 3, 0, Math.PI * 2);
        ctx.fill();

        // Core
        ctx.fillStyle   = '#fffef5';
        ctx.shadowBlur  = 12;
        ctx.shadowColor = 'rgba(255,230,100,1)';
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur  = 0;

        // ── Launch hint ────────────────────────────────────────────────
        if (state.active && !ball.launched && !state.answered) {
            const text = 'Click / Space to launch';
            ctx.font         = 'bold 14px Segoe UI, sans-serif';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            const tw = ctx.measureText(text).width;
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            roundRectPath(ctx, GW / 2 - tw / 2 - 12, GH - 26, tw + 24, 20, 6);
            ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.82)';
            ctx.fillText(text, GW / 2, GH - 16);
        }

        ctx.textAlign    = 'left';
        ctx.textBaseline = 'alphabetic';
    }

    function roundRectPath(c, x, y, w, h, r) {
        if (c.roundRect) {
            c.roundRect(x, y, w, h, r);
        } else {
            c.beginPath();
            c.moveTo(x + r, y);
            c.lineTo(x + w - r, y);
            c.arcTo(x + w, y, x + w, y + r, r);
            c.lineTo(x + w, y + h - r);
            c.arcTo(x + w, y + h, x + w - r, y + h, r);
            c.lineTo(x + r, y + h);
            c.arcTo(x, y + h, x, y + h - r, r);
            c.lineTo(x, y + r);
            c.arcTo(x, y, x + r, y, r);
            c.closePath();
        }
    }

    // ── Main loop ─────────────────────────────────────────────────────────────
    function frame(ts) {
        if (!state.active) return;
        const dt = Math.min((ts - (lastTs || ts)) / 1000, 0.05);
        lastTs   = ts;
        update(dt);
        render();
        rafId = requestAnimationFrame(frame);
    }

    // ── Round setup ───────────────────────────────────────────────────────────
    function renderLives() {
        livesEl.textContent = '❤️'.repeat(state.lives) + '🖤'.repeat(3 - state.lives);
    }

    function buildOptions(opts) {
        optionsEl.innerHTML = '';
        opts.forEach(imgObj => {
            const card = document.createElement('div');
            card.className = 'bk-opt';

            const img = document.createElement('img');
            img.src      = imgObj.url;
            img.draggable = false;
            card.appendChild(img);

            card.addEventListener('click', () => handleGuess(imgObj.url, card));
            optionsEl.appendChild(card);
        });
    }

    async function startRound() {
        if (!state.active) return;

        cancelAnimationFrame(rafId);
        particles   = [];
        state.answered = false;
        state.round++;
        roundEl.textContent = state.round;
        messageEl.innerHTML = '';

        // Pick target + 3 decoys
        const target = allImages[Math.floor(Math.random() * allImages.length)];
        const others = shuffle(allImages.filter(img => img.url !== target.url)).slice(0, 3);
        state.target = target;

        // Load canvas image
        currentImg = new Image();
        currentImg.crossOrigin = 'anonymous';
        await new Promise(resolve => {
            currentImg.onload  = resolve;
            currentImg.onerror = resolve;
            currentImg.src     = target.url;
        });

        // Build tiles
        const { cols, rows } = getGridDims();
        buildTiles(cols, rows);

        // Reset paddle + ball
        paddle.w = getPaddleWidth();
        paddle.x = (GW - paddle.w) / 2;
        resetBall();

        // Render options
        buildOptions(shuffle([target, ...others]));

        // Draw first frame before loop starts
        render();

        // Kick off game loop
        lastTs = null;
        rafId  = requestAnimationFrame(frame);
    }

    // ── End game ──────────────────────────────────────────────────────────────
    function endGame() {
        state.active = false;
        cancelAnimationFrame(rafId);

        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);

        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-table-tennis-paddle-ball"></i>
                <h2>Game Over!</h2>
                <p>Rounds played: <strong>${state.round}</strong></p>
                <p>Final Score: <strong>${state.score}</strong></p>
            </div>`;

        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';
        optionsEl.innerHTML    = '';

        const user = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType:   'breakout',
                score:      state.score,
                time:       elapsed,
                username:   user,
            })
        }).catch(() => {});
    }

    // ── Init / Reset ──────────────────────────────────────────────────────────
    function initGame() {
        if (allImages.length < 4) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 4 images to play!</div>';
            return;
        }

        cancelAnimationFrame(rafId);
        particles = [];

        state = {
            active:     true,
            round:      0,
            score:      0,
            lives:      3,
            startTime:  Date.now(),
            target:     null,
            answered:   false,
            tilesTotal: 0,
            tilesLeft:  0,
        };

        scoreEl.textContent = '0';
        roundEl.textContent = '0';
        tilesEl.textContent = '—';
        renderLives();
        messageEl.innerHTML    = '';
        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';

        startRound();
    }

    function resetGame() {
        cancelAnimationFrame(rafId);
        state.active = false;
        tiles      = [];
        particles  = [];
        optionsEl.innerHTML = '';
        messageEl.innerHTML = '';
        scoreEl.textContent = '0';
        roundEl.textContent = '0';
        tilesEl.textContent = '—';
        livesEl.textContent = '❤️❤️❤️';
        ctx.fillStyle = '#07050f';
        ctx.fillRect(0, 0, GW, GH);
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
    }

    // ── Input events ──────────────────────────────────────────────────────────

    // Mouse: move paddle + launch
    canvas.addEventListener('mousemove', e => {
        if (!state.active) return;
        const rect   = canvas.getBoundingClientRect();
        const scaleX = GW / rect.width;
        paddle.x = (e.clientX - rect.left) * scaleX - paddle.w / 2;
        paddle.x = Math.max(0, Math.min(GW - paddle.w, paddle.x));
    });

    canvas.addEventListener('click', () => {
        if (state.active && !ball.launched && !state.answered) launchBall();
    });

    // Touch: move paddle + launch
    canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        if (!state.active) return;
        const rect   = canvas.getBoundingClientRect();
        const scaleX = GW / rect.width;
        paddle.x = (e.touches[0].clientX - rect.left) * scaleX - paddle.w / 2;
        paddle.x = Math.max(0, Math.min(GW - paddle.w, paddle.x));
    }, { passive: false });

    canvas.addEventListener('touchstart', e => {
        e.preventDefault();
        if (state.active && !ball.launched && !state.answered) launchBall();
    }, { passive: false });

    // Keyboard
    document.addEventListener('keydown', e => {
        keys[e.key] = true;
        if ((e.key === ' ' || e.key === 'ArrowUp') && state.active && !ball.launched && !state.answered) {
            e.preventDefault();
            launchBall();
        }
    });
    document.addEventListener('keyup', e => { keys[e.key] = false; });

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
    await loadImages();

    // Draw idle screen
    ctx.fillStyle = '#07050f';
    ctx.fillRect(0, 0, GW, GH);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.font = '18px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Press Start Game to begin', GW / 2, GH / 2);

    if (allImages.length < 4) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:2rem">Need at least 4 images to play!</div>';
        startBtn.disabled = true;
    }
});

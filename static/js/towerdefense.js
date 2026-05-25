/**
 * Tower Defense Viewer
 *
 * Images load onto a conveyor belt and march from right to left.
 * The player has N save-tokens. Click any image while it's on the belt
 * to "save" it — it freezes in a heart outline and a thumbnail flies into
 * the Saves panel below.  Images that scroll off the left edge are gone.
 *
 * Score = saved_count × speed_level × 100
 * Using all tokens earns an efficiency bonus.
 *
 * gameType: 'towerdefense'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container     = document.getElementById('tdContainer');
    const startBtn      = document.getElementById('startTdBtn');
    const resetBtn      = document.getElementById('resetTdBtn');
    const fsBtn         = document.getElementById('fullscreenTdBtn');
    const backBtn       = document.getElementById('backTdBtn');
    const savedEl       = document.getElementById('tdSaved');
    const passedEl      = document.getElementById('tdPassed');
    const tokensEl      = document.getElementById('tdTokens');
    const totalEl       = document.getElementById('tdTotal');
    const messageEl     = document.getElementById('tdMessage');
    const conveyorEl    = document.getElementById('tdConveyor');
    const trainEl       = document.getElementById('tdTrain');
    const savesGridEl   = document.getElementById('tdSavesGrid');
    const savesEmptyEl  = document.getElementById('tdSavesEmpty');
    const speedSlider   = document.getElementById('tdSpeed');
    const speedValEl    = document.getElementById('tdSpeedVal');
    const maxSavesSel   = document.getElementById('tdMaxSaves');
    const usernameInput = document.getElementById('tdUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    speedSlider.addEventListener('input', () => {
        speedValEl.textContent = speedSlider.value;
    });

    // ── Layout constants ──────────────────────────────────────────────────────
    const CARD_W    = 175;   // px — card width on the belt
    const CARD_H    = 245;   // px — card height
    const CARD_GAP  = 18;    // px — gap between cards
    const CARD_STEP = CARD_W + CARD_GAP;

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];

    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('TowerDefense: load error', e); }
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let state = {
        active:       false,
        savedCount:   0,
        passedCount:  0,
        tokensLeft:   5,
        tokensInitial:5,
        startTime:    null,
        score:        0,
    };

    // Per-card tracking (parallel to allImages)
    let cards = [];   // { imgObj, el, saved, passed }

    // Animation
    let trainX   = 0;
    let lastTs   = null;
    let rafId    = null;
    let conveyorW = 800;

    // ── Speed helper ──────────────────────────────────────────────────────────
    function getSpeedPx() {
        // slider 1-8 → 60-480 px/s
        return parseInt(speedSlider.value, 10) * 60;
    }

    // ── Build conveyor cards ──────────────────────────────────────────────────
    function buildTrain() {
        trainEl.innerHTML = '';
        cards = [];

        allImages.forEach((imgObj, i) => {
            const card = document.createElement('div');
            card.className = 'td-card';

            const img = document.createElement('img');
            img.src = imgObj.url;
            img.draggable = false;
            img.alt = '';
            card.appendChild(img);

            // Save indicator overlay (hidden until saved)
            const overlay = document.createElement('div');
            overlay.className = 'td-save-indicator';
            overlay.innerHTML = '<i class="fas fa-heart"></i><span>Saved!</span>';
            card.appendChild(overlay);

            // Number badge
            const badge = document.createElement('div');
            badge.className = 'td-card-badge';
            badge.textContent = i + 1;
            card.appendChild(badge);

            card.addEventListener('click', () => attemptSave(i));
            card.addEventListener('touchend', (e) => { e.preventDefault(); attemptSave(i); });

            trainEl.appendChild(card);
            cards.push({ imgObj, el: card, saved: false, passed: false });
        });
    }

    // ── Save action ───────────────────────────────────────────────────────────
    function attemptSave(idx) {
        if (!state.active) return;
        const card = cards[idx];
        if (card.saved || card.passed) return;

        if (state.tokensLeft <= 0) {
            flashMessage('<div class="feedback error"><i class="fas fa-ban"></i> No tokens left!</div>', 1200);
            // Shake the tokens counter
            tokensEl.parentElement.classList.add('td-shake');
            setTimeout(() => tokensEl.parentElement.classList.remove('td-shake'), 400);
            return;
        }

        // Mark saved
        card.saved = true;
        state.savedCount++;
        state.tokensLeft--;

        // Update stats
        savedEl.textContent  = state.savedCount;
        tokensEl.textContent = state.tokensLeft;

        // Visual: show save overlay on belt card
        card.el.classList.add('td-card--saved');

        // Hide empty message
        if (savesEmptyEl) savesEmptyEl.style.display = 'none';

        // Add thumbnail to saves panel
        addThumbToPanel(card.imgObj);

        // All tokens spent?
        if (state.tokensLeft <= 0 && !checkAllProcessed()) {
            flashMessage(
                '<div class="feedback info"><i class="fas fa-check-circle"></i> All tokens used — watch the rest march past!</div>',
                2500
            );
            // Dim remaining unsaved cards
            cards.forEach(c => {
                if (!c.saved && !c.passed) c.el.classList.add('td-card--spent');
            });
        }
    }

    function addThumbToPanel(imgObj) {
        const thumb = document.createElement('div');
        thumb.className = 'td-thumb td-thumb--pop';

        const img = document.createElement('img');
        img.src = imgObj.url;
        img.alt = '';
        thumb.appendChild(img);

        savesGridEl.appendChild(thumb);
        // Remove pop class after animation
        requestAnimationFrame(() => requestAnimationFrame(() => thumb.classList.remove('td-thumb--pop')));
    }

    // ── Animation loop ────────────────────────────────────────────────────────
    function frame(ts) {
        if (!state.active) return;
        if (!lastTs) lastTs = ts;

        const dt  = Math.min((ts - lastTs) / 1000, 0.1);   // cap delta at 100 ms
        lastTs    = ts;
        trainX   -= getSpeedPx() * dt;

        trainEl.style.left = trainX + 'px';

        // Check each card for "passed left edge"
        let allDone = true;
        cards.forEach((card, i) => {
            if (card.saved) return; // saved cards don't count as unprocessed

            const rightEdge = trainX + i * CARD_STEP + CARD_W;
            if (rightEdge < 0 && !card.passed) {
                card.passed = true;
                state.passedCount++;
                passedEl.textContent = state.passedCount;
                card.el.classList.add('td-card--passed');
            }

            if (!card.passed) allDone = false;
        });

        if (allDone) {
            endGame();
            return;
        }

        rafId = requestAnimationFrame(frame);
    }

    function checkAllProcessed() {
        return cards.every(c => c.saved || c.passed);
    }

    // ── Flash a temporary message ─────────────────────────────────────────────
    let flashTimer = null;
    function flashMessage(html, duration) {
        clearTimeout(flashTimer);
        messageEl.innerHTML = html;
        if (duration) {
            flashTimer = setTimeout(() => { messageEl.innerHTML = ''; }, duration);
        }
    }

    // ── End game ──────────────────────────────────────────────────────────────
    function endGame() {
        state.active = false;
        cancelAnimationFrame(rafId);
        clearTimeout(flashTimer);

        const elapsed     = Math.floor((Date.now() - state.startTime) / 1000);
        const speedLevel  = parseInt(speedSlider.value, 10);
        const baseScore   = state.savedCount * speedLevel * 100;
        // Efficiency bonus: full tokens used = +50% on base
        const efficiency  = state.tokensInitial > 0
            ? state.savedCount / state.tokensInitial
            : 0;
        const bonus       = Math.round(baseScore * efficiency * 0.5);
        state.score       = baseScore + bonus;

        const pct = allImages.length > 0
            ? Math.round((state.savedCount / allImages.length) * 100)
            : 0;

        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-shield-heart"></i>
                <h2>Parade's Over!</h2>
                <p>
                    Saved <strong>${state.savedCount}</strong> of <strong>${allImages.length}</strong>
                    (${pct}%)
                </p>
                <p>Score: <strong>${state.score}</strong>
                   ${bonus > 0 ? `<span class="streak-bonus"> +${bonus} efficiency bonus</span>` : ''}
                </p>
            </div>`;

        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';

        // Submit score
        const user = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType:   'towerdefense',
                score:      state.score,
                time:       elapsed,
                username:   user,
            })
        }).catch(() => {});
    }

    // ── Init / Reset ──────────────────────────────────────────────────────────
    function initGame() {
        if (allImages.length < 1) {
            messageEl.innerHTML = '<div class="feedback error">No images in this collection!</div>';
            return;
        }

        cancelAnimationFrame(rafId);
        clearTimeout(flashTimer);

        const maxSaves = parseInt(maxSavesSel.value, 10);

        state = {
            active:        true,
            savedCount:    0,
            passedCount:   0,
            tokensLeft:    maxSaves,
            tokensInitial: maxSaves,
            startTime:     Date.now(),
            score:         0,
        };

        savedEl.textContent  = '0';
        passedEl.textContent = '0';
        tokensEl.textContent = maxSaves;
        totalEl.textContent  = allImages.length;
        messageEl.innerHTML  = '';

        // Clear saves panel
        savesGridEl.innerHTML = '';
        if (savesEmptyEl) {
            // Re-create the empty hint since we cleared innerHTML
            const hint = document.createElement('p');
            hint.className = 'td-saves-empty';
            hint.id = 'tdSavesEmpty';
            hint.textContent = 'Nothing saved yet — click images on the belt!';
            savesGridEl.appendChild(hint);
        }

        // Re-measure conveyor (may have changed size)
        conveyorW = conveyorEl.offsetWidth || 800;

        buildTrain();

        // Start train off the right edge with a small extra gap
        trainX = conveyorW + 40;
        trainEl.style.left = trainX + 'px';

        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';

        lastTs = null;
        rafId  = requestAnimationFrame(frame);
    }

    function resetGame() {
        cancelAnimationFrame(rafId);
        clearTimeout(flashTimer);
        state.active = false;

        trainEl.innerHTML    = '';
        cards                = [];
        savesGridEl.innerHTML = '<p class="td-saves-empty" id="tdSavesEmpty">Nothing saved yet — click images on the belt!</p>';
        messageEl.innerHTML  = '';
        savedEl.textContent  = '0';
        passedEl.textContent = '0';
        tokensEl.textContent = maxSavesSel.value;
        totalEl.textContent  = '—';
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
    }

    // ── Fullscreen ────────────────────────────────────────────────────────────
    if (fsBtn) {
        fsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                container.requestFullscreen().catch(e => console.warn('FS error:', e.message));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === container;
            fsBtn.innerHTML = isFS
                ? '<i class="fas fa-compress"></i> Exit Fullscreen'
                : '<i class="fas fa-expand"></i> Fullscreen';
            // Re-measure conveyor after fullscreen change
            if (state.active) conveyorW = conveyorEl.offsetWidth || 800;
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
    totalEl.textContent = allImages.length > 0 ? allImages.length : '—';
    if (allImages.length < 1) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:2rem">No images found in this collection!</div>';
        startBtn.disabled = true;
    }
});

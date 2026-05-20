/**
 * Who's That? Game
 * A set of tags is shown — NO image. Pick which image in the lineup
 * has ALL of those tags. Fewer tags shown = harder = bigger score.
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const startBtn       = document.getElementById('startWtBtn');
    const resetBtn       = document.getElementById('resetWtBtn');
    const fullscreenBtn  = document.getElementById('fullscreenWtBtn');
    const backBtn        = document.getElementById('backWtBtn');
    const scoreEl        = document.getElementById('wtScore');
    const roundEl        = document.getElementById('wtRound');
    const livesEl        = document.getElementById('wtLives');
    const streakEl       = document.getElementById('wtStreak');
    const messageEl      = document.getElementById('wtMessage');
    const tagsDisplayEl  = document.getElementById('wtTagsDisplay');
    const timerFillEl    = document.getElementById('wtTimerFill');
    const lineupEl       = document.getElementById('wtLineup');
    const tagCountSel    = document.getElementById('wtTagCount');
    const timeLimitSel   = document.getElementById('wtTimeLimit');
    const usernameInput  = document.getElementById('wtUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];   // [{url, filename, tags:[]}]

    async function loadImages() {
        try {
            const res = await fetch(`/api/collections/${COLLECTION}/images`);
            const d   = await res.json();
            if (d.success) allImages = d.images.filter(img => img.tags && img.tags.length > 0);
        } catch (e) { console.error('WhoIsThat: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ── Round generation ──────────────────────────────────────────────────────
    function generateRound(attempt = 0) {
        if (attempt > 30) return null;

        const numTags = parseInt(tagCountSel.value, 10) || 3;

        // Pick target with enough tags
        const eligible = allImages.filter(img => img.tags.length >= numTags);
        if (eligible.length < 4) return null;

        const target     = eligible[Math.floor(Math.random() * eligible.length)];
        const shownTags  = shuffle(target.tags).slice(0, numTags);

        // Distractors: MUST NOT have all of shownTags.
        // Prefer ones that share SOME tags (makes it harder).
        const nonMatches = allImages.filter(img => {
            if (img === target || img.filename === target.filename) return false;
            return !shownTags.every(t => img.tags.includes(t));
        });

        if (nonMatches.length < 3) return generateRound(attempt + 1);

        // Prefer distractors that share ≥1 of the shown tags (trickier)
        const tricky = nonMatches.filter(img => shownTags.some(t => img.tags.includes(t)));
        const pool   = tricky.length >= 3 ? tricky : nonMatches;
        const distractors = shuffle(pool).slice(0, 3);

        return {
            target,
            shownTags,
            options: shuffle([target, ...distractors]),
        };
    }

    // ── Timer bar ─────────────────────────────────────────────────────────────
    let roundTimerHandle = null;
    let roundDeadline    = null;

    function startTimerBar(ms) {
        clearTimeout(roundTimerHandle);
        if (ms <= 0) {
            timerFillEl.style.width = '100%';
            timerFillEl.style.transition = 'none';
            return;
        }
        roundDeadline = Date.now() + ms;
        timerFillEl.style.transition = 'none';
        timerFillEl.style.width      = '100%';
        void timerFillEl.offsetWidth;
        timerFillEl.style.transition = `width ${ms}ms linear`;
        timerFillEl.style.width      = '0%';
        roundTimerHandle = setTimeout(() => {
            if (state.active && !state.answered) timeOut();
        }, ms);
    }

    function clearTimerBar() {
        clearTimeout(roundTimerHandle);
        timerFillEl.style.transition = 'none';
        timerFillEl.style.width      = '0%';
    }

    function timeOut() {
        state.answered = true;
        state.streak   = 0;
        state.lives--;
        streakEl.textContent = '0';
        updateLives();
        highlightCorrect();
        messageEl.innerHTML = `<div class="feedback error"><i class="fas fa-clock"></i> Time's up! The answer was <strong>${state.targetFilename}</strong></div>`;
        if (state.lives <= 0) { setTimeout(() => endGame(), 1800); }
        else { setTimeout(() => { if (state.active) startRound(); }, 2200); }
    }

    function highlightCorrect() {
        document.querySelectorAll('.wt-lineup-card').forEach(card => {
            if (card._isTarget) card.classList.add('wt-correct-reveal');
        });
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let state = {
        active: false, score: 0, round: 0, lives: 3, streak: 0,
        startTime: null, globalTimer: null,
        targetFilename: null, shownTags: [], answered: false,
    };

    function updateLives() {
        const h = ['❤️','❤️','❤️'];
        for (let i = state.lives; i < 3; i++) h[i] = '🖤';
        livesEl.textContent = h.join('');
    }

    // ── Round start ───────────────────────────────────────────────────────────
    function startRound() {
        if (!state.active) return;

        const round = generateRound();
        if (!round) {
            messageEl.innerHTML = '<div class="feedback error">Not enough tagged images to generate a round!</div>';
            endGame();
            return;
        }

        state.round++;
        state.answered          = false;
        state.targetFilename    = round.target.filename;
        state.shownTags         = round.shownTags;
        roundEl.textContent     = state.round;

        // Display tags dramatically
        const numTags = round.shownTags.length;
        tagsDisplayEl.innerHTML = round.shownTags.map((tag, i) => `
            <span class="wt-clue-tag" style="animation-delay:${i * 0.12}s">
                <i class="fas fa-tag"></i> ${tag}
            </span>
        `).join('');

        messageEl.innerHTML = `<p class="wt-prompt">Which image has <strong>all ${numTags} of these tags</strong>?</p>`;

        // Build lineup
        lineupEl.innerHTML = '';
        round.options.forEach(img => {
            const card = document.createElement('div');
            card.className   = 'wt-lineup-card';
            card._isTarget   = (img.filename === round.target.filename);

            const imgEl = document.createElement('img');
            imgEl.src   = img.url;
            imgEl.alt   = '';
            card.appendChild(imgEl);
            card.addEventListener('click', () => handleAnswer(img, card));
            lineupEl.appendChild(card);
        });

        // Timer
        const ms = parseInt(timeLimitSel.value, 10) || 0;
        startTimerBar(ms);
    }

    // ── Answer ────────────────────────────────────────────────────────────────
    function handleAnswer(img, cardEl) {
        if (!state.active || state.answered) return;
        state.answered = true;
        clearTimerBar();
        document.querySelectorAll('.wt-lineup-card').forEach(c => c.style.pointerEvents = 'none');

        const isCorrect = (img.filename === state.targetFilename);
        const numTags   = state.shownTags.length;
        // Fewer tags = harder = more base points
        const basePoints = { 2: 500, 3: 300, 4: 200, 5: 150 }[numTags] || 200;
        // Speed bonus when timer active
        const ms = parseInt(timeLimitSel.value, 10) || 0;
        const speedPts = (ms > 0 && roundDeadline)
            ? Math.floor(Math.max(0, roundDeadline - Date.now()) / 100)
            : 0;

        if (isCorrect) {
            state.streak++;
            const points = basePoints + speedPts + state.streak * 10;
            state.score += points;
            scoreEl.textContent  = state.score;
            streakEl.textContent = state.streak;
            cardEl.classList.add('wt-correct');
            messageEl.innerHTML = `
                <div class="feedback success">
                    <i class="fas fa-check-circle"></i> +${points}
                    ${state.streak > 1 ? `<span class="streak-bonus">Streak ${state.streak}🔥</span>` : ''}
                    <br><small>Tags matched: ${state.shownTags.map(t=>`<strong>#${t}</strong>`).join(', ')}</small>
                </div>`;
            setTimeout(() => { if (state.active) startRound(); }, 1700);
        } else {
            state.streak = 0;
            state.lives--;
            streakEl.textContent = '0';
            updateLives();
            cardEl.classList.add('wt-wrong');
            highlightCorrect();
            messageEl.innerHTML = `<div class="feedback error"><i class="fas fa-times-circle"></i> Wrong! Look for: ${state.shownTags.map(t=>`<strong>#${t}</strong>`).join(', ')}</div>`;
            if (state.lives <= 0) { setTimeout(() => endGame(), 2000); }
            else { setTimeout(() => { if (state.active) startRound(); }, 2200); }
        }
    }

    // ── End ───────────────────────────────────────────────────────────────────
    function endGame() {
        state.active = false;
        clearTimerBar();
        clearInterval(state.globalTimer);
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        lineupEl.innerHTML = '';
        tagsDisplayEl.innerHTML = '';
        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-masks-theater"></i>
                <h2>Game Over!</h2>
                <p>Score: <strong>${state.score}</strong></p>
                <p>Rounds: <strong>${state.round}</strong></p>
                <p>Best Streak: <strong>${streakEl.textContent}🔥</strong></p>
            </div>`;
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';
        const user = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ collection: COLLECTION, gameType: 'whoisthat',
                score: state.score, time: elapsed, username: user })
        }).catch(() => {});
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function initGame() {
        if (allImages.length < 4) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 4 tagged images to play!</div>';
            return;
        }
        const testRound = generateRound();
        if (!testRound) {
            messageEl.innerHTML = '<div class="feedback error">Not enough images with sufficient tags. Try a lower tag count!</div>';
            return;
        }
        state = { active: true, score: 0, round: 0, lives: 3, streak: 0,
                  startTime: Date.now(), globalTimer: null,
                  targetFilename: null, shownTags: [], answered: false };
        scoreEl.textContent = '0'; roundEl.textContent = '0';
        streakEl.textContent = '0';
        updateLives();
        messageEl.innerHTML = '';
        tagsDisplayEl.innerHTML = '';
        lineupEl.innerHTML = '';
        startBtn.style.display = 'none'; resetBtn.style.display = 'inline-block';
        startRound();
    }

    function resetGame() {
        clearTimerBar();
        clearInterval(state.globalTimer);
        state.active = false;
        scoreEl.textContent = '0'; roundEl.textContent = '0';
        streakEl.textContent = '0'; livesEl.textContent = '❤️❤️❤️';
        messageEl.innerHTML = ''; tagsDisplayEl.innerHTML = ''; lineupEl.innerHTML = '';
        startBtn.style.display = 'inline-block'; resetBtn.style.display = 'none';
    }

    // ── Native Fullscreen ─────────────────────────────────────────────────────
    const wtContainer = document.getElementById('wtContainer');
    if (fullscreenBtn && wtContainer) {
        fullscreenBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                wtContainer.requestFullscreen().catch(e => console.warn('FS error:', e.message));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === wtContainer;
            fullscreenBtn.innerHTML = isFS
                ? '<i class="fas fa-compress"></i> Exit Fullscreen'
                : '<i class="fas fa-expand"></i> Fullscreen';
        });
    }

    startBtn.addEventListener('click', initGame);
    resetBtn.addEventListener('click', resetGame);
    backBtn.addEventListener('click', () => {
        clearTimerBar();
        if (document.fullscreenElement) document.exitFullscreen();
        window.location.href = `/collection/${COLLECTION}`;
    });

    await loadImages();
    if (allImages.length < 4) {
        messageEl.innerHTML = `
            <div class="feedback error" style="margin-top:2rem">
                <i class="fas fa-tags"></i> Need at least 4 tagged images.
                <br>Visit <a href="/manage-collections" style="color:var(--secondary-color)">Manage Collections</a> to tag your images!
            </div>`;
        startBtn.disabled = true;
    }
});

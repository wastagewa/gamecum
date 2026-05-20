/**
 * Snap Match Game
 * Two images appear side by side. Do they share at least one tag?
 * React fast — the timer shrinks every round, and one mistake costs a life!
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = window.CURRENT_COLLECTION || 'Real';

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const startBtn      = document.getElementById('startSnapBtn');
    const resetBtn      = document.getElementById('resetSnapBtn');
    const backBtn       = document.getElementById('backSnapBtn');
    const fullscreenBtn = document.getElementById('fullscreenSnapBtn');
    const scoreEl       = document.getElementById('snapScore');
    const roundEl       = document.getElementById('snapRound');
    const streakEl      = document.getElementById('snapStreak');
    const livesEl       = document.getElementById('snapLives');
    const messageEl     = document.getElementById('snapMessage');
    const img1El        = document.getElementById('snapImg1');
    const img2El        = document.getElementById('snapImg2');
    const timerFill     = document.getElementById('snapTimerFill');
    const connectorEl   = document.getElementById('snapConnector');
    const yesBtn        = document.getElementById('snapYesBtn');
    const noBtn         = document.getElementById('snapNoBtn');
    const cardLeft      = document.getElementById('snapCardLeft');
    const cardRight     = document.getElementById('snapCardRight');
    const diffSel       = document.getElementById('snapDifficulty');
    const usernameInput = document.getElementById('snapUsernameInput');
    const container     = document.getElementById('snapContainer');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Game data ─────────────────────────────────────────────────────────────
    let allImages = [];

    // ── State ─────────────────────────────────────────────────────────────────
    let state = {
        active:      false,
        score:       0,
        round:       0,
        streak:      0,
        lives:       3,
        startTime:   null,
        roundTimer:  null,
        roundDeadline: null,
        answered:    false,
        isMatch:     false,
        sharedTags:  [],
        img1:        null,
        img2:        null,
    };

    const BASE_DIFFICULTY = {
        easy:   6000,
        medium: 4000,
        hard:   2500,
        insane: 1500,
    };

    // ── Load images ───────────────────────────────────────────────────────────
    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) {
                allImages = data.images.filter(img => img.tags && img.tags.length > 0);
            }
        } catch (e) {
            console.error('Snap: failed to load images', e);
        }
    }

    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function sharedTags(img1, img2) {
        return img1.tags.filter(t => img2.tags.includes(t));
    }

    // ── Pair generation ───────────────────────────────────────────────────────
    function generatePair(wantMatch) {
        const imgs = shuffle(allImages);

        if (wantMatch) {
            // Find two images that share at least one tag
            for (let i = 0; i < imgs.length; i++) {
                for (let j = i + 1; j < imgs.length; j++) {
                    const shared = sharedTags(imgs[i], imgs[j]);
                    if (shared.length > 0) {
                        return { img1: imgs[i], img2: imgs[j], shared, isMatch: true };
                    }
                }
            }
            // Fallback: couldn't find a matching pair → use non-match
            return generatePair(false);
        } else {
            // Find two images that share NO tags
            for (let i = 0; i < imgs.length; i++) {
                for (let j = i + 1; j < imgs.length; j++) {
                    const shared = sharedTags(imgs[i], imgs[j]);
                    if (shared.length === 0) {
                        return { img1: imgs[i], img2: imgs[j], shared: [], isMatch: false };
                    }
                }
            }
            // Fallback: all images share tags → use match
            return generatePair(true);
        }
    }

    // ── Timer bar ─────────────────────────────────────────────────────────────
    function roundMs() {
        const base = BASE_DIFFICULTY[diffSel.value] || 4000;
        // Timer shrinks slowly with consecutive rounds (5% per round, min 40%)
        const factor = Math.max(0.4, 1 - state.round * 0.05);
        return Math.floor(base * factor);
    }

    function startTimerBar(ms) {
        clearTimeout(state.roundTimer);
        state.roundDeadline = Date.now() + ms;
        timerFill.style.transition = 'none';
        timerFill.style.width      = '100%';
        void timerFill.offsetWidth;
        timerFill.style.transition = `width ${ms}ms linear`;
        timerFill.style.width      = '0%';

        state.roundTimer = setTimeout(() => {
            if (state.active && !state.answered) timeOutRound();
        }, ms);
    }

    function clearTimerBar() {
        clearTimeout(state.roundTimer);
        timerFill.style.transition = 'none';
        timerFill.style.width      = '0%';
    }

    // ── Lives display ─────────────────────────────────────────────────────────
    function updateLives() {
        const h = ['❤️', '❤️', '❤️'];
        for (let i = state.lives; i < 3; i++) h[i] = '🖤';
        livesEl.textContent = h.join('');
    }

    // ── Card flash ────────────────────────────────────────────────────────────
    function flashCards(correct) {
        const cls = correct ? 'snap-card-correct' : 'snap-card-wrong';
        cardLeft.classList.add(cls);
        cardRight.classList.add(cls);
        setTimeout(() => {
            cardLeft.classList.remove(cls);
            cardRight.classList.remove(cls);
        }, 500);
    }

    // ── Show round ────────────────────────────────────────────────────────────
    function startRound() {
        if (!state.active) return;

        state.round++;
        state.answered = false;
        roundEl.textContent = state.round;

        // Decide: 50% match, 50% no-match
        const wantMatch = Math.random() < 0.5;
        const pair      = generatePair(wantMatch);

        state.isMatch    = pair.isMatch;
        state.sharedTags = pair.shared;
        state.img1       = pair.img1;
        state.img2       = pair.img2;

        // Update images with fade
        img1El.classList.remove('snap-img-in');
        img2El.classList.remove('snap-img-in');
        void img1El.offsetWidth;
        img1El.src = pair.img1.url;
        img2El.src = pair.img2.url;
        img1El.classList.add('snap-img-in');
        img2El.classList.add('snap-img-in');

        // Reset connector
        connectorEl.querySelector('.snap-vs').textContent = '?';
        connectorEl.className = 'snap-connector';

        yesBtn.disabled = false;
        noBtn.disabled  = false;
        messageEl.innerHTML = '';

        startTimerBar(roundMs());
    }

    // ── Time out ──────────────────────────────────────────────────────────────
    function timeOutRound() {
        state.answered = true;
        state.streak   = 0;
        state.lives--;
        streakEl.textContent = state.streak;
        yesBtn.disabled = true;
        noBtn.disabled  = true;
        updateLives();
        flashCards(false);

        const answer = state.isMatch ? 'MATCH 💚' : 'NO MATCH ❌';
        messageEl.innerHTML = `<div class="feedback error"><i class="fas fa-clock"></i> Time's up! Answer was <strong>${answer}</strong></div>`;

        if (state.lives <= 0) {
            setTimeout(() => endGame(), 1800);
        } else {
            setTimeout(() => { if (state.active) startRound(); }, 2000);
        }
    }

    // ── Answer handler ────────────────────────────────────────────────────────
    function handleAnswer(userSaysMatch) {
        if (!state.active || state.answered) return;

        state.answered = true;
        clearTimerBar();
        yesBtn.disabled = true;
        noBtn.disabled  = true;

        const isCorrect = (userSaysMatch === state.isMatch);

        if (isCorrect) {
            const timeLeft  = Math.max(0, state.roundDeadline - Date.now());
            const speedPts  = Math.floor(timeLeft / 40);
            const streakPts = state.streak * 5;
            const points    = 100 + speedPts + streakPts;
            state.score    += points;
            state.streak++;
            scoreEl.textContent  = state.score;
            streakEl.textContent = state.streak;

            flashCards(true);

            // Show connector
            connectorEl.querySelector('.snap-vs').textContent = state.isMatch ? '💚' : '❌';
            connectorEl.className = state.isMatch
                ? 'snap-connector snap-connector-match'
                : 'snap-connector snap-connector-nomatch';

            const info = state.isMatch
                ? `Shared: <strong>#${state.sharedTags.slice(0,3).join(', #')}</strong>`
                : 'No shared tags';

            messageEl.innerHTML = `
                <div class="feedback success">
                    <i class="fas fa-check-circle"></i> +${points}
                    ${state.streak > 1 ? `<span class="streak-bonus">Streak ${state.streak}🔥</span>` : ''}
                    &nbsp;·&nbsp; <small>${info}</small>
                </div>`;

            setTimeout(() => { if (state.active) startRound(); }, 1400);

        } else {
            state.streak = 0;
            state.lives--;
            streakEl.textContent = state.streak;
            updateLives();
            flashCards(false);

            connectorEl.querySelector('.snap-vs').textContent = '❌';
            const correct = state.isMatch ? 'MATCH' : 'NO MATCH';
            const info    = state.isMatch
                ? `shared: <strong>#${state.sharedTags.slice(0,3).join(', #')}</strong>`
                : 'they share no tags';

            messageEl.innerHTML = `
                <div class="feedback error">
                    <i class="fas fa-times-circle"></i> Wrong! It was a <strong>${correct}</strong> — ${info}
                </div>`;

            if (state.lives <= 0) {
                setTimeout(() => endGame(), 2000);
            } else {
                setTimeout(() => { if (state.active) startRound(); }, 2200);
            }
        }
    }

    // ── End game ──────────────────────────────────────────────────────────────
    function endGame() {
        state.active = false;
        clearTimerBar();
        yesBtn.disabled = true;
        noBtn.disabled  = true;

        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        const mins    = Math.floor(elapsed / 60);
        const secs    = elapsed % 60;

        img1El.src = '';
        img2El.src = '';

        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-camera"></i>
                <h2>Game Over!</h2>
                <p>Final Score: <strong>${state.score}</strong></p>
                <p>Rounds: <strong>${state.round}</strong></p>
                <p>Best Streak: <strong>${streakEl.textContent}🔥</strong></p>
                <p>Time: ${mins}:${secs.toString().padStart(2, '0')}</p>
            </div>`;

        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';

        const username = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', username);
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType:   'snap',
                score:       state.score,
                time:        elapsed,
                username:    username
            })
        }).catch(e => console.warn('Score submit error', e));
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function initGame() {
        if (allImages.length < 2) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 2 tagged images to play!</div>';
            return;
        }

        state = {
            active:       true,
            score:        0,
            round:        0,
            streak:       0,
            lives:        3,
            startTime:    Date.now(),
            roundTimer:   null,
            roundDeadline:null,
            answered:     false,
            isMatch:      false,
            sharedTags:   [],
            img1:         null,
            img2:         null,
        };

        scoreEl.textContent  = '0';
        roundEl.textContent  = '0';
        streakEl.textContent = '0';
        updateLives();
        messageEl.innerHTML  = '';
        connectorEl.querySelector('.snap-vs').textContent = '?';
        connectorEl.className = 'snap-connector';

        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';

        startRound();
    }

    function resetGame() {
        clearTimerBar();
        state.active = false;
        img1El.src = '';
        img2El.src = '';
        scoreEl.textContent  = '0';
        roundEl.textContent  = '0';
        streakEl.textContent = '0';
        livesEl.textContent  = '❤️❤️❤️';
        messageEl.innerHTML  = '';
        yesBtn.disabled = true;
        noBtn.disabled  = true;
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
    }

    // ── Keyboard ──────────────────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
        if (!state.active || state.answered) return;
        if (e.key === 'ArrowLeft')  handleAnswer(false);
        if (e.key === 'ArrowRight') handleAnswer(true);
        if (e.key === 'm' || e.key === 'M') handleAnswer(true);
        if (e.key === 'n' || e.key === 'N') handleAnswer(false);
    });

    // ── Fullscreen ────────────────────────────────────────────────────────────
    fullscreenBtn.addEventListener('click', () => {
        const navbar = document.querySelector('.navbar');
        container.classList.toggle('fullscreen');
        if (container.classList.contains('fullscreen')) {
            fullscreenBtn.innerHTML = '<i class="fas fa-compress"></i> Exit Fullscreen';
            document.body.style.overflow = 'hidden';
            if (navbar) navbar.style.display = 'none';
        } else {
            fullscreenBtn.innerHTML = '<i class="fas fa-expand"></i> Fullscreen';
            document.body.style.overflow = '';
            if (navbar) navbar.style.display = '';
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && container.classList.contains('fullscreen')) {
            const navbar = document.querySelector('.navbar');
            container.classList.remove('fullscreen');
            fullscreenBtn.innerHTML = '<i class="fas fa-expand"></i> Fullscreen';
            document.body.style.overflow = '';
            if (navbar) navbar.style.display = '';
        }
    });

    // ── Event listeners ───────────────────────────────────────────────────────
    startBtn.addEventListener('click', initGame);
    resetBtn.addEventListener('click', resetGame);
    yesBtn.addEventListener('click',  () => handleAnswer(true));
    noBtn.addEventListener('click',   () => handleAnswer(false));
    backBtn.addEventListener('click', () => {
        clearTimerBar();
        window.location.href = `/collection/${COLLECTION}`;
    });

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    await loadImages();

    if (allImages.length < 2) {
        messageEl.innerHTML = `
            <div class="feedback error" style="margin-top:2rem">
                <i class="fas fa-tags"></i>
                Need at least 2 tagged images to play Snap Match.
                <br>Visit <a href="/manage-collections" style="color:var(--secondary-color)">Manage Collections</a> to tag your images!
            </div>`;
        startBtn.disabled = true;
    }
});

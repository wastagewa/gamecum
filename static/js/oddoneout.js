/**
 * Odd One Out Game
 * Four images are shown. Three share a hidden tag — find the one that doesn't belong!
 * Lives system, speed bonus scoring, streaks.
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const startBtn       = document.getElementById('startOddBtn');
    const resetBtn       = document.getElementById('resetOddBtn');
    const backBtn        = document.getElementById('backOddBtn');
    const fullscreenBtn  = document.getElementById('fullscreenOddBtn');
    const scoreEl        = document.getElementById('oddScore');
    const roundEl        = document.getElementById('oddRound');
    const timeEl         = document.getElementById('oddTime');
    const livesEl        = document.getElementById('oddLives');
    const streakEl       = document.getElementById('oddStreak');
    const messageEl      = document.getElementById('oddMessage');
    const gridEl         = document.getElementById('oddGrid');
    const timerWrap      = document.getElementById('oddRoundTimerWrap');
    const timerBar       = document.getElementById('oddRoundTimerBar');
    const difficultySelect = document.getElementById('oddDifficulty');
    const usernameInput  = document.getElementById('oddUsernameInput');
    const container      = document.getElementById('oddContainer');

    // Restore saved username
    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Game data ─────────────────────────────────────────────────────────────
    let allImages  = [];   // [{url, tags:[]}]
    let tagGroups  = {};   // { tag: [imageObj,...] }

    // ── State ─────────────────────────────────────────────────────────────────
    let state = {
        active: false,
        score: 0,
        round: 0,
        lives: 3,
        streak: 0,
        startTime: null,
        globalTimer: null,
        roundTimer: null,
        roundDeadline: null,
        answered: false,
        correctImage: null,
        sharedTag: null,
    };

    // ── Difficulty config ─────────────────────────────────────────────────────
    const DIFFICULTY = {
        easy:   { roundMs: 12000 },
        medium: { roundMs:  8000 },
        hard:   { roundMs:  5000 },
        insane: { roundMs:  3000 },
    };

    // ── Load collection images with tags ──────────────────────────────────────
    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) {
                allImages = data.images.filter(img => img.tags && img.tags.length > 0);
                buildTagGroups();
            }
        } catch (e) {
            console.error('Odd One Out: failed to load images', e);
        }
    }

    function buildTagGroups() {
        tagGroups = {};
        for (const img of allImages) {
            for (const tag of img.tags) {
                if (!tagGroups[tag]) tagGroups[tag] = [];
                tagGroups[tag].push(img);
            }
        }
    }

    function validTags() {
        // Tags that appear on at least 3 images
        return Object.keys(tagGroups).filter(t => tagGroups[t].length >= 3);
    }

    // ── Round generation ──────────────────────────────────────────────────────
    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function generateRound(attempt = 0) {
        if (attempt > 20) return null; // safety cap

        const tags = validTags();
        if (tags.length === 0) return null;

        // Pick random valid tag
        const sharedTag = tags[Math.floor(Math.random() * tags.length)];
        const tagImgs   = shuffle(tagGroups[sharedTag]).slice(0, 3);

        // Odd one out: image that does NOT have this tag
        const others = allImages.filter(img =>
            !img.tags.includes(sharedTag) && !tagImgs.includes(img)
        );
        if (others.length === 0) return generateRound(attempt + 1);

        const oddImage = others[Math.floor(Math.random() * others.length)];
        const fourImages = shuffle([...tagImgs, oddImage]);

        return { images: fourImages, correctAnswer: oddImage, sharedTag };
    }

    // ── Timer helpers ─────────────────────────────────────────────────────────
    function startGlobalTimer() {
        state.globalTimer = setInterval(() => {
            const elapsed  = Math.floor((Date.now() - state.startTime) / 1000);
            const mins     = Math.floor(elapsed / 60);
            const secs     = elapsed % 60;
            timeEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        }, 200);
    }

    function stopGlobalTimer() {
        clearInterval(state.globalTimer);
    }

    function startRoundTimer(ms) {
        clearTimeout(state.roundTimer);
        timerWrap.style.display = 'block';
        timerBar.style.transition = 'none';
        timerBar.style.width = '100%';
        // Force reflow so the transition reset takes effect
        void timerBar.offsetWidth;
        timerBar.style.transition = `width ${ms}ms linear`;
        timerBar.style.width = '0%';

        state.roundDeadline = Date.now() + ms;
        state.roundTimer = setTimeout(() => {
            if (state.active && !state.answered) {
                timeOutRound();
            }
        }, ms);
    }

    function clearRoundTimer() {
        clearTimeout(state.roundTimer);
    }

    function timeOutRound() {
        state.answered = true;
        state.streak   = 0;
        state.lives--;
        updateLivesDisplay();
        streakEl.textContent = state.streak;

        // Show correct card
        highlightCorrect();

        messageEl.innerHTML = `
            <div class="feedback error">
                <i class="fas fa-clock"></i> Time's up! The odd one was the image <em>without</em>
                <strong>#${state.sharedTag}</strong>
            </div>`;

        if (state.lives <= 0) {
            setTimeout(() => endGame(), 1800);
        } else {
            setTimeout(() => { if (state.active) startRound(); }, 2000);
        }
    }

    // ── UI helpers ────────────────────────────────────────────────────────────
    function updateLivesDisplay() {
        const hearts = ['❤️', '❤️', '❤️'];
        for (let i = state.lives; i < 3; i++) hearts[i] = '🖤';
        livesEl.textContent = hearts.join('');
    }

    function highlightCorrect() {
        document.querySelectorAll('.odd-card').forEach(card => {
            if (card._imageObj === state.correctImage) {
                card.classList.add('correct-reveal');
            }
        });
    }

    // ── Round start ───────────────────────────────────────────────────────────
    function startRound() {
        const round = generateRound();
        if (!round) {
            messageEl.innerHTML = '<div class="feedback error">Not enough tagged images for a round. Add more or tag your images!</div>';
            endGame();
            return;
        }

        state.round++;
        state.answered       = false;
        state.correctImage   = round.correctAnswer;
        state.sharedTag      = round.sharedTag;
        roundEl.textContent  = state.round;

        // Build grid
        gridEl.innerHTML = '';
        round.images.forEach(img => {
            const card = document.createElement('div');
            card.className = 'odd-card';
            card._imageObj  = img;  // store reference for later comparison

            const imgEl = document.createElement('img');
            imgEl.src   = img.url;
            imgEl.alt   = 'image';
            imgEl.loading = 'lazy';
            card.appendChild(imgEl);

            card.addEventListener('click', () => handleAnswer(img, card));
            gridEl.appendChild(card);
        });

        messageEl.innerHTML = '<p class="odd-prompt">Which image does <strong>NOT</strong> belong with the others?</p>';

        const cfg = DIFFICULTY[difficultySelect.value] || DIFFICULTY.medium;
        startRoundTimer(cfg.roundMs);
    }

    // ── Answer handling ───────────────────────────────────────────────────────
    function handleAnswer(img, cardEl) {
        if (!state.active || state.answered) return;

        state.answered = true;
        clearRoundTimer();

        // Disable all cards immediately
        document.querySelectorAll('.odd-card').forEach(c => {
            c.style.pointerEvents = 'none';
        });

        const isCorrect = img === state.correctImage;

        if (isCorrect) {
            const timeLeft    = Math.max(0, state.roundDeadline - Date.now());
            const speedBonus  = Math.floor(timeLeft / 50);  // up to 200 pts
            const streakBonus = state.streak * 10;
            const points      = 100 + speedBonus + streakBonus;

            state.score  += points;
            state.streak++;
            scoreEl.textContent  = state.score;
            streakEl.textContent = state.streak;
            cardEl.classList.add('correct');

            messageEl.innerHTML = `
                <div class="feedback success">
                    <i class="fas fa-check-circle"></i> Correct! <strong>+${points}</strong>
                    ${streakBonus > 0 ? `<span class="streak-bonus">Streak ×${state.streak} 🔥</span>` : ''}
                    <br><small>The others all share <strong>#${state.sharedTag}</strong></small>
                </div>`;

            setTimeout(() => { if (state.active) startRound(); }, 1600);

        } else {
            state.streak = 0;
            state.lives--;
            streakEl.textContent = state.streak;
            updateLivesDisplay();
            cardEl.classList.add('incorrect');
            highlightCorrect();

            messageEl.innerHTML = `
                <div class="feedback error">
                    <i class="fas fa-times-circle"></i> Wrong! The shared tag was <strong>#${state.sharedTag}</strong>
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
        clearRoundTimer();
        stopGlobalTimer();
        timerWrap.style.display = 'none';

        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        const mins    = Math.floor(elapsed / 60);
        const secs    = elapsed % 60;

        gridEl.innerHTML = '';
        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-trophy"></i>
                <h2>Game Over!</h2>
                <p>Final Score: <strong>${state.score}</strong></p>
                <p>Rounds Completed: <strong>${state.round}</strong></p>
                <p>Best Streak: <strong>${streakEl.textContent}🔥</strong></p>
                <p>Time: ${mins}:${secs.toString().padStart(2, '0')}</p>
            </div>`;

        startBtn.style.display  = 'inline-block';
        resetBtn.style.display  = 'inline-block';

        // Submit score
        const username = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', username);
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType:   'oddoneout',
                score:       state.score,
                time:        elapsed,
                username:    username
            })
        }).catch(e => console.warn('Score submit failed', e));
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function initGame() {
        if (allImages.length < 4) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 4 tagged images! Go to your gallery and add tags first.</div>';
            return;
        }
        if (validTags().length === 0) {
            messageEl.innerHTML = '<div class="feedback error">Images need shared tags to play. Try tagging your images in Manage Collections!</div>';
            return;
        }

        state = {
            active: true,
            score: 0,
            round: 0,
            lives: 3,
            streak: 0,
            startTime: Date.now(),
            globalTimer: null,
            roundTimer: null,
            roundDeadline: null,
            answered: false,
            correctImage: null,
            sharedTag: null,
        };

        scoreEl.textContent  = '0';
        roundEl.textContent  = '0';
        timeEl.textContent   = '0:00';
        streakEl.textContent = '0';
        updateLivesDisplay();
        gridEl.innerHTML     = '';
        messageEl.innerHTML  = '';

        startBtn.style.display  = 'none';
        resetBtn.style.display  = 'inline-block';

        startGlobalTimer();
        startRound();
    }

    function resetGame() {
        clearRoundTimer();
        stopGlobalTimer();
        state.active = false;
        timerWrap.style.display = 'none';
        scoreEl.textContent  = '0';
        roundEl.textContent  = '0';
        timeEl.textContent   = '0:00';
        streakEl.textContent = '0';
        livesEl.textContent  = '❤️❤️❤️';
        gridEl.innerHTML     = '';
        messageEl.innerHTML  = '';
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
    }

    // ── Fullscreen ────────────────────────────────────────────────────────────
    fullscreenBtn.addEventListener('click', () => {
        const navbar  = document.querySelector('.navbar');
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
    backBtn.addEventListener('click', () => {
        clearRoundTimer();
        stopGlobalTimer();
        window.location.href = `/collection/${COLLECTION}`;
    });

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    await loadImages();

    if (allImages.length < 4 || validTags().length === 0) {
        messageEl.innerHTML = `
            <div class="feedback error" style="margin-top:2rem">
                <i class="fas fa-tags"></i>
                This game needs tagged images with shared tags.
                <br>Go to <a href="/manage-collections" style="color:var(--secondary-color)">Manage Collections</a>
                and tag your images first!
            </div>`;
        startBtn.disabled = true;
    }
});

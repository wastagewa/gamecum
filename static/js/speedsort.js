/**
 * Speed Sort Game
 * A target tag is shown. Images appear one by one — decide if each image
 * HAS the tag (YES →) or NOT (NO ←) before the timer runs out!
 * Combo multiplier rewards consecutive correct answers.
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const startBtn      = document.getElementById('startSortBtn');
    const resetBtn      = document.getElementById('resetSortBtn');
    const backBtn       = document.getElementById('backSortBtn');
    const fullscreenBtn = document.getElementById('fullscreenSortBtn');
    const scoreEl       = document.getElementById('sortScore');
    const countEl       = document.getElementById('sortCount');
    const comboEl       = document.getElementById('sortCombo');
    const livesEl       = document.getElementById('sortLives');
    const messageEl     = document.getElementById('sortMessage');
    const tagDisplay    = document.getElementById('sortTagDisplay');
    const sortImage     = document.getElementById('sortImage');
    const flashOverlay  = document.getElementById('sortFlashOverlay');
    const timerFill     = document.getElementById('sortTimerFill');
    const yesBtn        = document.getElementById('sortYesBtn');
    const noBtn         = document.getElementById('sortNoBtn');
    const diffSel       = document.getElementById('sortDifficulty');
    const roundsSel     = document.getElementById('sortRounds');
    const usernameInput = document.getElementById('sortUsernameInput');
    const container     = document.getElementById('sortContainer');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Game data ─────────────────────────────────────────────────────────────
    let allImages  = [];
    let tagGroups  = {};

    // ── State ─────────────────────────────────────────────────────────────────
    let state = {
        active:     false,
        score:      0,
        sortedCount:0,
        combo:      1,
        lives:      3,
        startTime:  null,
        totalImages:20,
        targetTag:  null,
        queue:      [],
        queueIdx:   0,
        roundTimer: null,
        answered:   false,
        currentHasTag: false,
    };

    const DIFFICULTY = {
        easy:   { ms: 6000 },
        medium: { ms: 4000 },
        hard:   { ms: 2500 },
        insane: { ms: 1500 },
    };

    // ── Data loading ──────────────────────────────────────────────────────────
    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) {
                allImages = data.images.filter(img => img.tags && img.tags.length > 0);
                buildTagGroups();
            }
        } catch (e) {
            console.error('SpeedSort: failed to load images', e);
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
        // A tag needs at least 2 images with it AND at least 2 without
        return Object.keys(tagGroups).filter(t => {
            const withTag    = tagGroups[t].length;
            const withoutTag = allImages.length - withTag;
            return withTag >= 2 && withoutTag >= 2;
        });
    }

    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    // ── Build a queue for this session ────────────────────────────────────────
    function buildQueue(targetTag, total) {
        const withTag    = tagGroups[targetTag] || [];
        const withoutTag = allImages.filter(img => !img.tags.includes(targetTag));

        const halfWith    = Math.ceil(total / 2);
        const halfWithout = total - halfWith;

        const queueWith    = shuffle(withTag).slice(0, halfWith).map(img => ({ img, hasTag: true }));
        const queueWithout = shuffle(withoutTag).slice(0, halfWithout).map(img => ({ img, hasTag: false }));

        return shuffle([...queueWith, ...queueWithout]);
    }

    // ── Timer / progress bar ──────────────────────────────────────────────────
    function startTimerBar(ms) {
        clearTimeout(state.roundTimer);
        timerFill.style.transition = 'none';
        timerFill.style.width      = '100%';
        void timerFill.offsetWidth;
        timerFill.style.transition = `width ${ms}ms linear`;
        timerFill.style.width      = '0%';

        state.roundTimer = setTimeout(() => {
            if (state.active && !state.answered) {
                timeOutAnswer();
            }
        }, ms);
    }

    function clearTimerBar() {
        clearTimeout(state.roundTimer);
        timerFill.style.transition = 'none';
        timerFill.style.width      = '0%';
    }

    // ── Lives display ─────────────────────────────────────────────────────────
    function updateLives() {
        const hearts = ['❤️', '❤️', '❤️'];
        for (let i = state.lives; i < 3; i++) hearts[i] = '🖤';
        livesEl.textContent = hearts.join('');
    }

    // ── Flash feedback on image ───────────────────────────────────────────────
    function flashFeedback(correct) {
        flashOverlay.className = 'sort-flash-overlay ' + (correct ? 'flash-correct' : 'flash-wrong');
        setTimeout(() => { flashOverlay.className = 'sort-flash-overlay'; }, 400);
    }

    // ── Show next image ───────────────────────────────────────────────────────
    function showNext() {
        if (!state.active) return;
        if (state.queueIdx >= state.queue.length) {
            endGame(true);
            return;
        }

        const entry            = state.queue[state.queueIdx];
        state.currentHasTag    = entry.hasTag;
        state.answered         = false;

        sortImage.src          = entry.img.url;
        sortImage.classList.remove('sort-img-enter');
        void sortImage.offsetWidth;
        sortImage.classList.add('sort-img-enter');

        yesBtn.disabled = false;
        noBtn.disabled  = false;

        messageEl.innerHTML = '';

        const cfg = DIFFICULTY[diffSel.value] || DIFFICULTY.medium;
        startTimerBar(cfg.ms);
    }

    // ── Time out ──────────────────────────────────────────────────────────────
    function timeOutAnswer() {
        state.answered = true;
        state.combo    = 1;
        state.lives--;
        yesBtn.disabled = true;
        noBtn.disabled  = true;
        updateLives();
        comboEl.textContent = `×${state.combo}`;
        flashFeedback(false);

        const correct = state.currentHasTag ? 'YES' : 'NO';
        messageEl.innerHTML = `<div class="feedback error"><i class="fas fa-clock"></i> Too slow! Answer was <strong>${correct}</strong></div>`;

        if (state.lives <= 0) {
            setTimeout(() => endGame(false), 1500);
        } else {
            state.queueIdx++;
            setTimeout(showNext, 900);
        }
    }

    // ── Handle YES / NO answer ────────────────────────────────────────────────
    function handleAnswer(userSaysYes) {
        if (!state.active || state.answered) return;

        state.answered  = true;
        clearTimerBar();
        yesBtn.disabled = true;
        noBtn.disabled  = true;
        state.queueIdx++;
        state.sortedCount++;
        countEl.textContent = state.sortedCount;

        const isCorrect = (userSaysYes === state.currentHasTag);

        if (isCorrect) {
            const basePoints = 10;
            const points     = basePoints * state.combo;
            state.score     += points;
            state.combo      = Math.min(state.combo + 1, 8);
            scoreEl.textContent = state.score;
            comboEl.textContent = `×${state.combo}`;
            flashFeedback(true);
            messageEl.innerHTML = `<div class="feedback success"><i class="fas fa-check"></i> Correct! +${points}</div>`;
        } else {
            state.combo  = 1;
            state.lives--;
            comboEl.textContent = `×${state.combo}`;
            updateLives();
            flashFeedback(false);

            const correct = state.currentHasTag ? 'YES — it has <strong>#' + state.targetTag + '</strong>' : 'NO — it does <em>not</em> have that tag';
            messageEl.innerHTML = `<div class="feedback error"><i class="fas fa-times"></i> Wrong! Answer: ${correct}</div>`;

            if (state.lives <= 0) {
                setTimeout(() => endGame(false), 1500);
                return;
            }
        }

        setTimeout(showNext, 700);
    }

    // ── End game ──────────────────────────────────────────────────────────────
    function endGame(completed) {
        state.active = false;
        clearTimerBar();
        yesBtn.disabled = true;
        noBtn.disabled  = true;

        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        const mins    = Math.floor(elapsed / 60);
        const secs    = elapsed % 60;

        sortImage.src = '';
        tagDisplay.innerHTML = '&nbsp;';

        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-${completed ? 'star' : 'trophy'}"></i>
                <h2>${completed ? 'Complete! 🎉' : 'Game Over!'}</h2>
                <p>Final Score: <strong>${state.score}</strong></p>
                <p>Images Sorted: <strong>${state.sortedCount}</strong></p>
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
                gameType:   'speedsort',
                score:       state.score,
                time:        elapsed,
                username:    username
            })
        }).catch(e => console.warn('Score submit error', e));
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function initGame() {
        const tags = validTags();
        if (tags.length === 0) {
            messageEl.innerHTML = '<div class="feedback error">Need tagged images with at least 2 images per tag. Tag your collection first!</div>';
            return;
        }

        const targetTag = tags[Math.floor(Math.random() * tags.length)];
        const total     = parseInt(roundsSel.value, 10) || 20;

        state = {
            active:      true,
            score:       0,
            sortedCount: 0,
            combo:       1,
            lives:       3,
            startTime:   Date.now(),
            totalImages: total,
            targetTag:   targetTag,
            queue:       buildQueue(targetTag, total),
            queueIdx:    0,
            roundTimer:  null,
            answered:    false,
            currentHasTag: false,
        };

        scoreEl.textContent = '0';
        countEl.textContent = '0';
        comboEl.textContent = '×1';
        updateLives();
        messageEl.innerHTML = '';

        // Show target tag prominently
        tagDisplay.innerHTML = `<span class="sort-tag-pill">#${targetTag}</span>`;

        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';

        showNext();
    }

    function resetGame() {
        clearTimerBar();
        state.active = false;
        sortImage.src = '';
        tagDisplay.innerHTML = '&nbsp;';
        scoreEl.textContent = '0';
        countEl.textContent = '0';
        comboEl.textContent = '×1';
        livesEl.textContent = '❤️❤️❤️';
        messageEl.innerHTML = '';
        yesBtn.disabled = true;
        noBtn.disabled  = true;
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
    }

    // ── Keyboard support ──────────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
        if (!state.active || state.answered) return;
        if (e.key === 'ArrowLeft')  handleAnswer(false);
        if (e.key === 'ArrowRight') handleAnswer(true);
    });

    // ── Native Fullscreen ─────────────────────────────────────────────────────
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

    if (validTags().length === 0) {
        messageEl.innerHTML = `
            <div class="feedback error" style="margin-top:2rem">
                <i class="fas fa-tags"></i>
                Need tagged images to play Speed Sort.
                <br>Visit <a href="/manage-collections" style="color:var(--secondary-color)">Manage Collections</a> to tag your images!
            </div>`;
        startBtn.disabled = true;
    }
});

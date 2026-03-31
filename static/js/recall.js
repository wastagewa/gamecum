document.addEventListener('DOMContentLoaded', () => {
    const boardEl = document.getElementById('recallBoard');
    const startBtn = document.getElementById('startRecallBtn');
    const resetBtn = document.getElementById('resetRecallBtn');
    const backBtn = document.getElementById('backRecallBtn');
    const fullscreenBtn = document.getElementById('fullscreenRecallBtn');
    const gridSizeSelect = document.getElementById('recallGridSize');
    const previewSelect = document.getElementById('recallPreview');
    const usernameInput = document.getElementById('recallUsername');
    const tileSizeInput = document.getElementById('recallTileSize');
    const tileSizeLabel = document.getElementById('recallTileSizeLabel');
    const focusSizeInput = document.getElementById('recallFocusSize');
    const focusSizeLabel = document.getElementById('recallFocusSizeLabel');
    const scoreEl = document.getElementById('recallScore');
    const roundEl = document.getElementById('recallRound');
    const timeEl = document.getElementById('recallTime');
    const stateEl = document.getElementById('recallState');
    const messageEl = document.getElementById('recallMessage');
    const targetLabelEl = document.getElementById('recallTargetLabel');
    const targetImageEl = document.getElementById('recallTargetImage');
    const shellEl = document.querySelector('.recall-shell');
    const navbarEl = document.querySelector('.navbar');

    const state = {
        active: false,
        canAnswer: false,
        round: 0,
        score: 0,
        startTime: null,
        timer: null,
        roundStartedAt: 0,
        tiles: [],
        targetIndex: -1
    };

    const prefs = {
        tileSize: 150,
        focusSize: 240
    };

    try {
        const saved = JSON.parse(localStorage.getItem('recall.prefs') || '{}');
        if (saved && typeof saved === 'object') {
            prefs.tileSize = parseInt(saved.tileSize, 10) || prefs.tileSize;
            prefs.focusSize = parseInt(saved.focusSize, 10) || prefs.focusSize;
        }
    } catch (err) {
        console.warn('Failed to load recall prefs', err);
    }

    function shuffle(list) {
        const copy = list.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    function updateTimer() {
        if (!state.startTime) {
            timeEl.textContent = '0:00';
            return;
        }
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        timeEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    function startTimer() {
        stopTimer();
        state.timer = setInterval(updateTimer, 250);
        updateTimer();
    }

    function stopTimer() {
        if (state.timer) {
            clearInterval(state.timer);
            state.timer = null;
        }
    }

    function savePrefs() {
        try {
            localStorage.setItem('recall.prefs', JSON.stringify(prefs));
        } catch (err) {
            console.warn('Failed to save recall prefs', err);
        }
    }

    function applySizing() {
        shellEl.style.setProperty('--recall-tile-size', `${prefs.tileSize}px`);
        shellEl.style.setProperty('--recall-focus-size', `${prefs.focusSize}px`);
        tileSizeInput.value = String(prefs.tileSize);
        tileSizeLabel.textContent = `${prefs.tileSize}px`;
        focusSizeInput.value = String(prefs.focusSize);
        focusSizeLabel.textContent = `${prefs.focusSize}px`;
    }

    function getColumns(count) {
        if (count <= 4) return 2;
        if (count <= 6) return 3;
        return 3;
    }

    function renderBoard(hidden) {
        boardEl.innerHTML = '';
        const columns = getColumns(state.tiles.length);
        boardEl.style.gridTemplateColumns = `repeat(${columns}, minmax(0, ${prefs.tileSize}px))`;

        state.tiles.forEach((img, index) => {
            const tile = document.createElement('button');
            tile.type = 'button';
            tile.className = `recall-card${hidden ? ' hidden' : ''}`;
            tile.dataset.index = String(index);

            if (hidden) {
                tile.innerHTML = `<span>${index + 1}</span>`;
                tile.addEventListener('click', () => handleGuess(index, tile));
            } else {
                const image = document.createElement('img');
                image.src = img;
                image.alt = `Memory tile ${index + 1}`;
                tile.appendChild(image);
                tile.disabled = true;
            }

            boardEl.appendChild(tile);
        });
    }

    function setMessage(text, tone) {
        messageEl.textContent = text;
        messageEl.style.color = tone === 'error' ? '#ff6b81' : tone === 'success' ? '#2ecc71' : 'var(--text-color)';
    }

    function beginAnswerPhase() {
        state.canAnswer = true;
        state.roundStartedAt = performance.now();
        stateEl.textContent = 'Answering';
        targetLabelEl.textContent = 'Click where this image was:';
        targetImageEl.src = state.tiles[state.targetIndex];
        targetImageEl.style.display = 'block';
        renderBoard(true);
        setMessage('Find the original position before you forget it.', 'info');
    }

    function prepareRound() {
        if (!state.active) return;

        const gridCount = parseInt(gridSizeSelect.value, 10) || 6;
        const previewMs = parseInt(previewSelect.value, 10) || 4000;

        state.round += 1;
        roundEl.textContent = String(state.round);
        state.tiles = shuffle(RECALL_IMAGES).slice(0, Math.min(gridCount, RECALL_IMAGES.length));
        state.targetIndex = Math.floor(Math.random() * state.tiles.length);
        state.canAnswer = false;
        stateEl.textContent = 'Memorizing';
        targetLabelEl.textContent = `Memorize ${state.tiles.length} images`;
        targetImageEl.style.display = 'none';
        setMessage(`Round ${state.round}: study the grid.`, 'info');
        renderBoard(false);

        window.setTimeout(() => {
            beginAnswerPhase();
        }, previewMs);
    }

    function submitScore() {
        if (!CURRENT_COLLECTION) return;
        const elapsed = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: CURRENT_COLLECTION,
                gameType: 'recall',
                score: state.score,
                time: elapsed,
                round: state.round,
                username: (usernameInput.value || 'Anonymous').trim() || 'Anonymous'
            })
        }).catch((err) => console.warn('Error submitting recall score', err));
    }

    function endGame(finalMessage, tone) {
        state.active = false;
        state.canAnswer = false;
        stateEl.textContent = 'Finished';
        setMessage(finalMessage, tone);
        stopTimer();
        submitScore();
    }

    function handleGuess(index, tileEl) {
        if (!state.active || !state.canAnswer) return;

        state.canAnswer = false;
        const allTiles = Array.from(boardEl.querySelectorAll('.recall-card'));
        const responseSeconds = (performance.now() - state.roundStartedAt) / 1000;
        const correctIndex = state.targetIndex;

        if (index === correctIndex) {
            tileEl.classList.add('correct');
            const points = Math.max(40, Math.round(150 - (responseSeconds * 25) + (state.round * 8)));
            state.score += points;
            scoreEl.textContent = String(state.score);
            stateEl.textContent = 'Correct';
            setMessage(`Nice recall. +${points} points.`, 'success');
            window.setTimeout(() => prepareRound(), 1100);
            return;
        }

        tileEl.classList.add('wrong');
        if (allTiles[correctIndex]) {
            allTiles[correctIndex].classList.add('correct');
        }
        endGame(`Wrong spot. Final score: ${state.score}`, 'error');
    }

    function resetGame() {
        state.active = false;
        state.canAnswer = false;
        state.round = 0;
        state.score = 0;
        state.startTime = null;
        state.tiles = [];
        state.targetIndex = -1;
        stopTimer();
        scoreEl.textContent = '0';
        roundEl.textContent = '0';
        timeEl.textContent = '0:00';
        stateEl.textContent = 'Waiting';
        targetLabelEl.textContent = 'Press Start to begin';
        targetImageEl.removeAttribute('src');
        targetImageEl.style.display = 'none';
        boardEl.innerHTML = '';
        setMessage('', 'info');
    }

    function syncFullscreenButton() {
        const active = document.fullscreenElement === shellEl;
        shellEl.classList.toggle('fullscreen', active);
        if (navbarEl) {
            navbarEl.style.display = active ? 'none' : '';
        }
        fullscreenBtn.innerHTML = active ? '<i class="fas fa-compress"></i> Exit Fullscreen' : '<i class="fas fa-expand"></i> Fullscreen';
    }

    startBtn.addEventListener('click', () => {
        if (RECALL_IMAGES.length < 4) {
            setMessage('Need at least 4 images in this collection to play Recall Grid.', 'error');
            return;
        }
        resetGame();
        state.active = true;
        state.startTime = Date.now();
        stateEl.textContent = 'Starting';
        startTimer();
        prepareRound();
    });

    resetBtn.addEventListener('click', resetGame);
    tileSizeInput.addEventListener('input', (event) => {
        prefs.tileSize = parseInt(event.target.value, 10) || 150;
        applySizing();
        savePrefs();
    });
    focusSizeInput.addEventListener('input', (event) => {
        prefs.focusSize = parseInt(event.target.value, 10) || 240;
        applySizing();
        savePrefs();
    });
    fullscreenBtn.addEventListener('click', async () => {
        try {
            if (document.fullscreenElement === shellEl) {
                await document.exitFullscreen();
            } else {
                await shellEl.requestFullscreen();
            }
        } catch (err) {
            console.warn('Recall fullscreen failed', err);
        }
    });
    document.addEventListener('fullscreenchange', syncFullscreenButton);
    backBtn.addEventListener('click', () => {
        window.location.href = `/collection/${CURRENT_COLLECTION}`;
    });

    applySizing();
    syncFullscreenButton();
});

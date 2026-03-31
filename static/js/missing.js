document.addEventListener('DOMContentLoaded', () => {
    const boardEl = document.getElementById('missingBoard');
    const optionsEl = document.getElementById('missingOptions');
    const startBtn = document.getElementById('startMissingBtn');
    const resetBtn = document.getElementById('resetMissingBtn');
    const backBtn = document.getElementById('backMissingBtn');
    const fullscreenBtn = document.getElementById('fullscreenMissingBtn');
    const gridSizeSelect = document.getElementById('missingGridSize');
    const previewSelect = document.getElementById('missingPreview');
    const choiceCountSelect = document.getElementById('missingChoiceCount');
    const usernameInput = document.getElementById('missingUsername');
    const boardSizeInput = document.getElementById('missingBoardSize');
    const boardSizeLabel = document.getElementById('missingBoardSizeLabel');
    const choiceSizeInput = document.getElementById('missingChoiceSize');
    const choiceSizeLabel = document.getElementById('missingChoiceSizeLabel');
    const scoreEl = document.getElementById('missingScore');
    const roundEl = document.getElementById('missingRound');
    const timeEl = document.getElementById('missingTime');
    const stateEl = document.getElementById('missingState');
    const messageEl = document.getElementById('missingMessage');
    const shellEl = document.querySelector('.missing-shell');
    const navbarEl = document.querySelector('.navbar');

    const state = {
        active: false,
        canAnswer: false,
        round: 0,
        score: 0,
        startTime: null,
        timer: null,
        boardImages: [],
        missingImage: null,
        hiddenIndex: -1,
        roundStartedAt: 0
    };

    const prefs = {
        boardSize: 150,
        choiceSize: 120
    };

    try {
        const saved = JSON.parse(localStorage.getItem('missing.prefs') || '{}');
        if (saved && typeof saved === 'object') {
            prefs.boardSize = parseInt(saved.boardSize, 10) || prefs.boardSize;
            prefs.choiceSize = parseInt(saved.choiceSize, 10) || prefs.choiceSize;
        }
    } catch (err) {
        console.warn('Failed to load missing prefs', err);
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
            localStorage.setItem('missing.prefs', JSON.stringify(prefs));
        } catch (err) {
            console.warn('Failed to save missing prefs', err);
        }
    }

    function applySizing() {
        shellEl.style.setProperty('--missing-board-size', `${prefs.boardSize}px`);
        shellEl.style.setProperty('--missing-choice-size', `${prefs.choiceSize}px`);
        boardSizeInput.value = String(prefs.boardSize);
        boardSizeLabel.textContent = `${prefs.boardSize}px`;
        choiceSizeInput.value = String(prefs.choiceSize);
        choiceSizeLabel.textContent = `${prefs.choiceSize}px`;
    }

    function getColumns(count) {
        if (count <= 4) return 2;
        if (count <= 6) return 3;
        return 3;
    }

    function setMessage(text, tone) {
        messageEl.textContent = text;
        messageEl.style.color = tone === 'error' ? '#ff6b81' : tone === 'success' ? '#2ecc71' : 'var(--text-color)';
    }

    function renderBoard(withGap) {
        boardEl.innerHTML = '';
        boardEl.style.gridTemplateColumns = `repeat(${getColumns(state.boardImages.length)}, minmax(0, ${prefs.boardSize}px))`;

        state.boardImages.forEach((imageUrl, index) => {
            const tile = document.createElement('div');
            tile.className = 'missing-tile';
            if (withGap && index === state.hiddenIndex) {
                tile.classList.add('gone');
                tile.innerHTML = '<i class="fas fa-question"></i>';
            } else {
                const image = document.createElement('img');
                image.src = imageUrl;
                image.alt = `Memory tile ${index + 1}`;
                tile.appendChild(image);
            }
            boardEl.appendChild(tile);
        });
    }

    function renderChoices() {
        optionsEl.innerHTML = '';
        const choiceCount = Math.max(2, parseInt(choiceCountSelect.value, 10) || 4);
        const distractors = shuffle(MISSING_IMAGES.filter((img) => !state.boardImages.includes(img)));
        const options = [state.missingImage];

        for (const image of distractors) {
            if (options.length >= choiceCount) break;
            options.push(image);
        }

        shuffle(options).forEach((imageUrl) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'missing-choice';
            button.innerHTML = `<img src="${imageUrl}" alt="Option">`;
            button.addEventListener('click', () => handleGuess(imageUrl, button));
            optionsEl.appendChild(button);
        });
    }

    function beginAnswerPhase() {
        state.canAnswer = true;
        state.roundStartedAt = performance.now();
        stateEl.textContent = 'Answering';
        renderBoard(true);
        renderChoices();
        setMessage('Which image disappeared from the grid?', 'info');
    }

    function prepareRound() {
        if (!state.active) return;

        const gridCount = parseInt(gridSizeSelect.value, 10) || 6;
        const previewMs = parseInt(previewSelect.value, 10) || 4000;

        state.round += 1;
        roundEl.textContent = String(state.round);
        state.boardImages = shuffle(MISSING_IMAGES).slice(0, Math.min(gridCount, MISSING_IMAGES.length));
        state.hiddenIndex = Math.floor(Math.random() * state.boardImages.length);
        state.missingImage = state.boardImages[state.hiddenIndex];
        state.canAnswer = false;
        stateEl.textContent = 'Memorizing';
        optionsEl.innerHTML = '';
        setMessage(`Round ${state.round}: remember every image in the grid.`, 'info');
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
                gameType: 'missing',
                score: state.score,
                time: elapsed,
                round: state.round,
                username: (usernameInput.value || 'Anonymous').trim() || 'Anonymous'
            })
        }).catch((err) => console.warn('Error submitting missing score', err));
    }

    function endGame(finalMessage, tone) {
        state.active = false;
        state.canAnswer = false;
        stateEl.textContent = 'Finished';
        setMessage(finalMessage, tone);
        stopTimer();
        submitScore();
    }

    function handleGuess(imageUrl, buttonEl) {
        if (!state.active || !state.canAnswer) return;

        state.canAnswer = false;
        const elapsed = (performance.now() - state.roundStartedAt) / 1000;
        const buttons = Array.from(optionsEl.querySelectorAll('.missing-choice'));

        if (imageUrl === state.missingImage) {
            buttonEl.classList.add('correct');
            const points = Math.max(50, Math.round(170 - (elapsed * 20) + (state.round * 10)));
            state.score += points;
            scoreEl.textContent = String(state.score);
            stateEl.textContent = 'Correct';
            setMessage(`Correct. +${points} points.`, 'success');
            window.setTimeout(() => prepareRound(), 1100);
            return;
        }

        buttonEl.classList.add('incorrect');
        buttons.forEach((btn) => {
            const img = btn.querySelector('img');
            if (img && img.getAttribute('src') === state.missingImage) {
                btn.classList.add('correct');
            }
        });
        endGame(`That was not the missing image. Final score: ${state.score}`, 'error');
    }

    function resetGame() {
        state.active = false;
        state.canAnswer = false;
        state.round = 0;
        state.score = 0;
        state.startTime = null;
        state.boardImages = [];
        state.missingImage = null;
        state.hiddenIndex = -1;
        stopTimer();
        scoreEl.textContent = '0';
        roundEl.textContent = '0';
        timeEl.textContent = '0:00';
        stateEl.textContent = 'Waiting';
        boardEl.innerHTML = '';
        optionsEl.innerHTML = '';
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
        if (MISSING_IMAGES.length < 5) {
            setMessage('Need at least 5 images in this collection to play Missing Piece.', 'error');
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
    boardSizeInput.addEventListener('input', (event) => {
        prefs.boardSize = parseInt(event.target.value, 10) || 150;
        applySizing();
        savePrefs();
    });
    choiceSizeInput.addEventListener('input', (event) => {
        prefs.choiceSize = parseInt(event.target.value, 10) || 120;
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
            console.warn('Missing fullscreen failed', err);
        }
    });
    document.addEventListener('fullscreenchange', syncFullscreenButton);
    backBtn.addEventListener('click', () => {
        window.location.href = `/collection/${CURRENT_COLLECTION}`;
    });

    applySizing();
    syncFullscreenButton();
});

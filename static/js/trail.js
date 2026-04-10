document.addEventListener('DOMContentLoaded', () => {
    const boardEl = document.getElementById('trailBoard');
    const anchorEl = document.getElementById('trailAnchor');
    const routeEl = document.getElementById('trailRoute');
    const routeTextEl = document.getElementById('trailRouteText');
    const startBtn = document.getElementById('startTrailBtn');
    const resetBtn = document.getElementById('resetTrailBtn');
    const backBtn = document.getElementById('backTrailBtn');
    const fullscreenBtn = document.getElementById('fullscreenTrailBtn');
    const gridSizeSelect = document.getElementById('trailGridSize');
    const previewSelect = document.getElementById('trailPreview');
    const routeLengthSelect = document.getElementById('trailRouteLength');
    const usernameInput = document.getElementById('trailUsername');
    const tileSizeInput = document.getElementById('trailTileSize');
    const tileSizeLabel = document.getElementById('trailTileSizeLabel');
    const anchorSizeInput = document.getElementById('trailAnchorSize');
    const anchorSizeLabel = document.getElementById('trailAnchorSizeLabel');
    const scoreEl = document.getElementById('trailScore');
    const roundEl = document.getElementById('trailRound');
    const streakEl = document.getElementById('trailStreak');
    const timeEl = document.getElementById('trailTime');
    const stateEl = document.getElementById('trailState');
    const stageLabelEl = document.getElementById('trailStageLabel');
    const hintEl = document.getElementById('trailHint');
    const messageEl = document.getElementById('trailMessage');
    const shellEl = document.querySelector('.trail-shell');
    const navbarEl = document.querySelector('.navbar');

    const directionMeta = {
        up: { dx: 0, dy: -1, icon: 'fa-arrow-up', label: 'Up' },
        right: { dx: 1, dy: 0, icon: 'fa-arrow-right', label: 'Right' },
        down: { dx: 0, dy: 1, icon: 'fa-arrow-down', label: 'Down' },
        left: { dx: -1, dy: 0, icon: 'fa-arrow-left', label: 'Left' }
    };

    const state = {
        active: false,
        canAnswer: false,
        round: 0,
        score: 0,
        streak: 0,
        timer: null,
        startTime: null,
        answerStartedAt: 0,
        tiles: [],
        columns: 3,
        rows: 3,
        startIndex: -1,
        targetIndex: -1,
        route: [],
        previewTimer: null
    };

    const prefs = {
        tileSize: 132,
        anchorSize: 220
    };

    try {
        const saved = JSON.parse(localStorage.getItem('trail.prefs') || '{}');
        if (saved && typeof saved === 'object') {
            prefs.tileSize = parseInt(saved.tileSize, 10) || prefs.tileSize;
            prefs.anchorSize = parseInt(saved.anchorSize, 10) || prefs.anchorSize;
        }
    } catch (err) {
        console.warn('Failed to load trail prefs', err);
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

    function clearPreviewTimer() {
        if (state.previewTimer) {
            clearTimeout(state.previewTimer);
            state.previewTimer = null;
        }
    }

    function savePrefs() {
        try {
            localStorage.setItem('trail.prefs', JSON.stringify(prefs));
        } catch (err) {
            console.warn('Failed to save trail prefs', err);
        }
    }

    function applySizing() {
        shellEl.style.setProperty('--trail-tile-size', `${prefs.tileSize}px`);
        shellEl.style.setProperty('--trail-anchor-size', `${prefs.anchorSize}px`);
        tileSizeInput.value = String(prefs.tileSize);
        tileSizeLabel.textContent = `${prefs.tileSize}px`;
        anchorSizeInput.value = String(prefs.anchorSize);
        anchorSizeLabel.textContent = `${prefs.anchorSize}px`;
    }

    function setMessage(text, tone) {
        messageEl.textContent = text;
        messageEl.style.color = tone === 'error' ? '#ff6b81' : tone === 'success' ? '#2ecc71' : '#58d6c3';
    }

    function getLayout(count) {
        if (count <= 4) return { columns: 2, rows: Math.ceil(count / 2) };
        if (count <= 9) return { columns: 3, rows: Math.ceil(count / 3) };
        return { columns: 4, rows: Math.ceil(count / 4) };
    }

    function indexToPoint(index) {
        return {
            x: index % state.columns,
            y: Math.floor(index / state.columns)
        };
    }

    function pointToIndex(x, y) {
        return y * state.columns + x;
    }

    function getValidMoves(index, visited) {
        const point = indexToPoint(index);
        return Object.entries(directionMeta)
            .map(([key, meta]) => ({ key, meta, x: point.x + meta.dx, y: point.y + meta.dy }))
            .filter((candidate) => (
                candidate.x >= 0 &&
                candidate.x < state.columns &&
                candidate.y >= 0 &&
                candidate.y < state.rows
            ))
            .map((candidate) => ({
                key: candidate.key,
                nextIndex: pointToIndex(candidate.x, candidate.y)
            }))
            .filter((candidate) => candidate.nextIndex < state.tiles.length)
            .filter((candidate) => !visited.has(candidate.nextIndex));
    }

    function buildRoute(startIndex, steps) {
        let current = startIndex;
        const visited = new Set([startIndex]);
        const route = [];

        for (let step = 0; step < steps; step += 1) {
            let moves = getValidMoves(current, visited);
            if (moves.length === 0) {
                moves = getValidMoves(current, new Set());
            }
            if (moves.length === 0) break;

            const move = moves[Math.floor(Math.random() * moves.length)];
            route.push(move.key);
            current = move.nextIndex;
            visited.add(current);
        }

        return { route, targetIndex: current };
    }

    function renderAnchor() {
        if (state.startIndex < 0 || !state.tiles[state.startIndex]) {
            anchorEl.className = 'trail-anchor empty';
            anchorEl.innerHTML = 'Start a round to lock onto an image.';
            return;
        }

        anchorEl.className = 'trail-anchor';
        anchorEl.innerHTML = `<img src="${state.tiles[state.startIndex]}" alt="Anchor image">`;
    }

    function renderRoute() {
        routeEl.innerHTML = '';
        if (!state.route.length) {
            routeEl.innerHTML = '<span class="trail-chip">No route yet</span>';
            routeTextEl.textContent = 'No route yet';
            return;
        }

        const labels = [];
        state.route.forEach((direction, index) => {
            const meta = directionMeta[direction];
            labels.push(`${index + 1}. ${meta.label}`);
            const chip = document.createElement('div');
            chip.className = 'trail-chip';
            chip.innerHTML = `<i class="fas ${meta.icon}"></i> <span>${index + 1}. ${meta.label}</span>`;
            routeEl.appendChild(chip);
        });
        routeTextEl.textContent = labels.join(' -> ');
    }

    function renderBoard(hidden, revealTarget = false) {
        boardEl.innerHTML = '';
        boardEl.style.gridTemplateColumns = `repeat(${state.columns}, minmax(0, ${prefs.tileSize}px))`;

        state.tiles.forEach((imageUrl, index) => {
            const tile = document.createElement(hidden ? 'button' : 'div');
            tile.className = 'trail-tile';
            tile.dataset.index = String(index);

            if (!hidden) {
                if (index === state.startIndex) tile.classList.add('start');
                tile.innerHTML = `<img src="${imageUrl}" alt="Trail tile ${index + 1}">`;
            } else {
                tile.type = 'button';
                tile.classList.add('hidden');
                tile.innerHTML = `<span>${index + 1}</span>`;
                tile.addEventListener('click', () => handleGuess(index, tile));
                if (revealTarget && index === state.targetIndex) {
                    tile.classList.add('reveal');
                }
            }

            boardEl.appendChild(tile);
        });
    }

    function submitScore() {
        if (!CURRENT_COLLECTION) return;
        const elapsed = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: CURRENT_COLLECTION,
                gameType: 'trail',
                score: state.score,
                time: elapsed,
                round: state.round,
                username: (usernameInput.value || 'Anonymous').trim() || 'Anonymous'
            })
        }).catch((err) => console.warn('Error submitting trail score', err));
    }

    function beginAnswerPhase() {
        state.canAnswer = true;
        state.answerStartedAt = performance.now();
        stateEl.textContent = 'Solving';
        stageLabelEl.textContent = 'Trace the route';
        hintEl.textContent = 'Start from the anchor image and mentally walk the full path before you click.';
        renderBoard(true);
        setMessage('Select the tile where the route ends.', 'info');
    }

    function prepareRound() {
        if (!state.active) return;

        const gridCount = Math.min(parseInt(gridSizeSelect.value, 10) || 9, TRAIL_IMAGES.length);
        const previewMs = parseInt(previewSelect.value, 10) || 4000;
        const requestedRouteLength = parseInt(routeLengthSelect.value, 10) || 4;
        const layout = getLayout(gridCount);
        const availableSteps = Math.max(2, Math.min(requestedRouteLength, gridCount - 1));

        state.round += 1;
        state.columns = layout.columns;
        state.rows = layout.rows;
        state.tiles = shuffle(TRAIL_IMAGES).slice(0, gridCount);
        state.startIndex = Math.floor(Math.random() * state.tiles.length);

        const built = buildRoute(state.startIndex, availableSteps);
        state.route = built.route;
        state.targetIndex = built.targetIndex;
        state.canAnswer = false;

        roundEl.textContent = String(state.round);
        stateEl.textContent = 'Memorizing';
        stageLabelEl.textContent = 'Memorize the board';
        hintEl.textContent = 'Lock in the anchor image, its neighbors, and the shape of the route.';
        renderAnchor();
        renderRoute();
        renderBoard(false);
        setMessage(`Round ${state.round}: study the grid before it disappears.`, 'info');

        clearPreviewTimer();
        state.previewTimer = window.setTimeout(() => {
            beginAnswerPhase();
        }, previewMs);
    }

    function endGame(message, tone) {
        state.active = false;
        state.canAnswer = false;
        clearPreviewTimer();
        stopTimer();
        stateEl.textContent = 'Finished';
        stageLabelEl.textContent = 'Run complete';
        hintEl.textContent = 'Reset to start a fresh trail.';
        setMessage(message, tone);
        submitScore();
    }

    function handleGuess(index, tileEl) {
        if (!state.active || !state.canAnswer) return;

        state.canAnswer = false;
        const buttons = Array.from(boardEl.querySelectorAll('.trail-tile'));
        const responseSeconds = (performance.now() - state.answerStartedAt) / 1000;

        if (index === state.targetIndex) {
            tileEl.classList.add('correct');
            state.streak += 1;
            streakEl.textContent = String(state.streak);
            const points = Math.max(60, Math.round(110 + (state.route.length * 25) + (state.streak * 12) - (responseSeconds * 18)));
            state.score += points;
            scoreEl.textContent = String(state.score);
            stateEl.textContent = 'Correct';
            stageLabelEl.textContent = 'Perfect trace';
            hintEl.textContent = 'Next round loading...';
            setMessage(`Correct. +${points} points.`, 'success');
            window.setTimeout(() => prepareRound(), 1100);
            return;
        }

        state.streak = 0;
        streakEl.textContent = '0';
        tileEl.classList.add('wrong');
        buttons.forEach((button) => {
            if (parseInt(button.dataset.index, 10) === state.targetIndex) {
                button.classList.add('reveal');
            }
        });
        endGame(`Wrong landing spot. Final score: ${state.score}`, 'error');
    }

    function resetGame() {
        state.active = false;
        state.canAnswer = false;
        state.round = 0;
        state.score = 0;
        state.streak = 0;
        state.startTime = null;
        state.answerStartedAt = 0;
        state.tiles = [];
        state.startIndex = -1;
        state.targetIndex = -1;
        state.route = [];
        clearPreviewTimer();
        stopTimer();
        roundEl.textContent = '0';
        scoreEl.textContent = '0';
        streakEl.textContent = '0';
        timeEl.textContent = '0:00';
        stateEl.textContent = 'Waiting';
        stageLabelEl.textContent = 'Waiting';
        hintEl.textContent = 'You will first preview the board, then solve the route from memory.';
        boardEl.innerHTML = '';
        renderAnchor();
        renderRoute();
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
        if (TRAIL_IMAGES.length < 4) {
            setMessage('Need at least 4 images in this collection to play Trail Trace.', 'error');
            return;
        }
        resetGame();
        state.active = true;
        state.startTime = Date.now();
        stateEl.textContent = 'Starting';
        stageLabelEl.textContent = 'Building route';
        hintEl.textContent = 'Preparing your first board...';
        startTimer();
        prepareRound();
    });

    resetBtn.addEventListener('click', resetGame);
    backBtn.addEventListener('click', () => {
        window.location.href = `/collection/${CURRENT_COLLECTION}`;
    });
    tileSizeInput.addEventListener('input', (event) => {
        prefs.tileSize = parseInt(event.target.value, 10) || 132;
        applySizing();
        savePrefs();
    });
    anchorSizeInput.addEventListener('input', (event) => {
        prefs.anchorSize = parseInt(event.target.value, 10) || 220;
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
            console.warn('Trail fullscreen failed', err);
        }
    });
    document.addEventListener('fullscreenchange', syncFullscreenButton);

    applySizing();
    resetGame();
    syncFullscreenButton();
});

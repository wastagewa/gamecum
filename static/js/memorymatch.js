/**
 * Memory Match Duel — live 2-player Concentration over Socket.IO.
 *
 * Classic rules on one shared, server-authoritative board: players alternate
 * turns flipping two cards. A match keeps your turn and scores a point
 * (highlighted in your color); a miss flips both back and passes the turn.
 * Most pairs found wins — the server is the single source of truth for the
 * board and whose turn it is, this file is just a thin render/input layer.
 *
 * The host sets both player names, the card count (validated against how
 * many images the collection actually has), and a custom card width/height +
 * fit mode (stretch to fill vs. fit while keeping proportions) when creating
 * the match; the joiner needs nothing but the room code/link.
 *
 * gameType: 'memorymatch'
 */
document.addEventListener('DOMContentLoaded', () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    if (typeof io === 'undefined') {
        console.error('Socket.IO failed to load — check the CDN link.');
        return;
    }

    const MM_MIN_IMAGES_CLIENT = 4; // mirrors the server's MM_MIN_IMAGES floor

    /* ── DOM ────────────────────────────────────────────────────────── */
    const lobbyEl       = document.getElementById('mmLobby');
    const matchEl       = document.getElementById('mmMatch');
    const usernameInput = document.getElementById('mmUsername');
    const opponentUsernameInput = document.getElementById('mmOpponentUsername');
    const numImagesInput = document.getElementById('mmNumImages');
    const cardsHintEl   = document.getElementById('mmCardsHint');
    const cardWidthInput  = document.getElementById('mmCardWidth');
    const cardHeightInput = document.getElementById('mmCardHeight');
    const fitModeSelect    = document.getElementById('mmFitMode');
    const configSavedHintEl = document.getElementById('mmConfigSavedHint');
    const createBtn     = document.getElementById('mmCreateBtn');
    const joinBtn       = document.getElementById('mmJoinBtn');
    const joinCodeInput = document.getElementById('mmJoinCode');
    const waitingRoomEl = document.getElementById('mmWaitingRoom');
    const autoJoiningEl = document.getElementById('mmAutoJoining');
    const roomCodeEl    = document.getElementById('mmRoomCodeDisplay');
    const shareLinkInput = document.getElementById('mmShareLink');
    const copyLinkBtn   = document.getElementById('mmCopyLinkBtn');
    const lobbyOptionsEl = document.querySelector('#mmLobby .mm-lobby-options');
    const lobbyErrorEl  = document.getElementById('mmLobbyError');

    const youCardEl  = document.getElementById('mmYouCard');
    const oppCardEl  = document.getElementById('mmOppCard');
    const youNameEl  = document.getElementById('mmYouName');
    const youScoreEl = document.getElementById('mmYouScore');
    const oppNameEl  = document.getElementById('mmOppName');
    const oppScoreEl = document.getElementById('mmOppScore');
    const turnIndicatorEl = document.getElementById('mmTurnIndicator');
    const messageEl  = document.getElementById('mmMessage');
    const boardEl    = document.getElementById('mmBoard');

    const matchOverEl = document.getElementById('mmMatchOver');
    const rematchBtn   = document.getElementById('mmRematchBtn');
    const fsBtn        = document.getElementById('mmFullscreenBtn');
    const leaveBtn      = document.getElementById('mmLeaveBtn');
    const mmContainer   = document.getElementById('mmContainer');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // Restore the host's last-used match settings, if any, so they don't
    // have to re-enter the board config every time they create a match.
    const MM_CONFIG_KEY = 'mm.config';
    try {
        const savedConfig = JSON.parse(localStorage.getItem(MM_CONFIG_KEY) || 'null');
        if (savedConfig) {
            if (savedConfig.opponentUsername) opponentUsernameInput.value = savedConfig.opponentUsername;
            if (savedConfig.numImages) numImagesInput.value = savedConfig.numImages;
            if (savedConfig.cardWidth) cardWidthInput.value = savedConfig.cardWidth;
            if (savedConfig.cardHeight) cardHeightInput.value = savedConfig.cardHeight;
            if (savedConfig.fitMode) fitModeSelect.value = savedConfig.fitMode;
        }
    } catch (e) { /* ignore malformed saved config */ }

    const presetRoom = new URLSearchParams(window.location.search).get('room');
    if (presetRoom) joinCodeInput.value = presetRoom.toUpperCase();

    function fallBackToManualJoin(errorMessage) {
        autoJoiningEl.style.display = 'none';
        lobbyOptionsEl.style.display = 'flex';
        if (errorMessage) lobbyErrorEl.textContent = errorMessage;
    }

    // Let the host know up front how many images the collection actually has
    // — that's the only real ceiling now (no artificial cap), the server
    // re-validates regardless.
    fetch(`/api/collections/${COLLECTION}/images`)
        .then(r => r.json())
        .then(data => {
            const count = (data.success && data.images) ? data.images.length : 0;
            numImagesInput.max = String(count);
            if (count < MM_MIN_IMAGES_CLIENT) {
                cardsHintEl.textContent = `This collection only has ${count} image(s) — not enough for a match (need at least ${MM_MIN_IMAGES_CLIENT}).`;
                createBtn.disabled = true;
            } else {
                cardsHintEl.textContent = `This collection has ${count} images — choose any number from ${MM_MIN_IMAGES_CLIENT} up to ${count}.`;
            }
        })
        .catch(() => { cardsHintEl.textContent = ''; });

    /* ══════════════════════════════════════════════════════════════════
       STATE
    ══════════════════════════════════════════════════════════════════ */
    const state = {
        mySid: null,
        myUsername: '',
        oppSid: null,
        currentTurn: null,
        boardLocked: false,
        flippedThisTurn: [],
        matchStartTime: null,
    };

    /* ══════════════════════════════════════════════════════════════════
       SOCKET.IO
    ══════════════════════════════════════════════════════════════════ */
    const socket = io();

    let autoJoinAttempted = false;
    socket.on('connect', () => {
        state.mySid = socket.id;
        if (presetRoom && !autoJoinAttempted) {
            autoJoinAttempted = true;
            lobbyOptionsEl.style.display = 'none';
            autoJoiningEl.style.display = 'flex';
            socket.emit('mm_join', { code: presetRoom.toUpperCase() });
        }
    });

    /* ── Lobby ─────────────────────────────────────────────────────── */
    createBtn.addEventListener('click', () => {
        const username = usernameInput.value.trim() || 'Player 1';
        const opponentUsername = opponentUsernameInput.value.trim() || 'Player 2';
        const numImages = parseInt(numImagesInput.value, 10) || 8;
        const cardWidth = parseInt(cardWidthInput.value, 10) || 100;
        const cardHeight = parseInt(cardHeightInput.value, 10) || 100;
        const fitMode = fitModeSelect.value || 'fit';
        localStorage.setItem('imgur.username', username);

        // Remember this board config for next time so the host doesn't have
        // to re-enter it on their next match (opponent name included, since
        // it's often the same person you keep playing against).
        localStorage.setItem(MM_CONFIG_KEY, JSON.stringify({
            opponentUsername, numImages, cardWidth, cardHeight, fitMode,
        }));
        configSavedHintEl.textContent = 'Settings saved for next time.';

        lobbyErrorEl.textContent = '';
        socket.emit('mm_create', {
            collection: COLLECTION, username, opponentUsername,
            numImages, cardWidth, cardHeight, fitMode,
        });
    });

    joinBtn.addEventListener('click', () => {
        const code = joinCodeInput.value.trim().toUpperCase();
        if (!code) { lobbyErrorEl.textContent = 'Enter a room code first.'; return; }
        lobbyErrorEl.textContent = '';
        socket.emit('mm_join', { code });
    });

    socket.on('mm_error', (data) => {
        const message = data.message || 'Something went wrong.';
        if (autoJoiningEl.style.display !== 'none') {
            fallBackToManualJoin(message);
        } else if (matchEl.style.display !== 'none') {
            // mid-match errors (e.g. "not your turn") — surface briefly, don't derail the lobby
            messageEl.innerHTML = `<span class="vz-msg-wrong">${message}</span>`;
        } else {
            lobbyErrorEl.textContent = message;
        }
    });

    socket.on('mm_created', (data) => {
        state.myUsername = data.username;
        roomCodeEl.textContent = data.code;
        const link = `${window.location.origin}${window.location.pathname}?room=${data.code}`;
        shareLinkInput.value = link;
        waitingRoomEl.style.display = 'flex';
    });

    socket.on('mm_joined', (data) => {
        state.myUsername = data.username;
    });

    copyLinkBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(shareLinkInput.value).then(() => {
            copyLinkBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            setTimeout(() => { copyLinkBtn.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 1500);
        }).catch(() => {});
    });

    /* ── Board ─────────────────────────────────────────────────────── */
    function nameFor(players, sid) {
        return (players && players[sid]) || 'Opponent';
    }

    function buildBoard(numCards, cardWidth, cardHeight, fitMode) {
        boardEl.className = 'mm-board mm-fit-' + fitMode;
        boardEl.style.setProperty('--mm-cell-w', cardWidth + 'px');
        boardEl.style.setProperty('--mm-cell-h', cardHeight + 'px');
        boardEl.innerHTML = '';
        for (let i = 0; i < numCards; i++) {
            const card = document.createElement('div');
            card.className = 'mm-card';
            card.dataset.index = i;
            card.innerHTML = `
                <div class="mm-card-inner">
                    <div class="mm-card-face mm-card-back"><i class="fas fa-question"></i></div>
                    <div class="mm-card-face mm-card-front"><img src="" alt=""></div>
                </div>`;
            card.addEventListener('click', () => onCardClick(i));
            boardEl.appendChild(card);
        }
    }

    function cardEl(index) {
        return boardEl.querySelector(`.mm-card[data-index="${index}"]`);
    }

    function onCardClick(index) {
        if (state.boardLocked) return;
        if (state.currentTurn !== state.mySid) return;
        const el = cardEl(index);
        if (!el || el.classList.contains('mm-flipped') || el.classList.contains('mm-matched')) return;
        socket.emit('mm_flip', { index });
    }

    function updateTurnUI() {
        const myTurn = state.currentTurn === state.mySid;
        youCardEl.classList.toggle('mm-active-turn', myTurn);
        oppCardEl.classList.toggle('mm-active-turn', !myTurn);
        turnIndicatorEl.innerHTML = myTurn
            ? '<i class="fas fa-hand-pointer"></i> YOUR TURN — pick two cards'
            : `<i class="fas fa-hourglass-half"></i> ${oppNameEl.textContent.toUpperCase()}'S TURN`;
        turnIndicatorEl.classList.toggle('mm-turn-you', myTurn);
        turnIndicatorEl.classList.toggle('mm-turn-opp', !myTurn);
        boardEl.classList.toggle('mm-not-my-turn', !myTurn);
    }

    /* ── Match ─────────────────────────────────────────────────────── */
    socket.on('mm_game_start', (data) => {
        lobbyEl.style.display = 'none';
        matchEl.style.display = 'block';
        if (!state.matchStartTime) state.matchStartTime = Date.now();

        state.oppSid = Object.keys(data.players).find(sid => sid !== state.mySid);
        state.currentTurn = data.currentTurn;
        state.flippedThisTurn = [];
        state.boardLocked = false;

        youNameEl.textContent = nameFor(data.players, state.mySid);
        oppNameEl.textContent = state.oppSid ? nameFor(data.players, state.oppSid) : '—';
        youScoreEl.textContent = (data.scores && data.scores[state.mySid]) || 0;
        oppScoreEl.textContent = (state.oppSid && data.scores && data.scores[state.oppSid]) || 0;

        buildBoard(data.numCards, data.cardWidth, data.cardHeight, data.fitMode);
        updateTurnUI();
        messageEl.innerHTML = '';
        matchOverEl.style.display = 'none';
        rematchBtn.style.display = 'none';
    });

    socket.on('mm_card_flipped', (data) => {
        const el = cardEl(data.index);
        if (!el) return;
        const img = el.querySelector('.mm-card-front img');
        img.src = data.imageUrl;
        el.classList.add('mm-flipped');
        state.flippedThisTurn.push(data.index);
        if (state.flippedThisTurn.length >= 2) state.boardLocked = true;
    });

    socket.on('mm_resolve', (data) => {
        youScoreEl.textContent = (data.scores && data.scores[state.mySid]) || 0;
        oppScoreEl.textContent = (state.oppSid && data.scores && data.scores[state.oppSid]) || 0;

        if (data.matched) {
            const colorClass = data.matchedBy === state.mySid ? 'mm-matched-you' : 'mm-matched-opp';
            data.indices.forEach(i => {
                const el = cardEl(i);
                if (el) el.classList.add('mm-matched', colorClass);
            });
            state.flippedThisTurn = [];
            messageEl.innerHTML = data.matchedBy === state.mySid
                ? '<span class="vz-msg-correct">Match! Go again.</span>'
                : `<span class="vz-msg-wrong">${oppNameEl.textContent} found a match and goes again.</span>`;
            // Mirror the server's brief debounce so a fast double-click right
            // after a match isn't silently dropped while phase=='resolving'.
            setTimeout(() => { state.boardLocked = false; }, 900);
        } else {
            messageEl.innerHTML = '<span class="vz-msg-wrong">No match.</span>';
            // Stays locked until mm_turn_change flips the cards back face-down.
        }
    });

    socket.on('mm_turn_change', (data) => {
        state.flippedThisTurn.forEach(i => {
            const el = cardEl(i);
            if (el && !el.classList.contains('mm-matched')) {
                el.classList.remove('mm-flipped');
            }
        });
        state.flippedThisTurn = [];
        state.currentTurn = data.currentTurn;
        state.boardLocked = false;
        updateTurnUI();
        messageEl.innerHTML = '';
    });

    socket.on('mm_match_over', (data) => {
        const myScore = (data.scores && data.scores[state.mySid]) || 0;
        const oppScore = (state.oppSid && data.scores && data.scores[state.oppSid]) || 0;
        const oppName = state.oppSid ? nameFor(data.players, state.oppSid) : 'Opponent';

        let banner;
        if (data.winnerSid === state.mySid) banner = `<i class="fas fa-trophy"></i><h2>You Win!</h2>`;
        else if (data.winnerSid && data.winnerSid === state.oppSid) banner = `<i class="fas fa-flag"></i><h2>${oppName} Wins</h2>`;
        else banner = `<i class="fas fa-handshake"></i><h2>It's a Tie!</h2>`;

        matchOverEl.innerHTML = `
            <div class="vz-over-banner">
                ${banner}
                <p>Pairs found — You: <strong>${myScore}</strong> &middot; ${oppName}: <strong>${oppScore}</strong></p>
            </div>`;
        matchOverEl.style.display = 'block';
        rematchBtn.style.display = 'inline-block';
        messageEl.innerHTML = '';
        turnIndicatorEl.innerHTML = '<i class="fas fa-flag-checkered"></i> Match complete';
        turnIndicatorEl.classList.remove('mm-turn-you', 'mm-turn-opp');
        youCardEl.classList.remove('mm-active-turn');
        oppCardEl.classList.remove('mm-active-turn');

        const elapsed = Math.floor((Date.now() - state.matchStartTime) / 1000);
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType: 'memorymatch',
                score: myScore,
                time: elapsed,
                username: state.myUsername,
            })
        }).catch(() => {});
    });

    socket.on('mm_opponent_left', () => {
        messageEl.innerHTML = '<span class="vz-msg-wrong">Your opponent disconnected.</span>';
        matchOverEl.innerHTML = `
            <div class="vz-over-banner">
                <i class="fas fa-plug-circle-xmark"></i>
                <h2>Opponent Left</h2>
                <p>Start a new match whenever you're ready.</p>
            </div>`;
        matchOverEl.style.display = 'block';
        rematchBtn.style.display = 'inline-block';
        state.boardLocked = true;
    });

    rematchBtn.addEventListener('click', () => {
        window.location.href = window.location.pathname;
    });

    leaveBtn.addEventListener('click', () => {
        socket.disconnect();
        window.location.href = `/collection/${COLLECTION}`;
    });

    /* ── Fullscreen ────────────────────────────────────────────────── */
    if (fsBtn) {
        fsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                mmContainer.requestFullscreen().catch(err => console.warn(err));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === mmContainer;
            fsBtn.innerHTML = isFS
                ? '<i class="fas fa-compress"></i> Exit Fullscreen'
                : '<i class="fas fa-expand"></i> Fullscreen';
        });
    }
});

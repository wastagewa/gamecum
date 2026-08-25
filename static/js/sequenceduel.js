// Sequence Duel — live 2-player Simon-says, taken in turns.
//
// Players alternate. Both watch the sequence flash on the shared board, but only
// the player whose turn it is can tap — and every tap they make is broadcast, so
// the other player watches it land in real time (sq_tap_landed). Spectating is
// the point of the idle half of the game.
//
// The client is deliberately dumb about the sequence: it never receives one.
// The server emits sq_flash per cell while showing, then sq_input_open, and
// validates every tap itself. That's the whole reason this isn't just the
// single-player game with a socket bolted on — the answer can't be sitting in
// a payload when the point of the game is whether you remembered it.
document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    const lobbyEl       = document.getElementById('sqLobby');
    const matchEl       = document.getElementById('sqMatch');
    const usernameInput = document.getElementById('sqUsername');
    const opponentInput = document.getElementById('sqOpponentUsername');
    const gridSizeSel   = document.getElementById('sqGridSize');
    const flashSpeedSel = document.getElementById('sqFlashSpeed');
    const createBtn     = document.getElementById('sqCreateBtn');
    const joinBtn       = document.getElementById('sqJoinBtn');
    const joinCodeInput = document.getElementById('sqJoinCode');
    const waitingRoomEl = document.getElementById('sqWaitingRoom');
    const autoJoiningEl = document.getElementById('sqAutoJoining');
    const roomCodeEl    = document.getElementById('sqRoomCodeDisplay');
    const shareLinkInput= document.getElementById('sqShareLink');
    const copyLinkBtn   = document.getElementById('sqCopyLinkBtn');
    const lobbyErrorEl  = document.getElementById('sqLobbyError');

    const boardEl       = document.getElementById('sqBoard');
    const statusEl      = document.getElementById('sqStatus');
    const roundLabel    = document.getElementById('sqRoundLabel');
    const turnIndicator = document.getElementById('sqTurnIndicator');
    const youNameEl     = document.getElementById('sqYouName');
    const oppNameEl     = document.getElementById('sqOppName');
    const youProgressEl = document.getElementById('sqYouProgress');
    const oppProgressEl = document.getElementById('sqOppProgress');
    const gameOverEl    = document.getElementById('sqGameOver');
    const rematchBtn    = document.getElementById('sqRematchBtn');
    const leaveBtn      = document.getElementById('sqLeaveBtn');
    const fsBtn         = document.getElementById('sqFullscreenBtn');
    const container     = document.getElementById('sqContainer');

    const state = {
        mySid: null,
        players: {},
        gridSize: 4,
        seqLength: 0,
        activeSid: null,
        myTurn: false,
        finished: false,
        rematchAsked: false,
    };

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    const presetRoom = new URLSearchParams(window.location.search).get('room');

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
    }

    function otherSid() {
        return Object.keys(state.players).find(sid => sid !== state.mySid) || null;
    }

    function setStatus(text, cls) {
        statusEl.textContent = text;
        statusEl.className = 'sequence-status' + (cls ? ' ' + cls : '');
    }

    function fallBackToManualJoin(message) {
        autoJoiningEl.style.display = 'none';
        lobbyErrorEl.textContent = message;
        if (presetRoom) joinCodeInput.value = presetRoom.toUpperCase();
    }

    /* ── Lobby ──────────────────────────────────────────────────────── */
    createBtn.addEventListener('click', () => {
        const username = usernameInput.value.trim() || 'Player 1';
        localStorage.setItem('imgur.username', username);
        lobbyErrorEl.textContent = '';
        socket.emit('sq_create', {
            collection: CURRENT_COLLECTION,
            username,
            opponentUsername: opponentInput.value.trim() || 'Player 2',
            gridSize: parseInt(gridSizeSel.value, 10),
            flashSpeed: parseInt(flashSpeedSel.value, 10),
        });
    });

    joinBtn.addEventListener('click', () => {
        const code = joinCodeInput.value.trim().toUpperCase();
        if (!code) { lobbyErrorEl.textContent = 'Enter a room code first.'; return; }
        lobbyErrorEl.textContent = '';
        socket.emit('sq_join', { code });
    });

    copyLinkBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(shareLinkInput.value).then(() => {
            copyLinkBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            setTimeout(() => { copyLinkBtn.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 1500);
        }).catch(() => {});
    });

    socket.on('connect', () => {
        state.mySid = socket.id;
        if (presetRoom) {
            autoJoiningEl.style.display = 'flex';
            document.querySelector('.mm-lobby-options').style.display = 'none';
            socket.emit('sq_join', { code: presetRoom.toUpperCase() });
        }
    });

    socket.on('sq_error', (data) => {
        const message = (data && data.message) || 'Something went wrong.';
        if (autoJoiningEl.style.display !== 'none') {
            fallBackToManualJoin(message);
        } else {
            lobbyErrorEl.textContent = message;
        }
    });

    socket.on('sq_created', (data) => {
        roomCodeEl.textContent = data.code;
        shareLinkInput.value = `${window.location.origin}${window.location.pathname}?room=${data.code}`;
        waitingRoomEl.style.display = 'flex';
    });

    /* ── Board ──────────────────────────────────────────────────────── */
    function buildBoard(board, gridSize) {
        state.gridSize = gridSize;
        boardEl.innerHTML = '';
        boardEl.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;
        board.forEach((url, i) => {
            const cell = document.createElement('div');
            cell.className = 'sequence-cell';
            cell.dataset.index = i;
            const img = document.createElement('img');
            img.src = url;
            img.alt = '';
            cell.appendChild(img);
            cell.addEventListener('click', () => handleTap(i));
            boardEl.appendChild(cell);
        });
    }

    function setBoardClickable(on) {
        boardEl.querySelectorAll('.sequence-cell')
            .forEach(c => c.classList.toggle('clickable', on));
    }

    function handleTap(index) {
        // No optimistic highlight: the server echoes every tap back via
        // sq_tap_landed so both players see it at the same moment. Painting it
        // locally first would put the two boards out of step.
        if (!state.myTurn) return;
        socket.emit('sq_tap', { index });
    }

    function setProgress(el, step, length) {
        el.style.width = length ? `${Math.round((step / length) * 100)}%` : '0%';
    }

    function resetProgressBars() {
        setProgress(youProgressEl, 0, state.seqLength);
        setProgress(oppProgressEl, 0, state.seqLength);
        [youProgressEl, oppProgressEl].forEach(el => el.classList.remove('done', 'failed'));
    }

    function activeProgressEl() {
        return state.activeSid === state.mySid ? youProgressEl : oppProgressEl;
    }

    // The board is one shared surface, so it needs to say plainly whose hands are
    // on it — otherwise the idle player can't tell whether a tap they're watching
    // is theirs to make.
    function setTurnUi(activeSid) {
        state.activeSid = activeSid;
        state.myTurn = activeSid === state.mySid;
        document.getElementById('sqYouCard').classList.toggle('sq-active', state.myTurn);
        document.getElementById('sqOppCard').classList.toggle('sq-active', !state.myTurn && !!activeSid);
        boardEl.classList.toggle('sq-spectating', !state.myTurn);
    }

    function clearTapMarks() {
        boardEl.querySelectorAll('.sequence-cell')
            .forEach(c => c.classList.remove('tapped', 'tap-wrong'));
    }

    function enterMatch(data) {
        state.players = data.players || {};
        state.finished = false;
        state.rematchAsked = false;
        lobbyEl.style.display = 'none';
        matchEl.style.display = 'block';
        gameOverEl.style.display = 'none';
        rematchBtn.style.display = 'none';
        rematchBtn.disabled = false;
        rematchBtn.innerHTML = '<i class="fas fa-rotate-right"></i> Play Again';

        youNameEl.textContent = state.players[state.mySid] || 'You';
        const opp = otherSid();
        oppNameEl.textContent = (opp && state.players[opp]) || 'Opponent';

        buildBoard(data.board, data.gridSize);
        resetProgressBars();
        clearTapMarks();
        setTurnUi(null);
        rematchBtn.classList.remove('sq-pulse');
    }

    socket.on('sq_joined', () => { autoJoiningEl.style.display = 'none'; });
    socket.on('sq_game_start', enterMatch);
    socket.on('sq_rematch_start', enterMatch);

    /* ── Turn flow ──────────────────────────────────────────────────── */
    socket.on('sq_turn_start', (data) => {
        state.seqLength = data.length;
        state.myTurn = false;              // nobody taps while it's flashing
        setTurnUi(data.activeSid);
        state.myTurn = false;
        clearTapMarks();
        resetProgressBars();
        setBoardClickable(false);
        roundLabel.textContent = `Round ${data.round} · Turn ${data.turn}`;

        const who = data.activeSid === state.mySid
            ? 'Your turn'
            : `${state.players[data.activeSid] || 'Opponent'}'s turn`;
        turnIndicator.textContent = `${who} · ${data.length} to remember`;
        setStatus('Watch carefully…', 'watching');
    });

    socket.on('sq_flash', (data) => {
        const cell = boardEl.querySelector(`.sequence-cell[data-index="${data.index}"]`);
        if (!cell) return;
        cell.classList.add('flash');
        setTimeout(() => cell.classList.remove('flash'), data.durationMs || 600);
    });

    socket.on('sq_input_open', (data) => {
        state.seqLength = data.length;
        setTurnUi(data.activeSid);
        setBoardClickable(state.myTurn);
        setStatus(
            state.myTurn
                ? 'Go! Repeat the sequence'
                : `Watching ${state.players[data.activeSid] || 'your opponent'}…`,
            state.myTurn ? 'playing' : 'watching'
        );
    });

    // The spectate feature: every tap the active player makes lands on both
    // boards at the same instant, right or wrong.
    socket.on('sq_tap_landed', (data) => {
        const cell = boardEl.querySelector(`.sequence-cell[data-index="${data.index}"]`);
        if (cell) {
            cell.classList.add(data.correct ? 'tapped' : 'tap-wrong');
            if (data.correct) {
                setTimeout(() => cell.classList.remove('tapped'), 420);
            }
        }
        setProgress(activeProgressEl(), data.step, data.length);
    });

    socket.on('sq_turn_cleared', (data) => {
        state.myTurn = false;
        setBoardClickable(false);
        activeProgressEl().classList.add('done');
        const mine = data.sid === state.mySid;
        setStatus(
            mine ? `✓ All ${data.length} — over to them` : '✓ They got it. Your turn next…',
            'correct'
        );
    });

    /* ── Game over + rematch ────────────────────────────────────────── */
    socket.on('sq_game_over', (data) => {
        state.myTurn = false;
        state.finished = true;
        setBoardClickable(false);
        setTurnUi(null);

        const iLost = data.loserSid === state.mySid;
        const iWon  = data.winnerSid === state.mySid;
        const reasonText = {
            wrong: 'wrong cell',
            time:  'ran out of time',
            left:  'left the duel',
        }[data.reason] || 'ended';

        const cleared = (data.cleared || {})[state.mySid] || 0;
        const oppCleared = (data.cleared || {})[otherSid()] || 0;
        const tally = `You cleared ${cleared} turn${cleared === 1 ? '' : 's'}, they cleared ${oppCleared}.`;

        let headline, sub;
        if (!data.loserSid && data.reason === 'left') {
            headline = 'Opponent left';
            sub = 'They forfeited the duel.';
        } else if (!data.loserSid) {
            headline = 'Duel over';
            sub = tally;
        } else if (iWon) {
            headline = 'You win!';
            sub = `${escapeHtml(state.players[data.loserSid] || 'Your opponent')} broke first — ${reasonText} on a ${data.length}-cell sequence. ${tally}`;
        } else if (iLost) {
            headline = 'You broke first';
            sub = `You ${reasonText} on a ${data.length}-cell sequence in round ${data.round}. ${tally}`;
        } else {
            headline = 'Duel over';
            sub = tally;
        }

        setStatus(iLost ? '✗ That was the wrong one' : 'Duel over', iLost ? 'wrong' : 'correct');
        gameOverEl.innerHTML =
            `<h2>${escapeHtml(headline)}</h2>` +
            `<p>${sub}</p>` +
            `<p class="sq-rematch-note" id="sqRematchNote">Both players need to tap Play Again to start a new duel.</p>`;
        gameOverEl.style.display = 'block';
        rematchBtn.style.display = 'inline-block';
    });

    rematchBtn.addEventListener('click', () => {
        if (!state.finished || state.rematchAsked) return;
        state.rematchAsked = true;
        rematchBtn.disabled = true;
        rematchBtn.innerHTML = '<i class="fas fa-hourglass-half"></i> Waiting for opponent…';
        socket.emit('sq_rematch', {});
    });

    socket.on('sq_rematch_state', (data) => {
        const note = document.getElementById('sqRematchNote');
        if (!note) return;
        const ready = data.ready || [];
        if (ready.includes(state.mySid) && ready.length < 2) {
            note.textContent = 'Waiting for your opponent to accept…';
        } else if (!ready.includes(state.mySid) && ready.length) {
            const who = state.players[ready[0]] || 'Your opponent';
            note.textContent = `${who} wants a rematch — tap Play Again.`;
            rematchBtn.classList.add('sq-pulse');
        }
    });

    socket.on('sq_opponent_left', () => {
        if (!state.finished) {
            state.myTurn = false;
            setBoardClickable(false);
            setStatus('Your opponent left the duel.', 'wrong');
        }
        rematchBtn.style.display = 'none';
    });

    /* ── Chrome ─────────────────────────────────────────────────────── */
    leaveBtn.addEventListener('click', () => {
        window.location.href = `/collection/${CURRENT_COLLECTION}`;
    });

    fsBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            container.requestFullscreen && container.requestFullscreen();
        } else {
            document.exitFullscreen && document.exitFullscreen();
        }
    });

    document.addEventListener('fullscreenchange', () => {
        fsBtn.innerHTML = document.fullscreenElement
            ? '<i class="fas fa-compress"></i> Exit Fullscreen'
            : '<i class="fas fa-expand"></i> Fullscreen';
    });
});

/**
 * Compatibility Check — live 2-player Socket.IO game.
 *
 * Each round both players see the same image and the same small set of its
 * tags (filtered server-side to just the relevant body-part categories —
 * chest/butt/penis for "gay"-named collections, boobs/pussy/butt otherwise).
 * Each player privately picks the one that attracted them most; once both
 * have picked (or the round timer runs out) the picks are revealed together
 * with a match/no-match indicator. At the end, a compatibility percentage
 * and a round-by-round review table are shown once — nothing is persisted.
 *
 * Server (app.py) owns all match state — this file is a thin render/input
 * layer over the `cc_*` Socket.IO events. Players are identified by their
 * own socket id, never by username.
 *
 * gameType: 'compatcheck' (not submitted to any leaderboard — one-time result)
 */
document.addEventListener('DOMContentLoaded', () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    if (typeof io === 'undefined') {
        console.error('Socket.IO failed to load — check the CDN link.');
        return;
    }

    /* ── DOM ────────────────────────────────────────────────────────── */
    const lobbyEl        = document.getElementById('ccLobby');
    const matchEl        = document.getElementById('ccMatch');
    const usernameInput  = document.getElementById('ccUsername');
    const opponentUsernameInput = document.getElementById('ccOpponentUsername');
    const numRoundsInput = document.getElementById('ccNumRounds');
    const roundsHintEl   = document.getElementById('ccRoundsHint');
    const roundSecondsInput = document.getElementById('ccRoundSeconds');
    const configSavedHintEl = document.getElementById('ccConfigSavedHint');
    const createBtn      = document.getElementById('ccCreateBtn');
    const joinBtn        = document.getElementById('ccJoinBtn');
    const joinCodeInput  = document.getElementById('ccJoinCode');
    const waitingRoomEl  = document.getElementById('ccWaitingRoom');
    const autoJoiningEl  = document.getElementById('ccAutoJoining');
    const roomCodeEl     = document.getElementById('ccRoomCodeDisplay');
    const shareLinkInput = document.getElementById('ccShareLink');
    const copyLinkBtn    = document.getElementById('ccCopyLinkBtn');
    const lobbyOptionsEl = document.querySelector('#ccLobby .vz-lobby-options');
    const lobbyErrorEl   = document.getElementById('ccLobbyError');

    const youNameEl   = document.getElementById('ccYouName');
    const oppNameEl   = document.getElementById('ccOppName');
    const roundNumEl  = document.getElementById('ccRoundNum');
    const roundTotalEl = document.getElementById('ccRoundTotal');
    const timerFillEl = document.getElementById('ccTimerFill');
    const messageEl   = document.getElementById('ccMessage');

    const roundImageEl = document.getElementById('ccRoundImage');
    const optionsEl    = document.getElementById('ccOptions');
    const revealEl      = document.getElementById('ccReveal');

    const matchOverEl = document.getElementById('ccMatchOver');
    const rematchBtn  = document.getElementById('ccRematchBtn');
    const fsBtn       = document.getElementById('ccFullscreenBtn');
    const leaveBtn    = document.getElementById('ccLeaveBtn');
    const ccContainer = document.getElementById('ccContainer');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // Restore the host's last-used match settings, if any.
    const CC_CONFIG_KEY = 'cc.config';
    try {
        const savedConfig = JSON.parse(localStorage.getItem(CC_CONFIG_KEY) || 'null');
        if (savedConfig) {
            if (savedConfig.opponentUsername) opponentUsernameInput.value = savedConfig.opponentUsername;
            if (savedConfig.numRounds) numRoundsInput.value = savedConfig.numRounds;
            if (savedConfig.roundSeconds) roundSecondsInput.value = savedConfig.roundSeconds;
        }
    } catch (e) { /* ignore malformed saved config */ }

    const presetRoom = new URLSearchParams(window.location.search).get('room');
    if (presetRoom) joinCodeInput.value = presetRoom.toUpperCase();

    function fallBackToManualJoin(errorMessage) {
        autoJoiningEl.style.display = 'none';
        lobbyOptionsEl.style.display = 'flex';
        if (errorMessage) lobbyErrorEl.textContent = errorMessage;
    }

    // Let the host know up front roughly how many rounds are possible —
    // the server has the real per-collection eligibility logic (which
    // images carry enough of the relevant tags) and re-validates regardless.
    fetch(`/api/collections/${COLLECTION}/images`)
        .then(r => r.json())
        .then(data => {
            const count = (data.success && data.images) ? data.images.length : 0;
            roundsHintEl.textContent = count
                ? `This collection has up to ${count} images — the actual cap depends on how many carry the relevant tags (checked when you create the match).`
                : '';
        })
        .catch(() => { roundsHintEl.textContent = ''; });

    /* ══════════════════════════════════════════════════════════════════
       STATE
    ══════════════════════════════════════════════════════════════════ */
    const state = {
        mySid: null,
        myUsername: '',
        oppSid: null,
        roundActive: false,
        selected: false,
        timerInterval: null,
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
            socket.emit('cc_join', { code: presetRoom.toUpperCase() });
        }
    });

    /* ── Lobby ─────────────────────────────────────────────────────── */
    createBtn.addEventListener('click', () => {
        const username = usernameInput.value.trim() || 'Player 1';
        const opponentUsername = opponentUsernameInput.value.trim() || 'Player 2';
        const numRounds = parseInt(numRoundsInput.value, 10) || 5;
        const roundSeconds = parseInt(roundSecondsInput.value, 10) || 20;
        localStorage.setItem('imgur.username', username);

        localStorage.setItem(CC_CONFIG_KEY, JSON.stringify({
            opponentUsername, numRounds, roundSeconds,
        }));
        configSavedHintEl.textContent = 'Settings saved for next time.';

        lobbyErrorEl.textContent = '';
        socket.emit('cc_create', {
            collection: COLLECTION, username, opponentUsername, numRounds, roundSeconds,
        });
    });

    joinBtn.addEventListener('click', () => {
        const code = joinCodeInput.value.trim().toUpperCase();
        if (!code) { lobbyErrorEl.textContent = 'Enter a room code first.'; return; }
        lobbyErrorEl.textContent = '';
        socket.emit('cc_join', { code });
    });

    socket.on('cc_error', (data) => {
        const message = data.message || 'Something went wrong.';
        if (autoJoiningEl.style.display !== 'none') {
            fallBackToManualJoin(message);
        } else if (matchEl.style.display !== 'none') {
            messageEl.innerHTML = `<span class="vz-msg-wrong">${message}</span>`;
        } else {
            lobbyErrorEl.textContent = message;
        }
    });

    socket.on('cc_created', (data) => {
        state.myUsername = data.username;
        roomCodeEl.textContent = data.code;
        const link = `${window.location.origin}${window.location.pathname}?room=${data.code}`;
        shareLinkInput.value = link;
        waitingRoomEl.style.display = 'flex';
    });

    socket.on('cc_joined', (data) => {
        state.myUsername = data.username;
    });

    copyLinkBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(shareLinkInput.value).then(() => {
            copyLinkBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            setTimeout(() => { copyLinkBtn.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 1500);
        }).catch(() => {});
    });

    /* ── Match ─────────────────────────────────────────────────────── */
    function showMatchUI() {
        lobbyEl.style.display = 'none';
        matchEl.style.display = 'block';
        if (!state.matchStartTime) state.matchStartTime = Date.now();
    }

    function nameFor(players, sid) {
        return (players && players[sid]) || 'Partner';
    }

    const CATEGORY_LABELS = {
        boobs: 'Boobs', pussy: 'Pussy', butt: 'Butt', chest: 'Chest', penis: 'Penis',
    };

    function startTimer(seconds) {
        clearInterval(state.timerInterval);
        timerFillEl.style.width = '100%';
        timerFillEl.style.transition = 'none';
        requestAnimationFrame(() => {
            timerFillEl.style.transition = `width ${seconds}s linear`;
            timerFillEl.style.width = '0%';
        });
    }

    socket.on('cc_round', (data) => {
        showMatchUI();
        state.roundActive = true;
        state.selected = false;

        roundNumEl.textContent = data.round;
        roundTotalEl.textContent = data.totalRounds;
        const oppSid = Object.keys(data.players || {}).find(sid => sid !== state.mySid);
        state.oppSid = oppSid;
        youNameEl.textContent = nameFor(data.players, state.mySid);
        oppNameEl.textContent = oppSid ? nameFor(data.players, oppSid) : '—';

        roundImageEl.src = data.imageUrl;
        optionsEl.innerHTML = '';
        Object.entries(data.options || {}).forEach(([category, tagText]) => {
            const btn = document.createElement('button');
            btn.className = 'cc-option-btn';
            btn.dataset.category = category;
            btn.innerHTML = `<span class="cc-option-category">${CATEGORY_LABELS[category] || category}</span><span class="cc-option-tag">${tagText}</span>`;
            btn.addEventListener('click', () => {
                if (!state.roundActive || state.selected) return;
                state.selected = true;
                optionsEl.querySelectorAll('.cc-option-btn').forEach(b => b.classList.add('cc-option-disabled'));
                btn.classList.add('cc-option-chosen');
                socket.emit('cc_select', { category });
                messageEl.innerHTML = '<span class="vz-msg-waiting">Locked in — waiting for your partner&hellip;</span>';
            });
            optionsEl.appendChild(btn);
        });

        startTimer(data.secondsLeft);
        messageEl.innerHTML = '<span class="vz-msg-prompt">Which one attracted you most?</span>';
        revealEl.style.display = 'none';
        matchOverEl.style.display = 'none';
        rematchBtn.style.display = 'none';
    });

    socket.on('cc_reveal', (data) => {
        state.roundActive = false;
        clearInterval(state.timerInterval);
        timerFillEl.style.transition = 'none';
        timerFillEl.style.width = '0%';

        const mySel = data.selections[state.mySid];
        const oppSel = state.oppSid ? data.selections[state.oppSid] : null;
        const fmt = (cat) => cat ? (CATEGORY_LABELS[cat] || cat) : 'No pick';

        revealEl.innerHTML = `
            <div class="cc-reveal-row">
                <div class="cc-reveal-pick cc-reveal-you"><span>YOU</span><strong>${fmt(mySel)}</strong></div>
                <div class="cc-reveal-result ${data.match ? 'cc-reveal-match' : 'cc-reveal-nomatch'}">
                    <i class="fas ${data.match ? 'fa-heart' : 'fa-heart-crack'}"></i>
                    ${data.match ? 'MATCH!' : 'No match'}
                </div>
                <div class="cc-reveal-pick cc-reveal-opp"><span>${oppNameEl.textContent.toUpperCase()}</span><strong>${fmt(oppSel)}</strong></div>
            </div>`;
        revealEl.style.display = 'block';

        messageEl.innerHTML = data.round < data.totalRounds
            ? '<span class="vz-msg-next">Next round starting soon&hellip;</span>'
            : '';
    });

    socket.on('cc_match_over', (data) => {
        const compat = data.compatibility;
        let flavor;
        if (compat >= 80) flavor = 'Soulmates 💞';
        else if (compat >= 50) flavor = 'Good Chemistry 🔥';
        else flavor = 'Opposites Attract 🤷';

        const oppSid = state.oppSid;
        const rowsHtml = (data.history || []).map(round => {
            const mySel = round.selections[state.mySid];
            const oppSel = oppSid ? round.selections[oppSid] : null;
            const fmt = (cat) => cat ? (CATEGORY_LABELS[cat] || cat) : '—';
            return `
                <tr>
                    <td><img src="${round.imageUrl}" alt="" class="cc-table-thumb"></td>
                    <td>${fmt(mySel)}</td>
                    <td>${fmt(oppSel)}</td>
                    <td>${round.match ? '<i class="fas fa-check cc-table-yes"></i>' : '<i class="fas fa-xmark cc-table-no"></i>'}</td>
                </tr>`;
        }).join('');

        matchOverEl.innerHTML = `
            <div class="vz-over-banner">
                <i class="fas fa-heart-circle-check"></i>
                <h2>${compat}% Compatible</h2>
                <p>${flavor} — matched on ${data.matchCount} of ${data.totalRounds} rounds</p>
            </div>
            <div class="cc-history-table-wrap">
                <table class="cc-history-table">
                    <thead><tr><th>Image</th><th>You picked</th><th>${oppNameEl.textContent} picked</th><th>Match</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>`;
        matchOverEl.style.display = 'block';
        rematchBtn.style.display = 'inline-block';
        revealEl.style.display = 'none';
        messageEl.innerHTML = '';
    });

    socket.on('cc_opponent_left', () => {
        clearInterval(state.timerInterval);
        state.roundActive = false;
        messageEl.innerHTML = '<span class="vz-msg-wrong">Your partner disconnected.</span>';
        matchOverEl.innerHTML = `
            <div class="vz-over-banner">
                <i class="fas fa-plug-circle-xmark"></i>
                <h2>Partner Left</h2>
                <p>Start a new match whenever you're ready.</p>
            </div>`;
        matchOverEl.style.display = 'block';
        rematchBtn.style.display = 'inline-block';
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
                ccContainer.requestFullscreen().catch(err => console.warn(err));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === ccContainer;
            fsBtn.innerHTML = isFS
                ? '<i class="fas fa-compress"></i> Exit Fullscreen'
                : '<i class="fas fa-expand"></i> Fullscreen';
        });
    }
});

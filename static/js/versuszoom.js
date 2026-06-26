/**
 * Versus Zoom Reveal — live 2-player game over Socket.IO.
 *
 * Each round, both players are shown the same two full images (blurred,
 * same left/right order for both) while each privately sees a different
 * zoomed-in crop — one snipped from image 1, the other from image 2.
 * Race to guess which of the two your own snippet came from; correct
 * guesses score, a round where BOTH players guess correctly gets a bonus.
 *
 * Server (app.py) owns all match state — this file is a thin render/input
 * layer over the `vz_*` Socket.IO events. Players are identified by their
 * own socket id (never by username, since two players could pick the same
 * display name).
 *
 * gameType: 'versuszoom'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    if (typeof THREE === 'undefined' || typeof io === 'undefined') {
        console.error('Three.js or Socket.IO failed to load — check CDN links.');
        return;
    }

    /* ── DOM ────────────────────────────────────────────────────────── */
    const lobbyEl        = document.getElementById('vzLobby');
    const matchEl        = document.getElementById('vzMatch');
    const usernameInput  = document.getElementById('vzUsername');
    const opponentUsernameInput = document.getElementById('vzOpponentUsername');
    const createBtn      = document.getElementById('vzCreateBtn');
    const joinBtn        = document.getElementById('vzJoinBtn');
    const joinCodeInput  = document.getElementById('vzJoinCode');
    const waitingRoomEl  = document.getElementById('vzWaitingRoom');
    const autoJoiningEl  = document.getElementById('vzAutoJoining');
    const roomCodeEl     = document.getElementById('vzRoomCodeDisplay');
    const shareLinkInput = document.getElementById('vzShareLink');
    const copyLinkBtn    = document.getElementById('vzCopyLinkBtn');
    const lobbyOptionsEl = document.querySelector('.vz-lobby-options');
    const lobbyErrorEl   = document.getElementById('vzLobbyError');

    const youNameEl   = document.getElementById('vzYouName');
    const youScoreEl   = document.getElementById('vzYouScore');
    const oppNameEl    = document.getElementById('vzOppName');
    const oppScoreEl   = document.getElementById('vzOppScore');
    const roundNumEl   = document.getElementById('vzRoundNum');
    const roundTotalEl = document.getElementById('vzRoundTotal');
    const timerFillEl  = document.getElementById('vzTimerFill');
    const messageEl    = document.getElementById('vzMessage');

    const snippetWrap = document.getElementById('vzSnippetCanvasWrap');
    const cards    = [document.getElementById('vzCard0'), document.getElementById('vzCard1')];
    const cardImgs = [document.getElementById('vzCardImg0'), document.getElementById('vzCardImg1')];
    const cropBoxes = [document.getElementById('vzCropBox0'), document.getElementById('vzCropBox1')];
    const resultEls  = [document.getElementById('vzResult0'), document.getElementById('vzResult1')];

    const matchOverEl = document.getElementById('vzMatchOver');
    const rematchBtn  = document.getElementById('vzRematchBtn');
    const fsBtn       = document.getElementById('vzFullscreenBtn');
    const leaveBtn    = document.getElementById('vzLeaveBtn');
    const vzContainer = document.getElementById('vzContainer');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    const presetRoom = new URLSearchParams(window.location.search).get('room');
    if (presetRoom) joinCodeInput.value = presetRoom.toUpperCase();

    function fallBackToManualJoin(errorMessage) {
        autoJoiningEl.style.display = 'none';
        lobbyOptionsEl.style.display = 'flex';
        if (errorMessage) lobbyErrorEl.textContent = errorMessage;
    }

    /* ══════════════════════════════════════════════════════════════════
       STATE
    ══════════════════════════════════════════════════════════════════ */
    const state = {
        mySid: null,
        myUsername: '',
        roundActive: false,
        answered: false,
        timerInterval: null,
        matchStartTime: null,
    };

    /* ══════════════════════════════════════════════════════════════════
       THREE.JS — "your snippet" display
    ══════════════════════════════════════════════════════════════════ */
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x120a14);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10);
    camera.position.set(0, 0, 3.4);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width   = '100%';
    renderer.domElement.style.height  = '100%';
    snippetWrap.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const snippetLight = new THREE.PointLight(0xff77aa, 0.6, 8);
    snippetLight.position.set(1.5, 1.5, 2.5);
    scene.add(snippetLight);

    const backing = new THREE.Mesh(
        new THREE.BoxGeometry(2.05, 2.05, 0.08),
        new THREE.MeshStandardMaterial({ color: 0x2a1530, metalness: 0.6, roughness: 0.35 })
    );
    scene.add(backing);

    const snippetMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.9, 1.9),
        new THREE.MeshBasicMaterial({ map: null, color: 0x222222 })
    );
    snippetMesh.position.z = 0.05;
    scene.add(snippetMesh);

    function handleResize() {
        const w = snippetWrap.clientWidth;
        renderer.setSize(w, w, false);
        camera.aspect = 1;
        camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', handleResize);

    function disposeSnippetTexture() {
        if (snippetMesh.material.map) snippetMesh.material.map.dispose();
    }

    function loadCroppedTexture(url, box) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const size = 512;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#1a0f1f';
            ctx.fillRect(0, 0, size, size);

            const sx = box.x * img.naturalWidth;
            const sy = box.y * img.naturalHeight;
            const sw = box.w * img.naturalWidth;
            const sh = box.h * img.naturalHeight;
            const srcAspect = sw / sh;
            let dw = size, dh = size, dx = 0, dy = 0;
            if (srcAspect > 1) { dh = size / srcAspect; dy = (size - dh) / 2; }
            else { dw = size * srcAspect; dx = (size - dw) / 2; }
            ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);

            const tex = new THREE.CanvasTexture(canvas);
            tex.encoding = THREE.sRGBEncoding;
            tex.needsUpdate = true;

            disposeSnippetTexture();
            snippetMesh.material.map = tex;
            snippetMesh.material.color.set(0xffffff);
            snippetMesh.material.needsUpdate = true;
        };
        img.onerror = () => console.error('VersusZoom: failed to load snippet image', url);
        img.src = url;
    }

    let animElapsed = 0;
    function animate(ts) {
        requestAnimationFrame(animate);
        animElapsed = ts / 1000;
        snippetMesh.rotation.y = Math.sin(animElapsed * 0.6) * 0.16;
        snippetMesh.rotation.x = Math.sin(animElapsed * 0.42) * 0.09;
        backing.rotation.copy(snippetMesh.rotation);
        renderer.render(scene, camera);
    }
    requestAnimationFrame(animate);

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
            socket.emit('vz_join', { code: presetRoom.toUpperCase() });
        }
    });

    /* ── Lobby ─────────────────────────────────────────────────────── */
    createBtn.addEventListener('click', () => {
        const username = usernameInput.value.trim() || 'Player 1';
        const opponentUsername = opponentUsernameInput.value.trim() || 'Player 2';
        localStorage.setItem('imgur.username', username);
        lobbyErrorEl.textContent = '';
        socket.emit('vz_create', { collection: COLLECTION, username, opponentUsername });
    });

    joinBtn.addEventListener('click', () => {
        const code = joinCodeInput.value.trim().toUpperCase();
        if (!code) { lobbyErrorEl.textContent = 'Enter a room code first.'; return; }
        lobbyErrorEl.textContent = '';
        socket.emit('vz_join', { code });
    });

    socket.on('vz_error', (data) => {
        const message = data.message || 'Something went wrong.';
        if (autoJoiningEl.style.display !== 'none') {
            fallBackToManualJoin(message);
        } else {
            lobbyErrorEl.textContent = message;
        }
    });

    socket.on('vz_created', (data) => {
        state.myUsername = data.username;
        roomCodeEl.textContent = data.code;
        const link = `${window.location.origin}${window.location.pathname}?room=${data.code}`;
        shareLinkInput.value = link;
        waitingRoomEl.style.display = 'flex';
    });

    socket.on('vz_joined', (data) => {
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
        // #vzSnippetCanvasWrap reports 0 width while its ancestor #vzMatch is
        // display:none, so the renderer was sized at page load before the
        // match panel ever became visible. Re-measure now that it's shown.
        handleResize();
    }

    function nameFor(players, sid) {
        return (players && players[sid]) || 'Opponent';
    }

    function renderScores(players, scores) {
        const oppSid = Object.keys(players || {}).find(sid => sid !== state.mySid);
        youNameEl.textContent = nameFor(players, state.mySid);
        oppNameEl.textContent = oppSid ? nameFor(players, oppSid) : '—';
        youScoreEl.textContent = (scores && scores[state.mySid]) || 0;
        oppScoreEl.textContent = (oppSid && scores && scores[oppSid]) || 0;
        return oppSid;
    }

    function resetCardsForNewRound() {
        cards.forEach((card, i) => {
            card.classList.remove('vz-card-correct', 'vz-card-wrong', 'vz-card-chosen', 'vz-card-disabled');
            cardImgs[i].style.filter = 'blur(22px)';
            cropBoxes[i].style.display = 'none';
            resultEls[i].innerHTML = '';
        });
    }

    function startTimer(seconds) {
        clearInterval(state.timerInterval);
        let remaining = seconds;
        timerFillEl.style.width = '100%';
        timerFillEl.style.transition = 'none';
        requestAnimationFrame(() => {
            timerFillEl.style.transition = `width ${seconds}s linear`;
            timerFillEl.style.width = '0%';
        });
        state.timerInterval = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) clearInterval(state.timerInterval);
        }, 1000);
    }

    socket.on('vz_round', (data) => {
        showMatchUI();
        state.roundActive = true;
        state.answered = false;

        roundNumEl.textContent = data.round;
        roundTotalEl.textContent = data.totalRounds;
        renderScores(data.players, data.scores);
        resetCardsForNewRound();
        startTimer(data.secondsLeft);

        cardImgs[0].src = data.images[0];
        cardImgs[1].src = data.images[1];
        loadCroppedTexture(data.yourCrop.imageUrl, data.yourCrop.box);

        messageEl.innerHTML = '<span class="vz-msg-prompt">Which image is your snippet from?</span>';
        matchOverEl.style.display = 'none';
        rematchBtn.style.display = 'none';
    });

    cards.forEach((card, idx) => {
        card.addEventListener('click', () => {
            if (!state.roundActive || state.answered) return;
            state.answered = true;
            cards.forEach(c => c.classList.add('vz-card-disabled'));
            card.classList.add('vz-card-chosen');
            socket.emit('vz_answer', { choice: idx });
            messageEl.innerHTML = '<span class="vz-msg-waiting">Locked in — waiting for your opponent&hellip;</span>';
        });
    });

    socket.on('vz_reveal', (data) => {
        state.roundActive = false;
        clearInterval(state.timerInterval);
        timerFillEl.style.transition = 'none';
        timerFillEl.style.width = '0%';

        const oppSid = renderScores(data.players, data.scores);

        cardImgs[0].style.filter = 'blur(0)';
        cardImgs[1].style.filter = 'blur(0)';

        data.crops.forEach((box, i) => {
            const el = cropBoxes[i];
            el.style.display = 'block';
            el.style.left   = (box.x * 100) + '%';
            el.style.top    = (box.y * 100) + '%';
            el.style.width  = (box.w * 100) + '%';
            el.style.height = (box.h * 100) + '%';
        });

        const myResult = data.results[state.mySid];
        const oppResult = oppSid ? data.results[oppSid] : null;

        if (myResult) {
            const card = cards[myResult.correctImageIndex];
            card.classList.add(myResult.isCorrect ? 'vz-card-correct' : 'vz-card-wrong');
            resultEls[myResult.correctImageIndex].innerHTML =
                `<span class="vz-tag vz-tag-you">${myResult.isCorrect ? '✅' : '❌'} Yours</span>`;
        }
        if (oppResult) {
            const card = cards[oppResult.correctImageIndex];
            card.classList.add(oppResult.isCorrect ? 'vz-card-correct' : 'vz-card-wrong');
            resultEls[oppResult.correctImageIndex].innerHTML +=
                `<span class="vz-tag vz-tag-opp">${oppResult.isCorrect ? '✅' : '❌'} ${nameFor(data.players, oppSid)}'s</span>`;
        }

        youNameEl.innerHTML = nameFor(data.players, state.mySid) + (myResult && myResult.isCorrect ? ' ✅' : myResult ? ' ❌' : '');
        oppNameEl.innerHTML = (oppSid ? nameFor(data.players, oppSid) : '—') + (oppResult && oppResult.isCorrect ? ' ✅' : oppResult ? ' ❌' : '');

        let msg = data.bothCorrect ? '<span class="vz-msg-perfect">Perfect round! Both of you nailed it. +50 bonus each!</span>'
                                     : (myResult && myResult.isCorrect ? '<span class="vz-msg-correct">You got it right!</span>'
                                        : '<span class="vz-msg-wrong">Not this time.</span>');
        if (data.round < data.totalRounds) {
            msg += ' <span class="vz-msg-next">Next round starting soon&hellip;</span>';
        }
        messageEl.innerHTML = msg;
    });

    socket.on('vz_match_over', (data) => {
        const oppSid = Object.keys(data.players || {}).find(sid => sid !== state.mySid);
        const myScore = (data.scores && data.scores[state.mySid]) || 0;
        const oppScore = (oppSid && data.scores && data.scores[oppSid]) || 0;
        const oppName = oppSid ? nameFor(data.players, oppSid) : 'Opponent';

        let banner;
        if (myScore > oppScore) banner = `<i class="fas fa-trophy"></i><h2>You Win!</h2>`;
        else if (myScore < oppScore) banner = `<i class="fas fa-flag"></i><h2>${oppName} Wins</h2>`;
        else banner = `<i class="fas fa-handshake"></i><h2>It's a Tie!</h2>`;

        matchOverEl.innerHTML = `
            <div class="vz-over-banner">
                ${banner}
                <p>Final score — You: <strong>${myScore}</strong> &middot; ${oppName}: <strong>${oppScore}</strong></p>
            </div>`;
        matchOverEl.style.display = 'block';
        rematchBtn.style.display = 'inline-block';
        messageEl.innerHTML = '';

        const elapsed = Math.floor((Date.now() - state.matchStartTime) / 1000);
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType: 'versuszoom',
                score: myScore,
                time: elapsed,
                username: state.myUsername,
            })
        }).catch(() => {});
    });

    socket.on('vz_opponent_left', () => {
        clearInterval(state.timerInterval);
        state.roundActive = false;
        messageEl.innerHTML = '<span class="vz-msg-wrong">Your opponent disconnected.</span>';
        matchOverEl.innerHTML = `
            <div class="vz-over-banner">
                <i class="fas fa-plug-circle-xmark"></i>
                <h2>Opponent Left</h2>
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
                vzContainer.requestFullscreen().catch(err => console.warn(err));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === vzContainer;
            fsBtn.innerHTML = isFS
                ? '<i class="fas fa-compress"></i> Exit Fullscreen'
                : '<i class="fas fa-expand"></i> Fullscreen';
            setTimeout(handleResize, 60);
        });
    }

    handleResize();
});

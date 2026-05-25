/**
 * Hot Bracket Game
 * Two images side-by-side; click your favourite to vote.
 * Win/loss tracked per image URL; running leaderboard of top 5 by win-rate.
 * After N rounds declare a champion.
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container     = document.getElementById('bracketContainer');
    const startBtn      = document.getElementById('startBrBtn');
    const resetBtn      = document.getElementById('resetBrBtn');
    const fullscreenBtn = document.getElementById('fullscreenBrBtn');
    const backBtn       = document.getElementById('backBrBtn');
    const roundEl       = document.getElementById('brRound');
    const totalEl       = document.getElementById('brTotal');
    const matchupsEl    = document.getElementById('brMatchups');
    const messageEl     = document.getElementById('brMessage');
    const cardA         = document.getElementById('brCardA');
    const cardB         = document.getElementById('brCardB');
    const imgA          = document.getElementById('brImgA');
    const imgB          = document.getElementById('brImgB');
    const leaderboardEl = document.getElementById('brLeaderboard');
    const lbListEl      = document.getElementById('brLbList');
    const roundsSel     = document.getElementById('brRounds');
    const usernameInput = document.getElementById('brUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];
    let scores    = {};   // { url: { wins: 0, losses: 0 } }

    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('Bracket: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let state = {
        active:    false,
        round:     0,
        maxRounds: 25,
        startTime: null,
        urlA:      null,
        urlB:      null
    };

    // ── Leaderboard ───────────────────────────────────────────────────────────
    function winRate(url) {
        const s = scores[url];
        if (!s) return 0;
        const total = s.wins + s.losses;
        if (total === 0) return 0;
        return s.wins / total;
    }

    function updateLeaderboard() {
        const contenders = Object.keys(scores).filter(url => {
            const s = scores[url];
            return s && (s.wins + s.losses) > 0;
        });

        if (contenders.length === 0) return;

        contenders.sort((a, b) => {
            const wr = winRate(b) - winRate(a);
            if (wr !== 0) return wr;
            return (scores[b].wins || 0) - (scores[a].wins || 0);
        });

        const top5 = contenders.slice(0, 5);
        lbListEl.innerHTML = '';
        top5.forEach((url, idx) => {
            const s  = scores[url];
            const wr = Math.round(winRate(url) * 100);
            const li = document.createElement('li');
            li.className = 'bracket-lb-item';
            li.innerHTML = `
                <span class="bracket-lb-rank">${idx + 1}</span>
                <img class="bracket-lb-thumb" src="${url}" alt="">
                <div class="bracket-lb-info">
                    <div class="bracket-lb-bar-wrap">
                        <div class="bracket-lb-bar" style="width:${wr}%"></div>
                    </div>
                    <span class="bracket-lb-wr">${wr}% win rate (${s.wins}W / ${s.losses}L)</span>
                </div>
            `;
            lbListEl.appendChild(li);
        });

        leaderboardEl.style.display = 'block';
    }

    // ── Matchup ───────────────────────────────────────────────────────────────
    function startMatchup() {
        if (!state.active) return;

        // Check round limit
        const maxR = parseInt(roundsSel.value, 10);
        if (maxR > 0 && state.round >= maxR) {
            endGame();
            return;
        }

        state.round++;
        roundEl.textContent = state.round;

        // Pick two distinct random images
        const shuffled = shuffle(allImages);
        const imgObjA  = shuffled[0];
        const imgObjB  = shuffled[1];
        state.urlA = imgObjA.url;
        state.urlB = imgObjB.url;

        imgA.src = state.urlA;
        imgB.src = state.urlB;

        // Disable cards until images load
        cardA.style.pointerEvents = 'none';
        cardB.style.pointerEvents = 'none';

        let loadedCount = 0;
        const onLoad = () => {
            loadedCount++;
            if (loadedCount >= 2) {
                cardA.style.pointerEvents = '';
                cardB.style.pointerEvents = '';
            }
        };
        if (imgA.complete) loadedCount++; else imgA.onload = onLoad;
        if (imgB.complete) loadedCount++; else imgB.onload = onLoad;
        if (loadedCount >= 2) { cardA.style.pointerEvents = ''; cardB.style.pointerEvents = ''; }

        cardA.classList.remove('bracket-winner', 'bracket-loser');
        cardB.classList.remove('bracket-winner', 'bracket-loser');
        messageEl.innerHTML = '<p class="bracket-prompt">Which is hotter? Click your favourite!</p>';
    }

    function recordVote(winner, loser) {
        if (!state.active) return;
        cardA.style.pointerEvents = 'none';
        cardB.style.pointerEvents = 'none';

        if (!scores[winner]) scores[winner] = { wins: 0, losses: 0 };
        if (!scores[loser])  scores[loser]  = { wins: 0, losses: 0 };
        scores[winner].wins++;
        scores[loser].losses++;

        const matchupsDone = Object.values(scores).reduce((s, v) => s + v.wins, 0);
        matchupsEl.textContent = matchupsDone;

        // Highlight winner / loser
        const isA = (winner === state.urlA);
        (isA ? cardA : cardB).classList.add('bracket-winner');
        (isA ? cardB : cardA).classList.add('bracket-loser');

        const wr = Math.round(winRate(winner) * 100);
        messageEl.innerHTML = `
            <div class="feedback success">
                <i class="fas fa-fire"></i> Voted! This image now has a <strong>${wr}% win rate</strong>
            </div>`;

        updateLeaderboard();
        setTimeout(() => { if (state.active) startMatchup(); }, 1400);
    }

    // ── End ───────────────────────────────────────────────────────────────────
    function endGame() {
        state.active = false;
        cardA.style.pointerEvents = 'none';
        cardB.style.pointerEvents = 'none';

        // Find champion — highest win rate with at least 1 win
        const champion = Object.keys(scores)
            .filter(url => scores[url].wins > 0)
            .sort((a, b) => winRate(b) - winRate(a))[0];

        let champHtml = '';
        if (champion) {
            const s  = scores[champion];
            const wr = Math.round(winRate(champion) * 100);
            champHtml = `
                <div class="bracket-champion">
                    <img src="${champion}" alt="Champion" class="bracket-champ-img">
                    <p><i class="fas fa-crown"></i> Champion — ${wr}% win rate (${s.wins}W / ${s.losses}L)</p>
                </div>`;
        }

        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-fire"></i>
                <h2>Bracket Complete!</h2>
                <p>Matchups: <strong>${state.round}</strong></p>
                ${champHtml}
            </div>`;

        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';
        updateLeaderboard();

        // Submit score
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        const user    = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        const totalVotes = Object.values(scores).reduce((s, v) => s + v.wins, 0);
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION, gameType: 'bracket',
                score: totalVotes * 10, rounds: state.round,
                time: elapsed, username: user
            })
        }).catch(() => {});
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function initGame() {
        if (allImages.length < 2) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 2 images to play!</div>';
            return;
        }
        scores = {};
        state  = {
            active:    true,
            round:     0,
            maxRounds: parseInt(roundsSel.value, 10),
            startTime: Date.now(),
            urlA:      null,
            urlB:      null
        };

        const maxR = parseInt(roundsSel.value, 10);
        roundEl.textContent    = '0';
        totalEl.textContent    = maxR > 0 ? maxR : '∞';
        matchupsEl.textContent = '0';
        messageEl.innerHTML    = '';
        leaderboardEl.style.display = 'none';
        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';
        startMatchup();
    }

    function resetGame() {
        state.active = false;
        scores = {};
        imgA.src = '';
        imgB.src = '';
        cardA.classList.remove('bracket-winner', 'bracket-loser');
        cardB.classList.remove('bracket-winner', 'bracket-loser');
        cardA.style.pointerEvents = 'none';
        cardB.style.pointerEvents = 'none';
        leaderboardEl.style.display = 'none';
        lbListEl.innerHTML = '';
        roundEl.textContent    = '0';
        totalEl.textContent    = '—';
        matchupsEl.textContent = '0';
        messageEl.innerHTML    = '';
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
    }

    // ── Fullscreen ────────────────────────────────────────────────────────────
    if (fullscreenBtn) {
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
    }

    // ── Wiring ────────────────────────────────────────────────────────────────
    cardA.addEventListener('click', () => {
        if (state.active && state.urlA && cardA.style.pointerEvents !== 'none')
            recordVote(state.urlA, state.urlB);
    });
    cardB.addEventListener('click', () => {
        if (state.active && state.urlB && cardB.style.pointerEvents !== 'none')
            recordVote(state.urlB, state.urlA);
    });

    startBtn.addEventListener('click', initGame);
    resetBtn.addEventListener('click', resetGame);
    backBtn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        window.location.href = `/collection/${COLLECTION}`;
    });

    await loadImages();
    if (allImages.length < 2) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:2rem">Need at least 2 images to play!</div>';
        startBtn.disabled = true;
    }
});

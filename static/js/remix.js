document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startRemixBtn');
    const resetBtn = document.getElementById('resetRemixBtn');
    const backBtn = document.getElementById('backRemixBtn');
    const fullscreenBtn = document.getElementById('fullscreenRemixBtn');
    const optionCountSelect = document.getElementById('remixOptionCount');
    const revealTimeSelect = document.getElementById('remixRevealTime');
    const usernameInput = document.getElementById('remixUsername');
    const targetSizeInput = document.getElementById('remixTargetSize');
    const targetSizeLabel = document.getElementById('remixTargetSizeLabel');
    const optionSizeInput = document.getElementById('remixOptionSize');
    const optionSizeLabel = document.getElementById('remixOptionSizeLabel');
    const scoreEl = document.getElementById('remixScore');
    const roundEl = document.getElementById('remixRound');
    const streakEl = document.getElementById('remixStreak');
    const timeEl = document.getElementById('remixTime');
    const stateEl = document.getElementById('remixState');
    const previewTextEl = document.getElementById('remixPreviewText');
    const targetEl = document.getElementById('remixTarget');
    const effectBadgeEl = document.getElementById('remixEffectBadge');
    const optionsEl = document.getElementById('remixOptions');
    const messageEl = document.getElementById('remixMessage');
    const shellEl = document.querySelector('.remix-shell');
    const navbarEl = document.querySelector('.navbar');

    const state = {
        active: false,
        canAnswer: false,
        score: 0,
        round: 0,
        streak: 0,
        startTime: null,
        timer: null,
        answerStartedAt: 0,
        targetUrl: '',
        correctOption: '',
        options: [],
        effect: null,
        previewTimeout: null
    };

    const prefs = {
        targetSize: 280,
        optionSize: 200
    };

    const effects = [
        { key: 'slice', label: 'Slice Drift' },
        { key: 'duo', label: 'Duotone Pulse' },
        { key: 'weave', label: 'Ribbon Weave' },
        { key: 'kaleido', label: 'Kaleido Mirror' },
        { key: 'prism', label: 'Prism Shatter' },
        { key: 'contour', label: 'Contour Glow' }
    ];

    try {
        const saved = JSON.parse(localStorage.getItem('remix.prefs') || '{}');
        if (saved && typeof saved === 'object') {
            prefs.targetSize = parseInt(saved.targetSize, 10) || prefs.targetSize;
            prefs.optionSize = parseInt(saved.optionSize, 10) || prefs.optionSize;
        }
    } catch (err) {
        console.warn('Failed to load remix prefs', err);
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

    function clearPreviewTimeout() {
        if (state.previewTimeout) {
            clearTimeout(state.previewTimeout);
            state.previewTimeout = null;
        }
    }

    function savePrefs() {
        try {
            localStorage.setItem('remix.prefs', JSON.stringify(prefs));
        } catch (err) {
            console.warn('Failed to save remix prefs', err);
        }
    }

    function applySizing() {
        shellEl.style.setProperty('--remix-target-size', `${prefs.targetSize}px`);
        shellEl.style.setProperty('--remix-option-size', `${prefs.optionSize}px`);
        targetSizeInput.value = String(prefs.targetSize);
        targetSizeLabel.textContent = `${prefs.targetSize}px`;
        optionSizeInput.value = String(prefs.optionSize);
        optionSizeLabel.textContent = `${prefs.optionSize}px`;
    }

    function setMessage(text, tone) {
        messageEl.textContent = text;
        messageEl.style.color = tone === 'error' ? '#ff6b81' : tone === 'success' ? '#2ecc71' : '#ffb76b';
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = url;
        });
    }

    function drawCover(ctx, img, size) {
        const scale = Math.max(size / img.width, size / img.height);
        const drawWidth = img.width * scale;
        const drawHeight = img.height * scale;
        const offsetX = (size - drawWidth) / 2;
        const offsetY = (size - drawHeight) / 2;
        ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
    }

    function createBaseCanvas(img, size) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        drawCover(ctx, img, size);
        return { canvas, ctx };
    }

    function applySliceEffect(ctx, img, size, seed) {
        const slices = 7;
        const sliceHeight = size / slices;
        for (let i = 0; i < slices; i += 1) {
            const sy = (img.height / slices) * i;
            const sh = img.height / slices;
            const drift = ((i % 2 === 0 ? 1 : -1) * (10 + (seed % 11)));
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, i * sliceHeight, size, sliceHeight);
            ctx.clip();
            ctx.drawImage(
                img,
                0,
                sy,
                img.width,
                sh,
                drift,
                i * sliceHeight,
                size,
                sliceHeight
            );
            ctx.restore();
        }
    }

    function applyDuotoneEffect(ctx, img, size, seed) {
        drawCover(ctx, img, size);
        const imageData = ctx.getImageData(0, 0, size, size);
        const data = imageData.data;
        const tones = [
            [255, 140, 84],
            [88, 214, 195],
            [255, 202, 58],
            [120, 129, 255]
        ];
        const dark = tones[seed % tones.length];
        const light = tones[(seed + 2) % tones.length];
        for (let i = 0; i < data.length; i += 4) {
            const luminance = (0.2126 * data[i]) + (0.7152 * data[i + 1]) + (0.0722 * data[i + 2]);
            const t = luminance / 255;
            data[i] = Math.round((dark[0] * (1 - t)) + (light[0] * t));
            data[i + 1] = Math.round((dark[1] * (1 - t)) + (light[1] * t));
            data[i + 2] = Math.round((dark[2] * (1 - t)) + (light[2] * t));
        }
        ctx.putImageData(imageData, 0, 0);
    }

    function applyWeaveEffect(ctx, img, size, seed) {
        const strips = 8;
        const stripWidth = size / strips;
        for (let i = 0; i < strips; i += 1) {
            const sx = (img.width / strips) * i;
            const sw = img.width / strips;
            const bounce = ((i % 2 === 0 ? -1 : 1) * (8 + (seed % 5)));
            ctx.save();
            ctx.beginPath();
            ctx.rect(i * stripWidth, 0, stripWidth, size);
            ctx.clip();
            ctx.drawImage(
                img,
                sx,
                0,
                sw,
                img.height,
                i * stripWidth,
                bounce,
                stripWidth,
                size
            );
            ctx.restore();
        }
    }

    function applyKaleidoEffect(ctx, img, size, seed) {
        const base = createBaseCanvas(img, size).canvas;
        const wedges = 8 + (seed % 4);
        const angle = (Math.PI * 2) / wedges;

        ctx.save();
        ctx.translate(size / 2, size / 2);
        for (let i = 0; i < wedges; i += 1) {
            ctx.save();
            ctx.rotate(i * angle);
            if (i % 2 === 1) {
                ctx.scale(-1, 1);
            }
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, size * 0.82, -angle / 2, angle / 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(base, -size / 2, -size / 2, size, size);
            ctx.restore();
        }
        ctx.restore();

        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size * 0.12, 0, Math.PI * 2);
        ctx.fill();
    }

    function applyPrismEffect(ctx, img, size, seed) {
        const base = createBaseCanvas(img, size).canvas;
        const shards = 10;
        const cx = size / 2;
        const cy = size / 2;

        for (let i = 0; i < shards; i += 1) {
            const start = ((Math.PI * 2) / shards) * i;
            const end = start + ((Math.PI * 2) / shards);
            const mid = (start + end) / 2;
            const radius = (size * 0.28) + ((i % 3) * size * 0.1);
            const dx = Math.cos(mid) * (12 + ((seed + i) % 14));
            const dy = Math.sin(mid) * (12 + ((seed + i * 2) % 14));

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(start) * size, cy + Math.sin(start) * size);
            ctx.lineTo(cx + Math.cos(mid) * radius, cy + Math.sin(mid) * radius);
            ctx.lineTo(cx + Math.cos(end) * size, cy + Math.sin(end) * size);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(base, dx, dy, size, size);
            ctx.restore();
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 2;
        for (let i = 0; i < shards; i += 1) {
            const theta = ((Math.PI * 2) / shards) * i;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(theta) * size, cy + Math.sin(theta) * size);
            ctx.stroke();
        }
    }

    function applyContourEffect(ctx, img, size, seed) {
        drawCover(ctx, img, size);
        const imageData = ctx.getImageData(0, 0, size, size);
        const src = imageData.data;
        const result = new Uint8ClampedArray(src.length);
        const stride = size * 4;
        const glow = [
            [88, 214, 195],
            [255, 159, 67],
            [120, 129, 255]
        ][seed % 3];

        for (let y = 1; y < size - 1; y += 1) {
            for (let x = 1; x < size - 1; x += 1) {
                const i = (y * size + x) * 4;
                const left = i - 4;
                const right = i + 4;
                const up = i - stride;
                const down = i + stride;

                const lumLeft = (src[left] + src[left + 1] + src[left + 2]) / 3;
                const lumRight = (src[right] + src[right + 1] + src[right + 2]) / 3;
                const lumUp = (src[up] + src[up + 1] + src[up + 2]) / 3;
                const lumDown = (src[down] + src[down + 1] + src[down + 2]) / 3;
                const edge = Math.min(255, Math.abs(lumLeft - lumRight) + Math.abs(lumUp - lumDown));
                const baseLum = (src[i] + src[i + 1] + src[i + 2]) / 3;
                const mixed = baseLum * 0.42;

                result[i] = Math.min(255, mixed + (glow[0] * (edge / 255)));
                result[i + 1] = Math.min(255, mixed + (glow[1] * (edge / 255)));
                result[i + 2] = Math.min(255, mixed + (glow[2] * (edge / 255)));
                result[i + 3] = 255;
            }
        }

        const output = new ImageData(result, size, size);
        ctx.putImageData(output, 0, 0);

        ctx.globalAlpha = 0.18;
        ctx.fillStyle = `rgb(${glow[0]}, ${glow[1]}, ${glow[2]})`;
        for (let i = 0; i < 6; i += 1) {
            const y = ((i + 1) * size) / 7;
            ctx.fillRect(0, y, size, 2);
        }
        ctx.globalAlpha = 1;
    }

    async function renderRemix(canvas, url, effect, seed) {
        const ctx = canvas.getContext('2d');
        const size = 600;
        canvas.width = size;
        canvas.height = size;
        ctx.clearRect(0, 0, size, size);

        const img = await loadImage(url);
        ctx.save();
        ctx.fillStyle = '#152026';
        ctx.fillRect(0, 0, size, size);

        if (effect.key === 'slice') {
            applySliceEffect(ctx, img, size, seed);
        } else if (effect.key === 'duo') {
            applyDuotoneEffect(ctx, img, size, seed);
        } else if (effect.key === 'weave') {
            applyWeaveEffect(ctx, img, size, seed);
        } else if (effect.key === 'kaleido') {
            applyKaleidoEffect(ctx, img, size, seed);
        } else if (effect.key === 'prism') {
            applyPrismEffect(ctx, img, size, seed);
        } else {
            applyContourEffect(ctx, img, size, seed);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 12;
        ctx.strokeRect(0, 0, size, size);
        ctx.restore();
    }

    function renderTarget(hidden = false) {
        if (!state.targetUrl) {
            targetEl.innerHTML = '<div class="remix-empty">The collection image for this round will appear here.</div>';
            return;
        }
        if (hidden) {
            targetEl.innerHTML = '<div class="remix-empty">Target hidden. Trust your visual memory.</div>';
            return;
        }
        targetEl.innerHTML = `<img src="${state.targetUrl}" alt="Featured image">`;
    }

    async function renderOptions() {
        optionsEl.innerHTML = '';
        const cards = state.options.map((url, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'remix-option';
            button.dataset.url = url;
            const canvas = document.createElement('canvas');
            const label = document.createElement('div');
            label.className = 'remix-option-label';
            label.textContent = `Remix ${index + 1}`;
            button.appendChild(canvas);
            button.appendChild(label);
            button.addEventListener('click', () => handleGuess(url, button));
            optionsEl.appendChild(button);
            return { button, canvas, url, seed: (state.round * 17) + (index * 11) };
        });

        await Promise.all(cards.map((card) => renderRemix(card.canvas, card.url, state.effect, card.seed)));
    }

    async function prepareRound() {
        if (!state.active) return;

        state.round += 1;
        roundEl.textContent = String(state.round);
        stateEl.textContent = 'Showing';
        previewTextEl.textContent = 'Memorize this image before it disappears.';
        setMessage('Building remixes from your collection...', 'info');

        const optionCount = Math.min(parseInt(optionCountSelect.value, 10) || 4, REMIX_IMAGES.length);
        const shuffled = shuffle(REMIX_IMAGES);
        state.targetUrl = shuffled[0];
        state.correctOption = state.targetUrl;
        state.options = shuffle(shuffled.slice(0, optionCount));
        if (!state.options.includes(state.correctOption)) {
            state.options[0] = state.correctOption;
            state.options = shuffle(state.options);
        }
        state.effect = effects[Math.floor(Math.random() * effects.length)];
        effectBadgeEl.innerHTML = `<i class="fas fa-sparkles"></i> Effect: ${state.effect.label}`;
        renderTarget(false);
        await renderOptions();

        clearPreviewTimeout();
        optionsEl.querySelectorAll('.remix-option').forEach((button) => {
            button.style.pointerEvents = 'none';
        });

        const revealMs = parseInt(revealTimeSelect.value, 10) || 2500;
        state.previewTimeout = window.setTimeout(() => {
            renderTarget(true);
            previewTextEl.textContent = 'Now find that image among the remixes.';
            state.canAnswer = true;
            state.answerStartedAt = performance.now();
            stateEl.textContent = 'Playing';
            optionsEl.querySelectorAll('.remix-option').forEach((button) => {
                button.style.pointerEvents = '';
            });
            setMessage('Pick the remixed card that matches the hidden image.', 'info');
        }, revealMs);
    }

    function submitScore() {
        if (!CURRENT_COLLECTION) return;
        const elapsed = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: CURRENT_COLLECTION,
                gameType: 'remix',
                score: state.score,
                time: elapsed,
                round: state.round,
                username: (usernameInput.value || 'Anonymous').trim() || 'Anonymous'
            })
        }).catch((err) => console.warn('Error submitting remix score', err));
    }

    function endGame(message, tone) {
        state.active = false;
        state.canAnswer = false;
        clearPreviewTimeout();
        stopTimer();
        stateEl.textContent = 'Finished';
        renderTarget(false);
        setMessage(message, tone);
        submitScore();
    }

    function handleGuess(url, buttonEl) {
        if (!state.active || !state.canAnswer) return;

        state.canAnswer = false;
        clearPreviewTimeout();
        renderTarget(false);
        const buttons = Array.from(optionsEl.querySelectorAll('.remix-option'));
        const responseSeconds = (performance.now() - state.answerStartedAt) / 1000;

        if (url === state.correctOption) {
            buttonEl.classList.add('correct');
            state.streak += 1;
            const points = Math.max(70, Math.round(120 + (state.streak * 14) + (state.round * 7) - (responseSeconds * 16)));
            state.score += points;
            scoreEl.textContent = String(state.score);
            streakEl.textContent = String(state.streak);
            stateEl.textContent = 'Correct';
            previewTextEl.textContent = 'That remix really was your image.';
            setMessage(`Correct. +${points} points.`, 'success');
            window.setTimeout(() => prepareRound(), 1100);
            return;
        }

        state.streak = 0;
        streakEl.textContent = '0';
        buttonEl.classList.add('incorrect');
        buttons.forEach((button) => {
            if (button.dataset.url === state.correctOption) {
                button.classList.add('correct');
            }
        });
        endGame(`Wrong remix. Final score: ${state.score}`, 'error');
    }

    function resetGame() {
        state.active = false;
        state.canAnswer = false;
        state.score = 0;
        state.round = 0;
        state.streak = 0;
        state.startTime = null;
        state.answerStartedAt = 0;
        state.targetUrl = '';
        state.correctOption = '';
        state.options = [];
        state.effect = null;
        clearPreviewTimeout();
        stopTimer();
        scoreEl.textContent = '0';
        roundEl.textContent = '0';
        streakEl.textContent = '0';
        timeEl.textContent = '0:00';
        stateEl.textContent = 'Waiting';
        previewTextEl.textContent = 'Start a run to get a target image.';
        effectBadgeEl.innerHTML = '<i class="fas fa-sparkles"></i> Effect: Waiting';
        optionsEl.innerHTML = '';
        renderTarget(false);
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
        if (REMIX_IMAGES.length < 4) {
            setMessage('Need at least 4 images in this collection to play Remix Match.', 'error');
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
    backBtn.addEventListener('click', () => {
        window.location.href = `/collection/${CURRENT_COLLECTION}`;
    });
    targetSizeInput.addEventListener('input', (event) => {
        prefs.targetSize = parseInt(event.target.value, 10) || 280;
        applySizing();
        savePrefs();
    });
    optionSizeInput.addEventListener('input', (event) => {
        prefs.optionSize = parseInt(event.target.value, 10) || 200;
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
            console.warn('Remix fullscreen failed', err);
        }
    });
    document.addEventListener('fullscreenchange', syncFullscreenButton);

    applySizing();
    resetGame();
    syncFullscreenButton();
});

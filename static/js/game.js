// game.js - simple memory/concentration game using uploaded images
(function () {
    const board = document.getElementById('gameBoard');
    const movesEl = document.getElementById('moves');
    const matchesEl = document.getElementById('matches');
    const timeEl = document.getElementById('time');
    const restartBtn = document.getElementById('restart');
    const winMessage = document.getElementById('winMessage');
    const finalMoves = document.getElementById('finalMoves');
    const finalTime = document.getElementById('finalTime');
    const wrongEl = document.getElementById('wrong');
    const finalWrong = document.getElementById('finalWrong');
    const playAgain = document.getElementById('playAgain');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const sizeSlider = document.getElementById('sizeSlider');
    const sizeLabel = document.getElementById('sizeLabel');
    const fitToggle = document.getElementById('fitToggle');
    const usernameInput = document.getElementById('usernameInput');
    const completedPairsEl = document.getElementById('completedPairs');
    const totalPairsEl = document.getElementById('totalPairs');
    const USERNAME_KEY = 'imgur.username';

    let deck = [];
    // Track which unique images are used in the current game (one per set)
    let usedUniqueImages = [];
    // Selected cards for current attempt
    let selectedCards = [];
    let lockBoard = false;
    let moves = 0;
    let matches = 0;
    let wrongSteps = 0;
    let timer = null;
    let seconds = 0;
    let currentMatchSize = 2;

    // Lightweight toast helper (available to all functions in this module)
    function showToast(message) {
        const el = document.getElementById('sizeSavedToast');
        if (!el) return;
        const txt = document.getElementById('toastText');
        if (txt) txt.textContent = message;
        el.style.display = 'flex';
        // trigger transition
        requestAnimationFrame(() => el.classList.add('show'));
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => { el.style.display = 'none'; }, 250);
        }, 1500);
    }

    function startTimer() {
        if (timer) return;
        timer = setInterval(() => {
            seconds += 1;
            timeEl.textContent = `${seconds}s`;
        }, 1000);
    }

    function stopTimer() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    function resetStats() {
        moves = 0; matches = 0; seconds = 0;
        movesEl.textContent = '0';
        matchesEl.textContent = '0';
        wrongSteps = 0;
        if (wrongEl) wrongEl.textContent = '0';
        if (completedPairsEl) completedPairsEl.textContent = '0';
        timeEl.textContent = '0s';
        finalMoves.textContent = '';
        finalTime.textContent = '';
        if (finalWrong) finalWrong.textContent = '';
        winMessage.style.display = 'none';
    }

    function shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    function buildDeck(images, options) {
        // If not enough images, show a message
        if (!images || images.length < 1) {
            board.innerHTML = '<p>No images available. Upload some images first.</p>';
            return null;
        }

        // Determine number of unique images to use (N)
        const numUnique = Math.max(1, Math.min(images.length, options.numImages || images.length));

        // Shuffle a copy and pick numUnique unique images
        const copy = images.slice();
        shuffle(copy);
        const uniqueImages = copy.slice(0, numUnique);

        // Determine number of pairs requested
        const pairsRequested = Math.max(1, options.pairsRequested || 1);
        const pairs = Math.min(pairsRequested, uniqueImages.length);

    const pairImages = uniqueImages.slice(0, pairs);
    usedUniqueImages = pairImages.slice();

        // Create deck (N copies per set based on match size)
        const full = [];
        const groupSize = Math.max(2, parseInt(options.matchSize, 10) || currentMatchSize);
        pairImages.forEach(img => {
            for (let i = 0; i < groupSize; i++) full.push(img);
        });

        // Shuffle deck
        shuffle(full);
        return full;
    }

    function renderBoard(images) {
        board.innerHTML = '';
        const frag = document.createDocumentFragment();
        images.forEach((imgSrc, idx) => {
            const card = document.createElement('div');
            card.className = 'card';
            card.dataset.image = imgSrc;

            const inner = document.createElement('div');
            inner.className = 'card-inner';

            const back = document.createElement('div');
            back.className = 'card-face card-back';
            back.innerHTML = '<i class="fas fa-question" style="font-size:28px;color:#fff;"></i>';

            const front = document.createElement('div');
            front.className = 'card-face card-front';
            const imgel = document.createElement('img');
            imgel.src = imgSrc;
            imgel.alt = 'card image';
            front.appendChild(imgel);

            inner.appendChild(back);
            inner.appendChild(front);
            card.appendChild(inner);

            // click handler
            card.addEventListener('click', onCardClick);

            frag.appendChild(card);
        });
        board.appendChild(frag);
    }

    function renderGridNumbers() {
        // Get computed grid columns to determine layout
        const style = window.getComputedStyle(board);
        const gridCols = style.getPropertyValue('grid-template-columns');
        const colCount = gridCols.split(' ').filter(x => x.trim()).length;
        const cardCount = deck.length;
        const rowCount = Math.ceil(cardCount / colCount);

        // Render column numbers
        const colNumbersEl = document.getElementById('columnNumbers');
        if (colNumbersEl) {
            colNumbersEl.innerHTML = '';
            colNumbersEl.style.gridTemplateColumns = board.style.gridTemplateColumns || gridCols;
            for (let i = 1; i <= colCount; i++) {
                const span = document.createElement('span');
                span.textContent = i;
                colNumbersEl.appendChild(span);
            }
        }

        // Render row numbers
        const rowNumbersEl = document.getElementById('rowNumbers');
        if (rowNumbersEl) {
            rowNumbersEl.innerHTML = '';
            for (let i = 1; i <= rowCount; i++) {
                const span = document.createElement('span');
                span.textContent = i;
                rowNumbersEl.appendChild(span);
            }
        }
    }

    function onCardClick(e) {
        const card = e.currentTarget;
        if (lockBoard) return;
        if (card.classList.contains('matched')) return;
        if (selectedCards.includes(card)) return;
        // start timer on first flip
        startTimer();
        card.classList.add('flipped');
        selectedCards.push(card);
        // Wait until we have enough selected to evaluate
        if (selectedCards.length < currentMatchSize) return;
        // We have a full selection attempt
        moves += 1;
        movesEl.textContent = moves;
        const target = selectedCards[0].dataset.image;
        const isMatch = selectedCards.every(c => c.dataset.image === target);
        if (isMatch) {
            // lock matched cards with staggered pop animation
            lockBoard = true;
            selectedCards.forEach((c, idx) => {
                setTimeout(() => {
                    c.removeEventListener('click', onCardClick);
                    c.classList.add('matched');
                    c.classList.add('matched-pop');
                    setTimeout(() => c.classList.remove('matched-pop'), 400);
                }, idx * 100);
            });
            setTimeout(() => {
                selectedCards = [];
                lockBoard = false;
                matches += 1;
                matchesEl.textContent = matches;
                if (completedPairsEl) completedPairsEl.textContent = matches;
                const totalGroups = Math.floor(deck.length / currentMatchSize);
                if (matches === totalGroups) handleWin();
            }, selectedCards.length * 100 + 100);
        } else {
            wrongSteps += 1;
            if (wrongEl) wrongEl.textContent = wrongSteps;
            lockBoard = true;
            setTimeout(() => {
                selectedCards.forEach(c => c.classList.remove('flipped'));
                selectedCards = [];
                lockBoard = false;
            }, 800);
        }
    }

    function handleWin() {
        stopTimer();
        finalMoves.textContent = moves;
        finalTime.textContent = `${seconds}s`;
        if (finalWrong) finalWrong.textContent = wrongSteps;
        winMessage.style.display = 'block';

        // Submit score to server for leaderboard, then show overlay
        (async () => {
            let isNewBest = false;
            let computedScore = 0;
            try {
                const username = (usernameInput && usernameInput.value.trim()) || 'Anonymous';
                // Get current game settings for score computation
                const opts = getOptionsFromUI();
                const payload = {
                    collection: (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : '',
                    gameType: 'memory',
                    time: seconds,
                    wrong: wrongSteps,
                    moves: moves,
                    pairs: opts.pairsRequested,
                    matchSize: opts.matchSize,
                    username: username
                };
                if (payload.collection) {
                    const scoreRes = await fetch('/api/submit-score', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    const scoreData = await scoreRes.json();
                    if (scoreData) {
                        computedScore = scoreData.score || 0;
                        if (scoreData.updated) {
                            isNewBest = true;
                        }
                    }
                }
            } catch (err) { console.warn('Error submitting score', err); }

            // Show victory overlay with best score banner if achieved
            showVictoryOverlay(null, isNewBest, computedScore);

            // Fetch random image from a different collection
            try {
                const exclude = (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : '';
                const res = await fetch('/api/collections');
                const data = await res.json();
                if (data && data.collections) {
                    const keys = Object.keys(data.collections).filter(k => k !== exclude && Array.isArray(data.collections[k]) && data.collections[k].length);
                    if (keys.length) {
                        const chosenKey = keys[Math.floor(Math.random() * keys.length)];
                        const arr = data.collections[chosenKey];
                        const imgUrl = arr[Math.floor(Math.random() * arr.length)];
                        const img = document.getElementById('victoryImage');
                        if (img && imgUrl) { img.src = imgUrl; img.style.display = 'block'; }
                    }
                }
            } catch (e) { console.warn('Failed to load other-collection image', e); }
        })();
    }

    function showVictoryOverlay(imageUrl, isNewBest, score) {
        const overlay = document.getElementById('victoryOverlay');
        const img = document.getElementById('victoryImage');
        const closeBtn = document.getElementById('victoryClose');
        const againBtn = document.getElementById('victoryPlayAgain');
        const bestBanner = document.getElementById('bestScoreBanner');
        if (!overlay) return;

        // Show/hide best score banner with score
        if (bestBanner) {
            if (isNewBest && score !== undefined) {
                bestBanner.innerHTML = `<i class="fas fa-trophy"></i> Top 5 Score: ${score}`;
                bestBanner.style.display = 'flex';
            } else if (score !== undefined) {
                // Show score even if not top 5
                bestBanner.innerHTML = `<i class="fas fa-star"></i> Your Score: ${score}`;
                bestBanner.style.display = 'flex';
                bestBanner.style.background = 'linear-gradient(135deg, #a29bfe, #74b9ff)';
            } else {
                bestBanner.style.display = 'none';
            }
        }

        if (img) {
            if (imageUrl) {
                img.src = imageUrl;
                img.style.display = 'block';
            } else {
                img.removeAttribute('src');
                img.style.display = 'none';
            }
        }

        // Create some confetti pieces
        try {
            const colors = ['#ff6b81', '#a29bfe', '#55efc4', '#ffeaa7', '#fd79a8', '#74b9ff'];
            const count = 80;
            for (let i = 0; i < count; i++) {
                const span = document.createElement('span');
                span.className = 'confetti-piece';
                const left = Math.random() * 100; // vw
                const dur = 1.8 + Math.random() * 2.0;
                const delay = Math.random() * 0.8;
                const rot = Math.floor(Math.random() * 360);
                span.style.left = left + 'vw';
                span.style.background = colors[i % colors.length];
                span.style.transform = `translateY(-20px) rotateZ(${rot}deg)`;
                span.style.animationDuration = dur + 's';
                span.style.animationDelay = delay + 's';
                overlay.appendChild(span);
                // Cleanup when animation ends
                span.addEventListener('animationend', () => span.remove());
            }
        } catch (e) {}

        overlay.classList.add('show');
        overlay.setAttribute('aria-hidden', 'false');

        const hide = () => {
            overlay.classList.remove('show');
            overlay.setAttribute('aria-hidden', 'true');
        };
        closeBtn && (closeBtn.onclick = hide);
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) hide(); }, { once: true });
        againBtn && (againBtn.onclick = () => { hide(); setup(SERVER_IMAGES); });
    }

    // Read options from UI controls
    function getOptionsFromUI() {
        const diff = document.getElementById('difficulty');
        const customWrap = document.getElementById('customPairs');
        const numImagesInput = document.getElementById('numImages');
    const cardsPerRowSelect = document.getElementById('cardsPerRow');
    const useCustomCpr = document.getElementById('cardsPerRowUseCustom');
    const customCprInput = document.getElementById('cardsPerRowCustom');
        const matchSizeInput = document.getElementById('matchSize');
        let pairsRequested = 8;
        if (diff) {
            if (diff.value === 'custom' && customWrap) pairsRequested = parseInt(customWrap.value, 10) || 4;
            else pairsRequested = parseInt(diff.value, 10) || 8;
        }
        const numImages = numImagesInput ? (parseInt(numImagesInput.value, 10) || SERVER_IMAGES.length) : SERVER_IMAGES.length;
        let cardsPerRow = cardsPerRowSelect ? cardsPerRowSelect.value : 'auto';
        // If custom CPR is enabled and valid, prefer it
        if (useCustomCpr && customCprInput && useCustomCpr.checked) {
            const v = parseInt(customCprInput.value, 10);
            if (!Number.isNaN(v) && v >= 2) cardsPerRow = String(v);
        }
        const matchSize = Math.max(2, parseInt(matchSizeInput && matchSizeInput.value, 10) || 2);
        return { pairsRequested, numImages, cardsPerRow, matchSize };
    }

    function validateConfiguration(options) {
        const warning = document.getElementById('validationWarning');
        const warningText = document.getElementById('validationText');
        if (!warning || !warningText) return true;

        // We only need as many UNIQUE images as groups requested; matchSize doesn't change unique count.
        if (options.pairsRequested > options.numImages) {
            warningText.textContent = `Using ${options.numImages} unique images instead of ${options.pairsRequested} (increase \"Use up to N unique images\" or lower difficulty).`;
            warning.style.display = 'block';
            // Do NOT block; buildDeck will clamp pairs to available unique images
            return true;
        }
        warning.style.display = 'none';
        return true;
    }

    function setup(images, options) {
        resetStats();
        stopTimer();
        options = options || getOptionsFromUI();
        
        // Validate configuration (warn but don't block; buildDeck will clamp safely)
        validateConfiguration(options);
        
        currentMatchSize = Math.max(2, parseInt(options.matchSize, 10) || 2);
        selectedCards = [];
        deck = buildDeck(images, options);
        if (!deck || deck.length === 0) {
            // Fallback: try rebuilding from SERVER_IMAGES with clamped options
            try {
                console.warn('Deck was empty; attempting fallback build with SERVER_IMAGES');
                const fb = Array.isArray(SERVER_IMAGES) ? SERVER_IMAGES.slice() : [];
                if (fb.length) {
                    const fbOpts = Object.assign({}, options, {
                        numImages: Math.min(options.numImages || fb.length, fb.length),
                        pairsRequested: Math.min(options.pairsRequested || 1, fb.length)
                    });
                    deck = buildDeck(fb, fbOpts);
                }
            } catch (e) { console.warn('Fallback deck build failed', e); }
        }
        if (!deck || deck.length === 0) {
            board.innerHTML = '<p style="text-align:center;color:var(--muted-text);padding:40px;">No playable deck could be created. Try lowering difficulty or increasing available images.</p>';
            return;
        }

        // Determine columns and width behavior
        const count = deck.length;
        let columns;
        let desiredWidth = null;
        // Read desired width from storage (per collection)
        try {
            const collectionName = (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : 'Real';
            const storageWidthKey = `imgur.width.${collectionName}`;
            const persistedWidth = parseInt(localStorage.getItem(storageWidthKey), 10);
            if (!Number.isNaN(persistedWidth) && persistedWidth > 0) desiredWidth = persistedWidth;
        } catch (e) {}

        // Compute board metrics upfront
        let gap = 14, boardWidth = board.clientWidth;
        try {
            const style = window.getComputedStyle(board);
            const gapStr = style.getPropertyValue('gap') || style.getPropertyValue('grid-gap') || '14px';
            gap = parseInt(gapStr, 10) || 14;
            boardWidth = Math.max(0, board.clientWidth - (parseInt(style.getPropertyValue('padding-left') || '0', 10) + parseInt(style.getPropertyValue('padding-right') || '0', 10)));
        } catch (e) {}

        // Decide columns
        if (options && options.cardsPerRow && options.cardsPerRow !== 'auto') {
            const parsed = parseInt(options.cardsPerRow, 10);
            columns = Math.max(2, Math.min(parsed || 3, deck.length));
        } else {
            if (desiredWidth && boardWidth > 0) {
                // Use width preference to compute columns
                const possible = Math.max(1, Math.floor((boardWidth + gap) / ((desiredWidth) + gap)));
                columns = Math.max(2, Math.min(10, possible));
            } else {
                // Fallback heuristic
                columns = Math.max(2, Math.min(5, Math.ceil(Math.sqrt(count))));
            }
        }

        // Calculate minWidth per column and apply template
        try {
            const totalGap = gap * Math.max(0, columns - 1);
            let minWidth = Math.max(100, Math.floor((boardWidth - totalGap) / columns));
            if (desiredWidth) {
                // Keep minWidth close to desired while avoiding overflow
                minWidth = Math.max(100, Math.min(minWidth, desiredWidth));
            }
            board.style.gridTemplateColumns = `repeat(${columns}, minmax(${minWidth}px, 1fr))`;
        } catch (err) {
            board.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
        }

        // Adjust card height visually (larger when fewer columns). Keep previous heuristic but allow card height
        // to be at most the computed minWidth so cards are roughly square when there's ample horizontal space.
        const heuristicHeight = Math.max(120, Math.min(320, Math.floor(720 / columns)));
        let cardHeight = heuristicHeight;
        
        // Check if we have a persisted size to use instead of auto-calculating
        try {
            const collectionName = (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : 'Real';
            const storageSizeKey = `imgur.size.${collectionName}`;
            const persistedSize = parseInt(localStorage.getItem(storageSizeKey), 10);
            if (!Number.isNaN(persistedSize) && persistedSize > 0) {
                cardHeight = persistedSize;
            } else {
                // No persisted size, save the auto-calculated one
                localStorage.setItem(storageSizeKey, String(cardHeight));
            }
        } catch (err) { /* ignore storage errors */ }
        
        board.style.setProperty('--card-height', `${cardHeight}px`);

        // Sync sliders with current sizes
        if (sizeSlider) {
            sizeSlider.value = cardHeight;
            if (sizeLabel) sizeLabel.textContent = `${cardHeight}px`;
        }
        // Determine a final width to show in UI (fallback to computed column width)
        try {
            const collectionName = (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : 'Real';
            const storageWidthKey = `imgur.width.${collectionName}`;
            const persistedWidth = parseInt(localStorage.getItem(storageWidthKey), 10);
            // Estimate current column width for label if none persisted
            let currentColWidth = null;
            try {
                const style = window.getComputedStyle(board);
                const cols = style.getPropertyValue('grid-template-columns');
                const first = cols.split(' ').find(x => x.includes('px'));
                if (first) currentColWidth = parseInt(first, 10);
            } catch (e) {}
            const widthForUI = (!Number.isNaN(persistedWidth) && persistedWidth > 0) ? persistedWidth : (currentColWidth || 200);
            const widthSliderEl = document.getElementById('widthSlider');
            const widthLabelEl = document.getElementById('widthLabel');
            if (widthSliderEl) widthSliderEl.value = widthForUI;
            if (widthLabelEl) widthLabelEl.textContent = `${widthForUI}px`;
            // Persist for next time so auto will respect it
            localStorage.setItem(storageWidthKey, String(widthForUI));
        } catch (e) {}
        // Persist the final cardHeight so it's reliably restored next time
        try {
            const collectionName = (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : 'Real';
            const storageSizeKey = `imgur.size.${collectionName}`;
            localStorage.setItem(storageSizeKey, String(cardHeight));
        } catch (err) { /* ignore storage errors */ }
    // Show a small toast confirming saved size
    showToast('Card size saved');
        // Note: fit mode and slider persistence are handled during DOMContentLoaded

        renderBoard(deck);
        
        // Update total pairs counter
        const totalGroups = Math.floor(deck.length / currentMatchSize);
        if (totalPairsEl) totalPairsEl.textContent = totalGroups;
        
        // Render row/column numbers for memorization
        setTimeout(() => renderGridNumbers(), 50); // Small delay to ensure grid is rendered
    }

    // Restart and play again
    restartBtn.addEventListener('click', () => setup(SERVER_IMAGES));
    playAgain && playAgain.addEventListener('click', () => setup(SERVER_IMAGES));

    // UI wiring for difficulty / custom pairs / numImages
    document.addEventListener('DOMContentLoaded', () => {
        // Load and persist username
        if (usernameInput) {
            try {
                const saved = localStorage.getItem(USERNAME_KEY);
                if (saved) usernameInput.value = saved;
                usernameInput.addEventListener('input', () => {
                    try { localStorage.setItem(USERNAME_KEY, usernameInput.value.trim()); } catch (e) {}
                });
            } catch (e) {}
        }

        const diff = document.getElementById('difficulty');
        const customWrap = document.getElementById('customPairsWrap');
        const customPairs = document.getElementById('customPairs');
        const numImagesInput = document.getElementById('numImages');

        // set numImages max to available images
        if (numImagesInput) {
            numImagesInput.max = SERVER_IMAGES.length || 1;
            if (!numImagesInput.value) numImagesInput.value = SERVER_IMAGES.length || 1;
            numImagesInput.addEventListener('change', () => setup(SERVER_IMAGES));
        }

        if (diff) {
            diff.addEventListener('change', () => {
                if (diff.value === 'custom') {
                    customWrap && (customWrap.style.display = 'inline-flex');
                } else {
                    customWrap && (customWrap.style.display = 'none');
                }
                setup(SERVER_IMAGES);
            });
        }
        if (customPairs) customPairs.addEventListener('change', () => setup(SERVER_IMAGES));

        // Cards per row selector (auto, 3,4,5)
        const cardsPerRowSelect = document.getElementById('cardsPerRow');
        const useCustomCpr = document.getElementById('cardsPerRowUseCustom');
        const customCprInput = document.getElementById('cardsPerRowCustom');
        if (cardsPerRowSelect) {
            // Load persisted value
            try {
                const collectionName = (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : 'Real';
                const storageCardsPerRowKey = `imgur.cardsPerRow.${collectionName}`;
                const saved = localStorage.getItem(storageCardsPerRowKey);
                if (saved) cardsPerRowSelect.value = saved;
                cardsPerRowSelect.addEventListener('change', () => {
                    try { localStorage.setItem(storageCardsPerRowKey, cardsPerRowSelect.value); } catch (e) {}
                    setup(activeImages);
                });
            } catch (e) {
                cardsPerRowSelect.addEventListener('change', () => setup(activeImages));
            }
        }
        // Custom cards-per-row persistence
        if (useCustomCpr && customCprInput) {
            try {
                const collectionName = (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : 'Real';
                const storageCprCustomUseKey = `imgur.cardsPerRow.custom.use.${collectionName}`;
                const storageCprCustomValKey = `imgur.cardsPerRow.custom.val.${collectionName}`;
                const savedUse = localStorage.getItem(storageCprCustomUseKey);
                const savedVal = localStorage.getItem(storageCprCustomValKey);
                if (savedUse === '1') useCustomCpr.checked = true;
                if (savedVal) customCprInput.value = savedVal;
                const trigger = () => {
                    try {
                        localStorage.setItem(storageCprCustomUseKey, useCustomCpr.checked ? '1' : '0');
                        const v = parseInt(customCprInput.value, 10);
                        if (!Number.isNaN(v) && v >= 2) localStorage.setItem(storageCprCustomValKey, String(v));
                    } catch (e) {}
                    setup(activeImages);
                };
                useCustomCpr.addEventListener('change', trigger);
                customCprInput.addEventListener('change', trigger);
            } catch (e) {
                // Minimal wiring if storage fails
                const trigger = () => setup(activeImages);
                useCustomCpr.addEventListener('change', trigger);
                customCprInput.addEventListener('change', trigger);
            }
        }

        // Match size control (cards per set)
        const matchSizeInput = document.getElementById('matchSize');
        if (matchSizeInput) {
            try {
                const collectionName = (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : 'Real';
                const storageMatchSizeKey = `imgur.matchSize.${collectionName}`;
                const savedMS = localStorage.getItem(storageMatchSizeKey);
                if (savedMS) matchSizeInput.value = savedMS;
                matchSizeInput.addEventListener('change', () => {
                    const v = Math.max(2, parseInt(matchSizeInput.value, 10) || 2);
                    matchSizeInput.value = String(v);
                    try { localStorage.setItem(storageMatchSizeKey, String(v)); } catch (e) {}
                    setup(activeImages);
                });
            } catch (e) {
                matchSizeInput.addEventListener('change', () => setup(activeImages));
            }
        }

        // initial visibility for custom
        if (diff && diff.value === 'custom') customWrap && (customWrap.style.display = 'inline-flex');

        // Prepare per-collection persistence keys
        const collectionName = (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : 'Real';
        const storageSizeKey = `imgur.size.${collectionName}`;
        const storageFitKey = `imgur.fit.${collectionName}`;

        // Apply persisted size if present
        try {
            const persistedSize = parseInt(localStorage.getItem(storageSizeKey), 10);
            if (!Number.isNaN(persistedSize) && persistedSize > 0) {
                board.style.setProperty('--card-height', `${persistedSize}px`);
                if (sizeSlider) {
                    sizeSlider.value = persistedSize;
                    if (sizeLabel) sizeLabel.textContent = `${persistedSize}px`;
                }
            }
        } catch (err) { console.warn('Error reading persisted size', err); }

        // Apply persisted fit mode if present
        try {
            const persistedFit = localStorage.getItem(storageFitKey);
            if (persistedFit === 'contain') {
                board.classList.add('fit-contain');
                board.classList.remove('fit-cover');
                if (fitToggle) {
                    fitToggle.textContent = 'Fit: Off';
                    fitToggle.style.background = '#b2bec3';
                    fitToggle.style.color = '#000';
                }
            } else {
                // default to cover
                board.classList.add('fit-cover');
                board.classList.remove('fit-contain');
                if (fitToggle) {
                    fitToggle.textContent = 'Fit: On';
                    fitToggle.style.background = '#fdcb6e';
                    fitToggle.style.color = '#000';
                }
            }
        } catch (err) { console.warn('Error reading persisted fit', err); }

        // Keep a mutable reference to the currently active image pool
        let activeImages = Array.isArray(SERVER_IMAGES) ? SERVER_IMAGES.slice() : [];

        const mixCheckbox = document.getElementById('mixCollections');

        // If we're playing a specific collection (Real/AI), disallow mixing and
        // ensure we only use that collection's images (shuffled).
        if (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) {
            if (mixCheckbox) {
                mixCheckbox.checked = false;
                mixCheckbox.disabled = true;
                mixCheckbox.title = 'Mixing disabled when playing a specific collection';
                // Also update adjacent label text if present (best-effort)
                try {
                    const lab = mixCheckbox.parentElement;
                    if (lab && lab.tagName === 'LABEL') {
                        // keep the label but soften it
                        lab.style.opacity = '0.7';
                    }
                } catch (e) {}
            }
            // Use only SERVER_IMAGES for this collection and shuffle them
            activeImages = Array.isArray(SERVER_IMAGES) ? SERVER_IMAGES.slice() : [];
            shuffle(activeImages);
        }

        // Fetch collections and pick one at random, returning that collection's images (shuffled)
        async function loadMixedImages() {
            try {
                const res = await fetch('/api/collections');
                const data = await res.json();
                if (data && data.collections) {
                    const keys = Object.keys(data.collections).filter(k => Array.isArray(data.collections[k]) && data.collections[k].length);
                    if (!keys.length) return [];
                    // pick a random collection key
                    const chosen = keys[Math.floor(Math.random() * keys.length)];
                    const imgs = data.collections[chosen].slice();
                    shuffle(imgs);
                    return imgs;
                }
            } catch (err) { console.warn('Failed to fetch collection images', err); }
            return [];
        }

        // When mix checkbox toggles, fetch pool if enabled and re-run setup
        if (mixCheckbox) {
            mixCheckbox.addEventListener('change', async () => {
                if (mixCheckbox.checked) {
                    const pooled = await loadMixedImages();
                    if (pooled.length) activeImages = pooled;
                } else {
                    // revert to server-injected images for current collection
                    activeImages = Array.isArray(SERVER_IMAGES) ? SERVER_IMAGES.slice() : [];
                    shuffle(activeImages);
                }
                // update numImages max and value
                const numImagesInput = document.getElementById('numImages');
                if (numImagesInput) {
                    numImagesInput.max = activeImages.length || 1;
                    if (parseInt(numImagesInput.value, 10) > activeImages.length) numImagesInput.value = activeImages.length || 1;
                }
                setup(activeImages);
            });
        }

        // initial active images (respecting mix checkbox initial state)
        (async () => {
            if (mixCheckbox && mixCheckbox.checked) {
                const pooled = await loadMixedImages();
                if (pooled.length) activeImages = pooled;
            }
            // ensure numImages input max reflects activeImages
            const numImagesInput = document.getElementById('numImages');
            if (numImagesInput) {
                numImagesInput.max = activeImages.length || 1;
                if (!numImagesInput.value) numImagesInput.value = activeImages.length || 1;
                numImagesInput.addEventListener('change', () => setup(activeImages));
            }
            setup(activeImages);
        })();
        
        // Fullscreen toggle: show only cards and time while in fullscreen
        if (fullscreenBtn) {
            fullscreenBtn.addEventListener('click', () => {
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(err => console.warn('Fullscreen request failed', err));
                } else {
                    document.exitFullscreen().catch(err => console.warn('Exit fullscreen failed', err));
                }
            });
        }

        // Height slider live control
        if (sizeSlider) {
            sizeSlider.addEventListener('input', (e) => {
                const v = parseInt(e.target.value, 10) || 200;
                board.style.setProperty('--card-height', `${v}px`);
                if (sizeLabel) sizeLabel.textContent = `${v}px`;
                try { localStorage.setItem(storageSizeKey, String(v)); showToast('Card size saved'); } catch (err) { console.warn('Error saving size to localStorage', err); }
            });
        }

        // Width slider live control (affects columns in auto mode)
        const widthSlider = document.getElementById('widthSlider');
        const widthLabel = document.getElementById('widthLabel');
        if (widthSlider) {
            widthSlider.addEventListener('input', (e) => {
                const v = parseInt(e.target.value, 10) || 200;
                if (widthLabel) widthLabel.textContent = `${v}px`;
                try {
                    const collectionName = (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : 'Real';
                    localStorage.setItem(`imgur.width.${collectionName}`, String(v));
                    showToast('Card width saved');
                } catch (err) { console.warn('Error saving width to localStorage', err); }
                // Re-layout grid in auto mode without resetting the game
                try {
                    const opts = getOptionsFromUI();
                    if (!opts || !deck || !deck.length) return;
                    // Only impacts layout when auto columns are used
                    if (opts.cardsPerRow === 'auto') {
                        let gap = 14, boardWidth = board.clientWidth;
                        const style = window.getComputedStyle(board);
                        const gapStr = style.getPropertyValue('gap') || style.getPropertyValue('grid-gap') || '14px';
                        gap = parseInt(gapStr, 10) || 14;
                        boardWidth = Math.max(0, board.clientWidth - (parseInt(style.getPropertyValue('padding-left') || '0', 10) + parseInt(style.getPropertyValue('padding-right') || '0', 10)));
                        const possible = Math.max(1, Math.floor((boardWidth + gap) / (v + gap)));
                        const columns = Math.max(2, Math.min(10, possible));
                        const totalGap = gap * Math.max(0, columns - 1);
                        const minWidth = Math.max(100, Math.min(v, Math.floor((boardWidth - totalGap) / columns)));
                        board.style.gridTemplateColumns = `repeat(${columns}, minmax(${minWidth}px, 1fr))`;
                    }
                } catch (e2) { /* non-fatal */ }
            });
        }

        // showToast is defined at module scope

        // Fit toggle control
        if (fitToggle) {
            fitToggle.addEventListener('click', () => {
                const isOn = board.classList.toggle('fit-contain');
                if (isOn) {
                    // fit-contain means show whole image (contain)
                    board.classList.remove('fit-cover');
                    fitToggle.textContent = 'Fit: Off';
                    fitToggle.style.background = '#b2bec3';
                    fitToggle.style.color = '#000';
                    try { localStorage.setItem(storageFitKey, 'contain'); } catch (err) { console.warn('Error saving fit to localStorage', err); }
                } else {
                    board.classList.add('fit-cover');
                    fitToggle.textContent = 'Fit: On';
                    fitToggle.style.background = '#fdcb6e';
                    fitToggle.style.color = '#000';
                    try { localStorage.setItem(storageFitKey, 'cover'); } catch (err) { console.warn('Error saving fit to localStorage', err); }
                }
            });
        }

        document.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) {
                document.body.classList.add('game-fullscreen');
            } else {
                document.body.classList.remove('game-fullscreen');
            }
        });
    });
})();

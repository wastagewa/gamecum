document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const nextBtn = document.getElementById('nextBtn');
    const backBtn = document.getElementById('backBtn');
    const gridEl = document.getElementById('grid');
    const targetImg = document.getElementById('targetImg');
    const scoreEl = document.getElementById('score');
    const roundEl = document.getElementById('round');
    const timeEl = document.getElementById('time');
    const gridSizeSelect = document.getElementById('gridSize');
    const message = document.getElementById('message');
    const victoryOverlay = document.getElementById('victoryOverlay');
    const victoryImage = document.getElementById('victoryImage');
    const countdown = document.getElementById('countdown');

    let state = {
        running: false,
        score: 0,
        round: 0,
        startAt: 0,
        currentTarget: null,
        options: []
    };
    // UI controls
    const cellSizeInput = document.getElementById('cellSize');
    const cellSizeLabel = document.getElementById('cellSizeLabel');
    const targetSizeInput = document.getElementById('targetSize');
    const targetSizeLabel = document.getElementById('targetSizeLabel');
    const fitToggle = document.getElementById('fitToggle');

    // Default preferences
    let prefs = {
        cellSize: parseInt(cellSizeInput ? cellSizeInput.value : 140, 10),
        targetSize: parseInt(targetSizeInput ? targetSizeInput.value : 320, 10),
        fitCover: true
    };

    // Load saved prefs if available
    try {
        const s = localStorage.getItem('hunt.prefs');
        if (s) {
            const parsed = JSON.parse(s);
            Object.assign(prefs, parsed);
        }
    } catch (e) {}

    // Initialize controls from prefs
    if (cellSizeInput) { cellSizeInput.value = prefs.cellSize; cellSizeLabel.textContent = prefs.cellSize + 'px'; }
    if (targetSizeInput) { targetSizeInput.value = prefs.targetSize; targetSizeLabel.textContent = prefs.targetSize + 'px'; }
    if (fitToggle) { fitToggle.textContent = prefs.fitCover ? 'Fit: On' : 'Fit: Off'; }

    function savePrefs() {
        try { localStorage.setItem('hunt.prefs', JSON.stringify(prefs)); } catch (e) {}
    }

    function shuffle(arr){
        const a = arr.slice();
        for(let i=a.length-1;i>0;i--){
            const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];
        }
        return a;
    }

    function buildGrid(size){
        gridEl.innerHTML = '';
        gridEl.style.gridTemplateColumns = `repeat(${Math.ceil(Math.sqrt(size))}, 1fr)`;
        // apply cell size CSS variable for consistent sizing
        gridEl.style.setProperty('--hunt-cell-size', prefs.cellSize + 'px');
    }

    function startRound(){
        const size = parseInt(gridSizeSelect.value,10) || 9;
        if (!HUNT_IMAGES || HUNT_IMAGES.length === 0){
            message.textContent = 'No images in this collection.';
            return;
        }
        state.round++;
        roundEl.textContent = state.round;
        buildGrid(size);

        // pick target and options
        const shuffled = shuffle(HUNT_IMAGES);
        const options = shuffled.slice(0, Math.min(size, HUNT_IMAGES.length));
        state.options = shuffle(options);
        state.currentTarget = options[0];
        targetImg.src = state.currentTarget;

        // render options
        state.options.forEach((img)=>{
            const btn = document.createElement('div');
            btn.className = 'hunt-cell';
            const image = document.createElement('img');
            image.src = img;
            image.alt = 'option';
            // apply fit mode and ensure sizing
            image.style.objectFit = prefs.fitCover ? 'cover' : 'contain';
            image.style.width = '100%';
            image.style.height = '100%';
            // enforce cell height/width explicitly so updates apply immediately
            btn.style.height = prefs.cellSize + 'px';
            btn.style.width = prefs.cellSize + 'px';
            btn.appendChild(image);
            btn.addEventListener('click', ()=>handleClick(img, btn));
            gridEl.appendChild(btn);
        });

        state.startAt = performance.now();
        state.running = true;
        nextBtn.disabled = true;
        message.textContent = '';
    }

    function handleClick(src, cell){
        if (!state.running) return;
        const elapsed = (performance.now() - state.startAt)/1000;
        timeEl.textContent = elapsed.toFixed(3);
        if (src === state.currentTarget){
            state.score += Math.max(10, Math.round(100 - elapsed*10));
            scoreEl.textContent = state.score;
            cell.classList.add('correct');
            message.textContent = 'Correct!';
            state.running = false;
            nextBtn.disabled = false;
            
            // Submit score every 5 rounds
            if (state.round % 5 === 0 && state.round > 0) {
                submitHuntScore();
            }
            
            // Show victory overlay with random image from collection
            showVictory();
        } else {
            cell.classList.add('incorrect');
            message.textContent = 'Wrong — try next round.';
            state.running = false;
            nextBtn.disabled = false;
            
            // Submit score on game over
            submitHuntScore();
        }
    }

    function submitHuntScore(){
        try {
            const username = (typeof usernameInput !== 'undefined' && usernameInput && usernameInput.value.trim()) || 'Anonymous';
            const payload = {
                collection: (typeof CURRENT_COLLECTION !== 'undefined' && CURRENT_COLLECTION) ? CURRENT_COLLECTION : '',
                gameType: 'hunt',
                score: state.score,
                time: Math.floor((performance.now() - state.startAt) / 1000),
                username: username
            };
            if (payload.collection) {
                fetch('/api/submit-score', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(err => console.warn('Error submitting score', err));
            }
        } catch (err) {
            console.warn('Error submitting score', err);
        }
    }

    function showVictory(){
        if (!victoryOverlay || HUNT_IMAGES.length === 0) return;
        
        // Pick a random image (could be the target or another)
        const randomImg = HUNT_IMAGES[Math.floor(Math.random() * HUNT_IMAGES.length)];
        victoryImage.src = randomImg;
        victoryOverlay.style.display = 'flex';
        
        let countdownVal = 3;
        countdown.textContent = countdownVal;
        
        const countdownInterval = setInterval(() => {
            countdownVal--;
            if (countdownVal > 0) {
                countdown.textContent = countdownVal;
            } else {
                clearInterval(countdownInterval);
                victoryOverlay.style.display = 'none';
                startNextRound(); // Auto-advance to next round
            }
        }, 1000);
    }

    function startNextRound(){
        startRound();
    }

    if (startBtn) startBtn.addEventListener('click', ()=>{
        state.score = 0; scoreEl.textContent = 0; state.round=0; roundEl.textContent=0; startRound();
        // Request fullscreen
        const elem = document.documentElement;
        if (elem.requestFullscreen) elem.requestFullscreen();
        else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
        else if (elem.msRequestFullscreen) elem.msRequestFullscreen();
    });
    if (nextBtn) nextBtn.addEventListener('click', ()=>startRound());
    if (backBtn) backBtn.addEventListener('click', ()=>{ window.location.href = `/collection/${CURRENT_COLLECTION}`; });

    // keyboard quick select: numbers 1..9 map to cells
    document.addEventListener('keydown', (e)=>{
        if (!state.running) return;
        const key = e.key;
        const ix = parseInt(key,10);
        if (!isNaN(ix) && ix>=1){
            const cells = Array.from(gridEl.querySelectorAll('.hunt-cell'));
            const idx = ix-1;
            if (cells[idx]){
                cells[idx].click();
            }
        }
    });

    // Control listeners
    if (cellSizeInput) {
        cellSizeInput.addEventListener('input', (e)=>{
            const v = parseInt(e.target.value,10);
            prefs.cellSize = v;
            cellSizeLabel.textContent = v + 'px';
            gridEl.style.setProperty('--hunt-cell-size', v + 'px');
            // update existing cells' inline height
            gridEl.querySelectorAll('.hunt-cell').forEach(c => { c.style.height = v + 'px'; c.style.width = v + 'px'; });
            savePrefs();
        });
    }
    if (targetSizeInput) {
        targetSizeInput.addEventListener('input', (e)=>{
            const v = parseInt(e.target.value,10);
            prefs.targetSize = v;
            targetSizeLabel.textContent = v + 'px';
            if (targetImg) {
                targetImg.style.width = v + 'px';
                targetImg.style.height = Math.round(v * 0.625) + 'px';
            }
            savePrefs();
        });
    }
    if (fitToggle) {
        fitToggle.addEventListener('click', ()=>{
            prefs.fitCover = !prefs.fitCover;
            fitToggle.textContent = prefs.fitCover ? 'Fit: On' : 'Fit: Off';
            // Update existing images
            gridEl.querySelectorAll('img').forEach(img => img.style.objectFit = prefs.fitCover ? 'cover' : 'contain');
            if (targetImg) targetImg.style.objectFit = prefs.fitCover ? 'cover' : 'contain';
            savePrefs();
        });
    }

    // Apply initial sizes
    if (gridEl) gridEl.style.setProperty('--hunt-cell-size', prefs.cellSize + 'px');
    if (targetImg) {
        targetImg.style.width = prefs.targetSize + 'px';
        targetImg.style.height = Math.round(prefs.targetSize * 0.625) + 'px';
        targetImg.style.objectFit = prefs.fitCover ? 'cover' : 'contain';
    }
});

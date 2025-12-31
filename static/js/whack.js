/**
 * Whack-a-Mole Game
 * Images appear at random positions on screen, player clicks to eliminate them
 * Score increases with each successful click
 */

const whackState = {
    running: false,
    score: 0,
    clicks: 0,
    startTime: 0,
    duration: 60,
    gameArea: null,
    activeImage: null,
    appearanceTime: null,
    getDifficultyConfig() {
        const difficulty = document.getElementById('whackDifficulty')?.value || 'medium';
        const configs = {
            easy: { appearTime: 1500, respawnDelay: 300 },
            medium: { appearTime: 1000, respawnDelay: 200 },
            hard: { appearTime: 700, respawnDelay: 150 },
            insane: { appearTime: 500, respawnDelay: 100 }
        };
        return configs[difficulty] || configs.medium;
    }
};

// DOM elements
const whackContainer = document.getElementById('whackContainer');
const gameArea = document.getElementById('whackGameArea');
const scoreDisplay = document.getElementById('whackScore');
const clicksDisplay = document.getElementById('whackClicks');
const timeDisplay = document.getElementById('whackTime');
const messageDiv = document.getElementById('whackMessage');
const startBtn = document.getElementById('startWhackBtn');
const resetBtn = document.getElementById('resetWhackBtn');
const backBtn = document.getElementById('backWhackBtn');
const durationSelect = document.getElementById('whackDuration');
const usernameInput = document.getElementById('whackUsernameInput');

let timerInterval = null;
let imageTimeout = null;
let respawnTimeout = null;

/**
 * Format seconds as MM:SS
 */
function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Update the timer display
 */
function updateTimer() {
    if (!whackState.running) return;
    const elapsed = Math.floor((Date.now() - whackState.startTime) / 1000);
    const remaining = Math.max(0, whackState.duration - elapsed);
    timeDisplay.textContent = formatTime(remaining);

    if (remaining <= 0) {
        endGame();
    }
}

/**
 * Get a random position for image to appear
 */
function getRandomPosition() {
    const maxWidth = gameArea.offsetWidth - 120;
    const maxHeight = gameArea.offsetHeight - 120;
    const x = Math.random() * Math.max(0, maxWidth);
    const y = Math.random() * Math.max(0, maxHeight);
    return { x, y };
}

/**
 * Create a clickable image element
 */
function createWhackImage() {
    if (!whackState.running) return;

    // Clear previous image if exists
    if (whackState.activeImage) {
        whackState.activeImage.remove();
        clearTimeout(imageTimeout);
    }

    const randomImage = WHACK_IMAGES[Math.floor(Math.random() * WHACK_IMAGES.length)];
    const position = getRandomPosition();
    const config = whackState.getDifficultyConfig();

    // Create image element
    const img = document.createElement('img');
    img.className = 'whack-image';
    img.src = `${randomImage}?v=${Date.now()}`;
    img.style.left = `${position.x}px`;
    img.style.top = `${position.y}px`;
    img.alt = 'Click me!';

    // Click handler
    img.addEventListener('click', (e) => {
        e.stopPropagation();
        if (whackState.running && whackState.activeImage === img) {
            whackState.score += 10;
            whackState.clicks++;
            scoreDisplay.textContent = whackState.score;
            clicksDisplay.textContent = whackState.clicks;
            
            // Visual feedback
            img.classList.add('whacked');
            setTimeout(() => {
                if (img.parentNode) {
                    img.remove();
                }
                whackState.activeImage = null;
                // Spawn next image after respawn delay
                respawnTimeout = setTimeout(createWhackImage, config.respawnDelay);
            }, 150);
        }
    });

    gameArea.appendChild(img);
    whackState.activeImage = img;
    whackState.appearanceTime = Date.now();

    // Auto-disappear image after appearance time
    imageTimeout = setTimeout(() => {
        if (whackState.activeImage === img && whackState.running) {
            img.classList.add('disappear');
            setTimeout(() => {
                if (img.parentNode) {
                    img.remove();
                }
                whackState.activeImage = null;
                respawnTimeout = setTimeout(createWhackImage, config.respawnDelay);
            }, 200);
        }
    }, config.appearTime);
}

/**
 * Start the game
 */
function startGame() {
    // Reset state
    whackState.running = true;
    whackState.score = 0;
    whackState.clicks = 0;
    whackState.duration = parseInt(durationSelect.value) || 60;
    whackState.startTime = Date.now();

    // UI updates
    messageDiv.textContent = '';
    scoreDisplay.textContent = '0';
    clicksDisplay.textContent = '0';
    startBtn.style.display = 'none';
    resetBtn.style.display = 'inline-block';
    durationSelect.disabled = true;
    document.getElementById('whackDifficulty').disabled = true;
    usernameInput.disabled = true;

    // Clear game area
    gameArea.innerHTML = '';

    // Start game
    createWhackImage();

    // Timer
    timerInterval = setInterval(updateTimer, 100);
}

/**
 * End the game
 */
function endGame() {
    whackState.running = false;

    // Clear timeouts
    clearTimeout(imageTimeout);
    clearTimeout(respawnTimeout);
    clearInterval(timerInterval);

    // Remove active image
    if (whackState.activeImage) {
        whackState.activeImage.remove();
        whackState.activeImage = null;
    }

    // UI updates
    startBtn.style.display = 'inline-block';
    resetBtn.style.display = 'none';
    durationSelect.disabled = false;
    document.getElementById('whackDifficulty').disabled = false;
    usernameInput.disabled = false;

    const elapsed = Math.floor((Date.now() - whackState.startTime) / 1000);
    messageDiv.innerHTML = `
        <div class="game-over-message">
            <h2>Game Over!</h2>
            <p>Score: <strong>${whackState.score}</strong></p>
            <p>Clicks: <strong>${whackState.clicks}</strong></p>
            <p>Time: <strong>${formatTime(elapsed)}</strong></p>
        </div>
    `;

    // Submit score
    submitScore(whackState.score, elapsed, whackState.clicks);
}

/**
 * Submit score to server
 */
function submitScore(score, time, clicks) {
    const username = (usernameInput.value || 'Anonymous').trim();
    
    fetch('/api/submit-score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            collection: CURRENT_COLLECTION,
            gameType: 'whack',
            score: score,
            time: time,
            clicks: clicks,
            username: username
        })
    })
    .catch(err => console.error('Score submission error:', err));
}

/**
 * Reset game
 */
function resetGame() {
    whackState.running = false;
    clearTimeout(imageTimeout);
    clearTimeout(respawnTimeout);
    clearInterval(timerInterval);
    gameArea.innerHTML = '';
    messageDiv.textContent = '';
    scoreDisplay.textContent = '0';
    clicksDisplay.textContent = '0';
    timeDisplay.textContent = '0:00';
    startBtn.style.display = 'inline-block';
    resetBtn.style.display = 'none';
    durationSelect.disabled = false;
    document.getElementById('whackDifficulty').disabled = false;
    usernameInput.disabled = false;
}

// Event listeners
startBtn.addEventListener('click', startGame);
resetBtn.addEventListener('click', resetGame);

backBtn.addEventListener('click', () => {
    whackState.running = false;
    clearTimeout(imageTimeout);
    clearTimeout(respawnTimeout);
    clearInterval(timerInterval);
    window.location.href = `/collection/${CURRENT_COLLECTION}`;
});

durationSelect.addEventListener('change', (e) => {
    whackState.duration = parseInt(e.target.value) || 60;
});

// Prevent context menu on game area
gameArea.addEventListener('contextmenu', (e) => {
    if (whackState.running) {
        e.preventDefault();
    }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    whackState.gameArea = gameArea;
    if (WHACK_IMAGES.length === 0) {
        messageDiv.textContent = 'No images found in this collection.';
        startBtn.disabled = true;
    }
});

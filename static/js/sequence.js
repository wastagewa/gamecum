// Sequence Memory Game - Simon Says with images
document.addEventListener('DOMContentLoaded', () => {
    const gameBoard = document.getElementById('sequenceBoard');
    const startBtn = document.getElementById('startSequence');
    const restartBtn = document.getElementById('restartSequence');
    const levelDisplay = document.getElementById('currentLevel');
    const scoreDisplay = document.getElementById('sequenceScore');
    const statusMessage = document.getElementById('sequenceStatus');
    const gridSizeSelect = document.getElementById('gridSize');
    const sequenceLengthSelect = document.getElementById('sequenceLength');
    const flashSpeedSelect = document.getElementById('flashSpeed');
    const incrementModeCheckbox = document.getElementById('incrementMode');
    const gameOverModal = document.getElementById('sequenceGameOver');
    const finalScoreDisplay = document.getElementById('finalSequenceScore');
    const finalLevelDisplay = document.getElementById('finalSequenceLevel');
    const playAgainBtn = document.getElementById('playSequenceAgain');
    const victoryImage = document.getElementById('sequenceVictoryImage');

    let gameImages = [];
    let currentLevel = 1;
    let score = 0;
    let sequence = [];
    let playerSequence = [];
    let isShowingSequence = false;
    let isPlayerTurn = false;
    let gridSize = 4;
    let baseSequenceLength = 3;
    let flashSpeed = 600;
    let gameActive = false;
    let incrementMode = false;
    let difficultyMultiplier = 1;

    // Load images from SERVER_IMAGES or fetch from API
    async function loadImages() {
        if (window.SERVER_IMAGES && window.SERVER_IMAGES.length > 0) {
            gameImages = [...window.SERVER_IMAGES];
            return gameImages;
        }
        
        try {
            const res = await fetch('/api/collections');
            const data = await res.json();
            if (data && data.collections) {
                const allImages = [];
                Object.values(data.collections).forEach(imgs => allImages.push(...imgs));
                gameImages = allImages;
                return gameImages;
            }
        } catch (err) {
            console.error('Error loading images:', err);
        }
        return [];
    }

    // Initialize game board
    function initBoard() {
        gameBoard.innerHTML = '';
        gameBoard.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;
        
        const totalSlots = gridSize * gridSize;
        const imagesToUse = shuffle([...gameImages]).slice(0, totalSlots);
        
        for (let i = 0; i < totalSlots; i++) {
            const cell = document.createElement('div');
            cell.className = 'sequence-cell';
            cell.dataset.index = i;
            
            const img = document.createElement('img');
            img.src = imagesToUse[i] || '/static/placeholder.png';
            img.alt = 'Game image';
            
            cell.appendChild(img);
            cell.addEventListener('click', () => handleCellClick(i));
            gameBoard.appendChild(cell);
        }
    }

    // Shuffle array
    function shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    // Generate sequence
    function generateSequence() {
        const totalCells = gridSize * gridSize;
        let sequenceLength;
        
        if (incrementMode) {
            // In increment mode, add one to sequence each level
            sequenceLength = baseSequenceLength + (currentLevel - 1);
        } else {
            // Standard mode: increase by 1 every 2 levels
            sequenceLength = baseSequenceLength + Math.floor((currentLevel - 1) / 2);
        }
        
        sequence = [];
        for (let i = 0; i < sequenceLength; i++) {
            sequence.push(Math.floor(Math.random() * totalCells));
        }
    }
    
    // Calculate difficulty multiplier for scoring
    function calculateDifficultyMultiplier() {
        let multiplier = 1;
        
        // Grid size bonus
        if (gridSize === 3) multiplier *= 0.8;
        else if (gridSize === 4) multiplier *= 1.0;
        else if (gridSize === 5) multiplier *= 1.3;
        else if (gridSize === 6) multiplier *= 1.6;
        
        // Flash speed bonus
        if (flashSpeed === 800) multiplier *= 0.8;
        else if (flashSpeed === 600) multiplier *= 1.0;
        else if (flashSpeed === 400) multiplier *= 1.3;
        else if (flashSpeed === 250) multiplier *= 1.6;
        
        // Increment mode bonus
        if (incrementMode) multiplier *= 1.5;
        
        return multiplier;
    }

    // Show sequence to player
    async function showSequence() {
        isShowingSequence = true;
        isPlayerTurn = false;
        statusMessage.textContent = 'Watch carefully...';
        statusMessage.className = 'sequence-status watching';
        
        // Disable all cells
        document.querySelectorAll('.sequence-cell').forEach(cell => {
            cell.classList.remove('clickable');
        });
        
        await sleep(800);
        
        for (let i = 0; i < sequence.length; i++) {
            const cellIndex = sequence[i];
            const cell = document.querySelector(`.sequence-cell[data-index="${cellIndex}"]`);
            
            if (cell) {
                cell.classList.add('flash');
                await sleep(flashSpeed);
                cell.classList.remove('flash');
                await sleep(200);
            }
        }
        
        isShowingSequence = false;
        isPlayerTurn = true;
        statusMessage.textContent = 'Your turn! Repeat the sequence';
        statusMessage.className = 'sequence-status playing';
        
        // Enable all cells
        document.querySelectorAll('.sequence-cell').forEach(cell => {
            cell.classList.add('clickable');
        });
    }

    // Handle cell click
    function handleCellClick(index) {
        if (!isPlayerTurn || isShowingSequence || !gameActive) return;
        
        const cell = document.querySelector(`.sequence-cell[data-index="${index}"]`);
        if (!cell) return;
        
        // Visual feedback
        cell.classList.add('clicked');
        setTimeout(() => cell.classList.remove('clicked'), 300);
        
        playerSequence.push(index);
        
        // Check if current click is correct
        const currentStep = playerSequence.length - 1;
        if (playerSequence[currentStep] !== sequence[currentStep]) {
            // Wrong sequence
            gameOver(false);
            return;
        }
        
        // Check if sequence is complete
        if (playerSequence.length === sequence.length) {
            // Correct sequence!
            sequenceComplete();
        }
    }

    // Sequence completed successfully
    async function sequenceComplete() {
        isPlayerTurn = false;
        statusMessage.textContent = '✓ Correct!';
        statusMessage.className = 'sequence-status correct';
        
        // Show victory image briefly
        await showVictoryImage();
        
        // Calculate score with difficulty multiplier
        const sequenceBonus = Math.round(sequence.length * 10 * difficultyMultiplier);
        const levelBonus = Math.round(currentLevel * 5 * difficultyMultiplier);
        score += sequenceBonus + levelBonus;
        scoreDisplay.textContent = score;
        
        await sleep(500);
        
        // Next level
        currentLevel++;
        levelDisplay.textContent = currentLevel;
        playerSequence = [];
        
        await sleep(300);
        nextRound();
    }
    
    // Show victory image briefly
    async function showVictoryImage() {
        if (gameImages.length === 0) return;
        
        const randomImg = gameImages[Math.floor(Math.random() * gameImages.length)];
        victoryImage.src = randomImg;
        
        // Show modal briefly
        gameOverModal.style.display = 'flex';
        setTimeout(() => gameOverModal.classList.add('show'), 10);
        
        // Hide final score/level, show only image
        finalScoreDisplay.parentElement.style.display = 'none';
        finalLevelDisplay.parentElement.style.display = 'none';
        playAgainBtn.style.display = 'none';
        document.getElementById('closeSequenceModal').style.display = 'none';
        document.querySelector('.sequence-modal-title').style.display = 'none';
        
        await sleep(1500);
        
        // Hide modal
        hideGameOverModal();
        
        // Restore elements for game over
        finalScoreDisplay.parentElement.style.display = '';
        finalLevelDisplay.parentElement.style.display = '';
        playAgainBtn.style.display = '';
        document.getElementById('closeSequenceModal').style.display = '';
        document.querySelector('.sequence-modal-title').style.display = '';
    }

    // Start next round
    async function nextRound() {
        // Occasionally refresh board with new images
        if (currentLevel % 5 === 0) {
            initBoard();
            await sleep(500);
        }
        
        generateSequence();
        showSequence();
    }

    // Game over
    function gameOver(won = false) {
        gameActive = false;
        isPlayerTurn = false;
        
        if (!won) {
            // Show wrong sequence
            statusMessage.textContent = '✗ Wrong sequence!';
            statusMessage.className = 'sequence-status wrong';
            
            document.querySelectorAll('.sequence-cell').forEach(cell => {
                cell.classList.remove('clickable');
            });
        }
        
        setTimeout(() => {
            showGameOverModal();
        }, 1500);
    }

    // Show game over modal
    async function showGameOverModal() {
        finalScoreDisplay.textContent = score;
        finalLevelDisplay.textContent = currentLevel;
        
        // Show random victory image
        if (gameImages.length > 0) {
            const randomImg = gameImages[Math.floor(Math.random() * gameImages.length)];
            victoryImage.src = randomImg;
        }
        
        gameOverModal.style.display = 'flex';
        setTimeout(() => gameOverModal.classList.add('show'), 10);
    }

    // Hide game over modal
    function hideGameOverModal() {
        gameOverModal.classList.remove('show');
        setTimeout(() => {
            gameOverModal.style.display = 'none';
        }, 300);
    }

    // Request fullscreen
    async function enterFullscreen() {
        try {
            const elem = document.documentElement;
            if (elem.requestFullscreen) {
                await elem.requestFullscreen();
            } else if (elem.webkitRequestFullscreen) {
                await elem.webkitRequestFullscreen();
            } else if (elem.msRequestFullscreen) {
                await elem.msRequestFullscreen();
            }
        } catch (err) {
            console.error('Fullscreen request failed:', err);
        }
    }

    // Start game
    async function startGame() {
        if (gameActive) return;
        
        // Enter fullscreen
        await enterFullscreen();
        
        // Load settings
        gridSize = parseInt(gridSizeSelect.value);
        baseSequenceLength = parseInt(sequenceLengthSelect.value);
        flashSpeed = parseInt(flashSpeedSelect.value);
        incrementMode = incrementModeCheckbox.checked;
        difficultyMultiplier = calculateDifficultyMultiplier();
        
        // Reset game state
        currentLevel = 1;
        score = 0;
        sequence = [];
        playerSequence = [];
        gameActive = true;
        
        levelDisplay.textContent = currentLevel;
        scoreDisplay.textContent = score;
        statusMessage.textContent = 'Get ready...';
        statusMessage.className = 'sequence-status';
        
        startBtn.style.display = 'none';
        restartBtn.style.display = 'inline-flex';
        gridSizeSelect.disabled = false;
        sequenceLengthSelect.disabled = false;
        flashSpeedSelect.disabled = false;
        incrementModeCheckbox.disabled = false;
        
        // Load images and init board
        await loadImages();
        
        if (gameImages.length === 0) {
            statusMessage.textContent = 'Error: No images available';
            statusMessage.className = 'sequence-status wrong';
            startBtn.style.display = 'inline-flex';
            restartBtn.style.display = 'none';
            return;
        }
        
        initBoard();
        await sleep(1000);
        
        // Start first round
        generateSequence();
        showSequence();
    }

    // Reset game
    function resetGame() {
        hideGameOverModal();
        gameActive = false;
        startBtn.style.display = 'inline-flex';
        restartBtn.style.display = 'none';
        gridSizeSelect.disabled = false;
        sequenceLengthSelect.disabled = false;
        flashSpeedSelect.disabled = false;
        incrementModeCheckbox.disabled = false;
        
        currentLevel = 1;
        score = 0;
        sequence = [];
        playerSequence = [];
        
        levelDisplay.textContent = currentLevel;
        scoreDisplay.textContent = score;
        statusMessage.textContent = 'Press Start to begin';
        statusMessage.className = 'sequence-status';
        
        gameBoard.innerHTML = '<p style="color: var(--muted-text); grid-column: 1/-1; text-align: center;">Press Start to begin</p>';
    }

    // Utility sleep function
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Event listeners
    if (startBtn) {
        startBtn.addEventListener('click', startGame);
    }
    
    if (restartBtn) {
        restartBtn.addEventListener('click', () => {
            resetGame();
            startGame();
        });
    }
    
    if (playAgainBtn) {
        playAgainBtn.addEventListener('click', () => {
            resetGame();
            startGame();
        });
    }
    
    const closeModalBtn = document.getElementById('closeSequenceModal');
    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', resetGame);
    }
    
    // Setting change listeners - auto restart game
    if (gridSizeSelect) {
        gridSizeSelect.addEventListener('change', () => {
            if (gameActive) {
                resetGame();
                startGame();
            }
        });
    }
    
    if (sequenceLengthSelect) {
        sequenceLengthSelect.addEventListener('change', () => {
            if (gameActive) {
                resetGame();
                startGame();
            }
        });
    }
    
    if (flashSpeedSelect) {
        flashSpeedSelect.addEventListener('change', () => {
            if (gameActive) {
                resetGame();
                startGame();
            }
        });
    }
    
    if (incrementModeCheckbox) {
        incrementModeCheckbox.addEventListener('change', () => {
            if (gameActive) {
                resetGame();
                startGame();
            }
        });
    }

    // Initialize display
    resetGame();
});

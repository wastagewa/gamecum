// Tag Match Memory Game Logic

const DIFFICULTY_SETTINGS = {
    easy: { pairs: 4, name: '4 pairs' },
    medium: { pairs: 6, name: '6 pairs' },
    hard: { pairs: 8, name: '8 pairs' },
    insane: { pairs: 10, name: '10 pairs' },
    custom: { pairs: 6, name: 'custom pairs' }
};

class TagMatchGame {
    constructor() {
        this.collection = new URLSearchParams(window.location.search).get('collection') || 'Real';
        this.cards = [];
        this.flipped = [];
        this.matched = [];
        this.moves = 0;
        this.score = 0;
        this.startTime = null;
        this.gameOver = false;
        this.timerInterval = null;
        this.currentDifficulty = 'medium';
        this.customPairs = 6;
        this.cardSizePx = 100;
        this.displayMode = 'full';
        
        this.boardEl = document.getElementById('gameBoard');
        this.timeDisplay = document.getElementById('timeDisplay');
        this.movesDisplay = document.getElementById('movesDisplay');
        this.matchedDisplay = document.getElementById('matchedDisplay');
        this.difficultySelect = document.getElementById('difficultySelect');
        this.customPairsInput = document.getElementById('customPairsInput');
        this.customPairsControl = document.getElementById('customPairsControl');
        this.cardSizeInput = document.getElementById('cardSizeInput');
        this.displayModeSelect = document.getElementById('displayModeSelect');
        this.usernameInput = document.getElementById('usernameInput');
        this.fullscreenBtn = document.getElementById('fullscreenBtn');
        this.newGameBtn = document.getElementById('newGameBtn');
        this.endScreen = document.getElementById('endScreen');
        this.playAgainBtn = document.getElementById('playAgainBtn');
        this.submitScoreBtn = document.getElementById('submitScoreBtn');
        this.tagMatchShell = document.querySelector('.tag-match-shell');

        // Load saved username
        const savedUsername = localStorage.getItem('imgur.username');
        if (savedUsername) {
            this.usernameInput.value = savedUsername;
        }

        this.setupEventListeners();
        this.setupFullscreenListener();
        this.loadGames();
    }

    setupEventListeners() {
        this.difficultySelect.addEventListener('change', (e) => {
            this.currentDifficulty = e.target.value;
            
            // Show/hide custom pairs input
            if (this.currentDifficulty === 'custom') {
                this.customPairsControl.style.display = 'flex';
                this.customPairs = parseInt(this.customPairsInput.value) || 6;
            } else {
                this.customPairsControl.style.display = 'none';
            }
            
            this.initGame();
        });

        this.customPairsInput.addEventListener('change', (e) => {
            const value = parseInt(e.target.value) || 6;
            this.customPairs = Math.min(Math.max(value, 2), 20); // Clamp between 2 and 20
            this.customPairsInput.value = this.customPairs;
            this.initGame();
        });

        this.cardSizeInput.addEventListener('change', (e) => {
            const value = parseInt(e.target.value) || 100;
            this.cardSizePx = Math.min(Math.max(value, 60), 300); // Clamp between 60 and 300
            this.cardSizeInput.value = this.cardSizePx;
            this.updateCardSize();
        });

        this.displayModeSelect.addEventListener('change', (e) => {
            this.displayMode = e.target.value;
            this.updateDisplayMode();
        });

        // Username input - save to localStorage when changed
        this.usernameInput.addEventListener('change', (e) => {
            localStorage.setItem('imgur.username', e.target.value);
        });

        // Fullscreen button
        this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());

        this.newGameBtn.addEventListener('click', () => this.initGame());
        this.playAgainBtn.addEventListener('click', () => {
            this.endScreen.classList.remove('show');
            this.initGame();
        });
        this.submitScoreBtn.addEventListener('click', () => this.submitScore());
    }

    loadGames() {
        this.initGame();
    }

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            // Enter fullscreen
            document.documentElement.requestFullscreen().catch(err => {
                console.error(`Error attempting to enable fullscreen: ${err.message}`);
            });
        } else {
            // Exit fullscreen
            document.exitFullscreen();
        }
    }

    setupFullscreenListener() {
        document.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) {
                // Entered fullscreen
                this.tagMatchShell.classList.add('fullscreen');
                this.fullscreenBtn.classList.add('fullscreen-active');
            } else {
                // Exited fullscreen
                this.tagMatchShell.classList.remove('fullscreen');
                this.fullscreenBtn.classList.remove('fullscreen-active');
            }
        });
    }

    updateCardSize() {
        // Calculate grid based on card size
        const minSize = this.cardSizePx;
        this.boardEl.style.gridTemplateColumns = `repeat(auto-fit, minmax(${minSize}px, 1fr))`;
        
        // Update card dimensions
        const cards = this.boardEl.querySelectorAll('.tag-match-card');
        cards.forEach(card => {
            card.style.width = `${this.cardSizePx}px`;
            card.style.height = `${this.cardSizePx}px`;
        });
    }

    updateDisplayMode() {
        // Remove previous display mode classes
        this.boardEl.classList.remove('display-fit', 'display-stretch', 'display-full');
        
        // Add the appropriate display mode class
        if (this.displayMode === 'fit') {
            this.boardEl.classList.add('display-fit');
        } else if (this.displayMode === 'stretch') {
            this.boardEl.classList.add('display-stretch');
        } else if (this.displayMode === 'full') {
            this.boardEl.classList.add('display-full');
        }
    }

    getPairCount() {
        if (this.currentDifficulty === 'custom') {
            return this.customPairs;
        }
        return DIFFICULTY_SETTINGS[this.currentDifficulty].pairs;
    }

    async initGame() {
        // Stop any existing timer
        if (this.timerInterval) clearInterval(this.timerInterval);
        
        // Reset game state
        this.cards = [];
        this.flipped = [];
        this.matched = [];
        this.moves = 0;
        this.score = 0;
        this.startTime = null;
        this.gameOver = false;
        
        // Update UI
        this.updateStats();
        this.endScreen.classList.remove('show');
        this.boardEl.innerHTML = '<p style="text-align:center; color: var(--muted-text);">Loading game...</p>';
        
        try {
            // Fetch tags and images
            const response = await fetch('/api/tags-with-counts');
            const data = await response.json();
            
            if (!data.success || !data.tags || data.tags.length === 0) {
                this.boardEl.innerHTML = '<p style="color: var(--muted-text); text-align: center;">No tags found. Ensure images are tagged first!</p>';
                return;
            }

            // Get pair count based on current difficulty/custom setting
            const targetPairs = this.getPairCount();

            // Build cards from tags
            const allTags = data.tags.slice(0, targetPairs * 2); // Get more tags than needed for filtering
            const tagsForGame = allTags.slice(0, targetPairs);
            const imagesByTag = {};

            // Fetch images for each selected tag
            for (const tag of tagsForGame) {
                const imgResponse = await fetch(`/api/images-by-tags?tags=${encodeURIComponent(tag.tag)}`);
                const imgData = await imgResponse.json();
                
                if (imgData.success && imgData.images && imgData.images.length > 0) {
                    imagesByTag[tag.tag] = imgData.images;
                }
            }

            // Create game cards
            for (const tag of tagsForGame) {
                if (imagesByTag[tag.tag] && imagesByTag[tag.tag].length > 0) {
                    const randomImage = imagesByTag[tag.tag][Math.floor(Math.random() * imagesByTag[tag.tag].length)];
                    
                    // Tag card
                    this.cards.push({
                        type: 'tag',
                        tag: tag.tag,
                        pair: tag.tag,
                        icon: '🏷️'
                    });

                    // Image card
                    this.cards.push({
                        type: 'image',
                        tag: tag.tag,
                        pair: tag.tag,
                        url: randomImage.url,
                        filename: randomImage.filename,
                        collection: randomImage.collection
                    });
                }
            }

            // Shuffle cards
            this.cards = this.cards.sort(() => Math.random() - 0.5);

            // Render board with appropriate size
            this.renderBoard();
            this.updateCardSize();
            this.updateDisplayMode();
            this.startTimer();
        } catch (error) {
            console.error('Error loading game:', error);
            this.boardEl.innerHTML = '<p style="color: red; text-align: center;">Error loading game. Please try again.</p>';
        }
    }

    renderBoard() {
        this.boardEl.innerHTML = '';
        
        this.cards.forEach((card, index) => {
            const cardEl = document.createElement('div');
            cardEl.className = 'tag-match-card';
            cardEl.dataset.index = index;
            cardEl.style.width = `${this.cardSizePx}px`;
            cardEl.style.height = `${this.cardSizePx}px`;

            if (card.type === 'tag') {
                cardEl.innerHTML = `
                    <div class="tag-match-card-content">
                        <div class="tag-match-card-icon">🏷️</div>
                        <div class="tag-match-card-text">${this.truncateText(card.tag, 12)}</div>
                    </div>
                `;
            } else {
                cardEl.innerHTML = `
                    <img class="tag-match-card-image" src="${card.url}" alt="Card image">
                    <div class="tag-match-card-content">
                        <div class="tag-match-card-icon">🖼️</div>
                        <div class="tag-match-card-text">${this.truncateText(card.tag, 12)}</div>
                    </div>
                `;
            }

            cardEl.addEventListener('click', () => this.flipCard(index));
            this.boardEl.appendChild(cardEl);
        });

        this.updateStats();
    }

    flipCard(index) {
        if (this.gameOver || this.flipped.length >= 2 || this.matched.includes(index)) return;
        if (this.flipped.includes(index)) return;

        // Start timer on first flip
        if (!this.startTime) {
            this.startTime = Date.now();
            this.startTimer();
        }

        this.flipped.push(index);
        const cardEl = this.boardEl.children[index];
        cardEl.classList.add('flipped');

        if (this.flipped.length === 2) {
            this.moves++;
            this.updateStats();
            setTimeout(() => this.checkMatch(), 600);
        }
    }

    checkMatch() {
        const [idx1, idx2] = this.flipped;
        const card1 = this.cards[idx1];
        const card2 = this.cards[idx2];

        const isMatch = card1.pair === card2.pair;
        const cardEl1 = this.boardEl.children[idx1];
        const cardEl2 = this.boardEl.children[idx2];

        if (isMatch) {
            // Match found!
            cardEl1.classList.add('matched');
            cardEl2.classList.add('matched');
            this.matched.push(idx1, idx2);
            
            // Play success sound (optional)
            this.playSound('success');

            this.flipped = [];
            this.updateStats();

            // Check if game is complete
            if (this.matched.length === this.cards.length) {
                this.endGame();
            }
        } else {
            // No match
            cardEl1.classList.add('incorrect');
            cardEl2.classList.add('incorrect');
            
            // Play fail sound (optional)
            this.playSound('fail');

            setTimeout(() => {
                cardEl1.classList.remove('flipped', 'incorrect');
                cardEl2.classList.remove('flipped', 'incorrect');
                this.flipped = [];
            }, 600);
        }
    }

    startTimer() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        
        this.timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            this.timeDisplay.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }, 100);
    }

    endGame() {
        this.gameOver = true;
        if (this.timerInterval) clearInterval(this.timerInterval);

        const totalTime = Math.floor((Date.now() - this.startTime) / 1000);
        
        // Calculate score: base points increase with pair count
        const pairs = this.matched.length / 2;
        const baseScore = pairs * pairs * 500; // Quadratic scoring: more pairs = exponentially higher score
        const timePenalty = totalTime;
        const movePenalty = (this.moves - pairs) * 50;
        this.score = Math.max(0, baseScore - timePenalty - movePenalty);

        // Show end screen
        document.getElementById('finalTime').textContent = this.formatTime(totalTime);
        document.getElementById('finalMoves').textContent = this.moves;
        document.getElementById('finalPairs').textContent = `${pairs}/${pairs}`;
        document.getElementById('finalScore').textContent = Math.round(this.score);

        this.endScreen.classList.add('show');
    }

    async submitScore() {
        try {
            // Get username from input or localStorage
            const username = this.usernameInput.value.trim() || localStorage.getItem('imgur.username') || 'Anonymous';
            
            // Save username to localStorage for future sessions
            if (this.usernameInput.value.trim()) {
                localStorage.setItem('imgur.username', this.usernameInput.value.trim());
            }

            const totalTime = Math.floor((Date.now() - this.startTime) / 1000);
            const pairs = this.matched.length / 2;

            const response = await fetch('/api/submit-score', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    collection: this.collection,
                    gameType: 'tag-match',
                    time: totalTime,
                    wrong: Math.max(0, this.moves - pairs),
                    moves: this.moves,
                    pairs: pairs,
                    matchSize: 1,
                    score: Math.round(this.score),
                    username: username
                })
            });

            const data = await response.json();
            
            if (data.success) {
                this.submitScoreBtn.textContent = '✓ Score Submitted!';
                this.submitScoreBtn.disabled = true;
                setTimeout(() => {
                    this.submitScoreBtn.textContent = '<i class="fas fa-check"></i> Submit Score';
                    this.submitScoreBtn.disabled = false;
                }, 2000);
            }
        } catch (error) {
            console.error('Error submitting score:', error);
        }
    }

    updateStats() {
        const totalPairs = this.cards.length / 2;
        const matchedPairs = this.matched.length / 2;
        this.matchedDisplay.textContent = `${matchedPairs}/${totalPairs}`;
        this.movesDisplay.textContent = this.moves;
    }

    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    truncateText(text, maxLength) {
        return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
    }

    playSound(type) {
        // Optional: Add sound effects
        // const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        // This would require audio implementation
    }
}

// Initialize game
document.addEventListener('DOMContentLoaded', () => {
    const game = new TagMatchGame();
});

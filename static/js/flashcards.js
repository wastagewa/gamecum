// Flash Cards Memory Game Logic
document.addEventListener('DOMContentLoaded', () => {
    const startGameBtn = document.getElementById('startGameBtn');
    const resetGameBtn = document.getElementById('resetGameBtn');
    const backBtn = document.getElementById('backBtn');
    const scoreCounter = document.getElementById('scoreCounter');
    const levelCounter = document.getElementById('levelCounter');
    const timeCounter = document.getElementById('timeCounter');
    const gameMessage = document.getElementById('gameMessage');
    const viewPhase = document.getElementById('viewPhase');
    const guessPhase = document.getElementById('guessPhase');
    const imageGrid = document.getElementById('imageGrid');
    const guessGrid = document.getElementById('guessGrid');
    const countdownText = document.getElementById('countdownText');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const flashcardsContainer = document.getElementById('flashcardsContainer');

    let gameState = {
        score: 0,
        level: 1,
        imagesToShow: [],
        currentImage: null,
        currentImageIndex: 0,
        guessOptions: [],
        startTime: null,
        timerInterval: null,
        isGameActive: false,
        correctAnswer: null
    };

    // Go back button
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            window.location.href = `/collection/${CURRENT_COLLECTION}`;
        });
    }

    // Reset game
    if (resetGameBtn) {
        resetGameBtn.addEventListener('click', () => {
            resetGame();
        });
    }

    // Start game button
    if (startGameBtn) {
        startGameBtn.addEventListener('click', () => {
            if (!gameState.isGameActive) {
                initializeGame();
            }
        });
    }

    // Fullscreen toggle
    if (fullscreenBtn && flashcardsContainer) {
        fullscreenBtn.addEventListener('click', () => {
            if (document.fullscreenElement === flashcardsContainer) {
                exitFullscreen();
            } else {
                enterFullscreen();
            }
        });

        document.addEventListener('fullscreenchange', () => {
            updateFullscreenIcon();
        });
    }

    function initializeGame() {
        if (GAME_IMAGES.length < 2) {
            gameMessage.textContent = 'Need at least 2 images to play!';
            gameMessage.className = 'game-message error';
            return;
        }

        resetGame();
        gameState.isGameActive = true;
        gameState.startTime = Date.now();
        startTimer();
        startGameBtn.disabled = true;
        gameMessage.textContent = '';
        
        // Start the first round
        startNextRound();
    }

    function startNextRound() {
        // Calculate how many images to show based on level
        const imagesToShow = Math.min(1 + Math.floor(gameState.level / 2), Math.min(5, GAME_IMAGES.length));
        
        // Get random images to show
        gameState.imagesToShow = shuffleArray([...Array(GAME_IMAGES.length).keys()])
            .slice(0, imagesToShow)
            .map(i => GAME_IMAGES[i]);
        
        gameState.currentImageIndex = 0;
        showViewPhase();
    }

    function showViewPhase() {
        viewPhase.style.display = 'block';
        guessPhase.style.display = 'none';
        
        // Display images one by one
        displayImages();
    }

    function displayImages() {
        imageGrid.innerHTML = '';
        
        gameState.imagesToShow.forEach((image) => {
            const img = document.createElement('img');
            img.src = image;
            img.alt = 'memorize';
            img.className = 'flashcard-image';
            imageGrid.appendChild(img);
        });

        // Wait before starting guess phase
        let countdown = 3;
        countdownText.textContent = `Starting in: ${countdown}`;
        
        const countdownInterval = setInterval(() => {
            countdown--;
            if (countdown > 0) {
                countdownText.textContent = `Starting in: ${countdown}`;
            } else {
                clearInterval(countdownInterval);
                showGuessPhase();
            }
        }, 1000);
    }

    function showGuessPhase() {
        // Clear the view phase images completely to prevent overlap
        imageGrid.innerHTML = '';
        
        viewPhase.style.display = 'none';
        guessPhase.style.display = 'block';
        
        // Pick a random image from shown images
        const randomIndex = Math.floor(Math.random() * gameState.imagesToShow.length);
        gameState.correctAnswer = gameState.imagesToShow[randomIndex];
        
        // Create guess options
        let guessOptions = [gameState.correctAnswer];
        
        // Add random other images
        const otherImages = GAME_IMAGES.filter(img => !gameState.imagesToShow.includes(img));
        while (guessOptions.length < Math.min(4, GAME_IMAGES.length)) {
            const randomOther = otherImages[Math.floor(Math.random() * otherImages.length)];
            if (!guessOptions.includes(randomOther)) {
                guessOptions.push(randomOther);
            }
        }
        
        // Shuffle options
        gameState.guessOptions = shuffleArray(guessOptions);
        
        // Display options
        guessGrid.innerHTML = '';
        gameState.guessOptions.forEach((image) => {
            const img = document.createElement('img');
            img.src = image;
            img.alt = 'guess';
            img.className = 'guess-option';
            
            img.addEventListener('click', () => {
                checkAnswer(image);
            });
            
            guessGrid.appendChild(img);
        });
    }

    function checkAnswer(selected) {
        const isCorrect = selected === gameState.correctAnswer;
        
        if (isCorrect) {
            gameState.score += 10 + (gameState.level * 5);
            scoreCounter.textContent = gameState.score;
            
            // Highlight correct answer
            document.querySelectorAll('.guess-option').forEach(img => {
                img.style.pointerEvents = 'none';
                if (img.src === selected) {
                    img.classList.add('correct');
                }
            });
            
            gameMessage.innerHTML = '<div class="feedback success"><i class="fas fa-check"></i> Correct! +' + (10 + (gameState.level * 5)) + ' points</div>';
            gameMessage.className = 'game-message success';
            
            // Next round after delay
            setTimeout(() => {
                gameState.level++;
                levelCounter.textContent = gameState.level;
                gameMessage.textContent = '';
                
                if (gameState.level > 10) {
                    endGame();
                } else {
                    startNextRound();
                }
            }, 1500);
        } else {
            // Wrong answer
            gameMessage.innerHTML = '<div class="feedback error"><i class="fas fa-times"></i> Wrong! Game Over</div>';
            gameMessage.className = 'game-message error';
            
            document.querySelectorAll('.guess-option').forEach(img => {
                img.style.pointerEvents = 'none';
                if (img.src === gameState.correctAnswer) {
                    img.classList.add('correct');
                } else if (img.src === selected) {
                    img.classList.add('incorrect');
                }
            });
            
            setTimeout(() => {
                endGame();
            }, 2000);
        }
    }

    function startTimer() {
        if (gameState.timerInterval) clearInterval(gameState.timerInterval);
        
        gameState.timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - gameState.startTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            timeCounter.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }, 100);
    }

    function stopTimer() {
        if (gameState.timerInterval) clearInterval(gameState.timerInterval);
    }

    function endGame() {
        gameState.isGameActive = false;
        stopTimer();
        startGameBtn.disabled = false;
        viewPhase.style.display = 'none';
        guessPhase.style.display = 'none';

        const elapsed = Math.floor((Date.now() - gameState.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

        gameMessage.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-trophy"></i>
                <h2>Game Over!</h2>
                <p>Final Score: <strong>${gameState.score}</strong> points</p>
                <p>Reached Level: <strong>${gameState.level}</strong></p>
                <p>Time: ${timeStr}</p>
            </div>
        `;
        gameMessage.className = 'game-message success';
    }

    function resetGame() {
        stopTimer();
        gameState = {
            score: 0,
            level: 1,
            imagesToShow: [],
            currentImage: null,
            currentImageIndex: 0,
            guessOptions: [],
            startTime: null,
            timerInterval: null,
            isGameActive: false,
            correctAnswer: null
        };
        scoreCounter.textContent = '0';
        levelCounter.textContent = '1';
        timeCounter.textContent = '0:00';
        gameMessage.textContent = '';
        gameMessage.className = 'game-message';
        viewPhase.style.display = 'none';
        guessPhase.style.display = 'none';
        imageGrid.innerHTML = '';
        guessGrid.innerHTML = '';
        startGameBtn.disabled = false;
    }

    function shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    // Theme toggle
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const newTheme = isDark ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            document.documentElement.style.colorScheme = newTheme;
            try {
                localStorage.setItem('imgur.theme', newTheme);
            } catch (e) {}
            const icon = themeToggle.querySelector('i');
            icon.className = newTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
        });
    }

    // Fullscreen helpers
    function updateFullscreenIcon() {
        if (!fullscreenBtn) return;
        const icon = fullscreenBtn.querySelector('i');
        if (document.fullscreenElement === flashcardsContainer) {
            fullscreenBtn.classList.add('active');
            flashcardsContainer.classList.add('fullscreen');
            if (icon) icon.className = 'fas fa-compress';
            fullscreenBtn.title = 'Exit fullscreen';
        } else {
            fullscreenBtn.classList.remove('active');
            flashcardsContainer.classList.remove('fullscreen');
            if (icon) icon.className = 'fas fa-expand';
            fullscreenBtn.title = 'Enter fullscreen';
        }
    }

    function enterFullscreen() {
        if (!flashcardsContainer) return;
        if (flashcardsContainer.requestFullscreen) {
            flashcardsContainer.requestFullscreen();
        } else if (flashcardsContainer.webkitRequestFullscreen) {
            flashcardsContainer.webkitRequestFullscreen();
        } else if (flashcardsContainer.msRequestFullscreen) {
            flashcardsContainer.msRequestFullscreen();
        }
    }

    function exitFullscreen() {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
    }
});

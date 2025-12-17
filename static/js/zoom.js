// Zoom Challenge Game Logic
document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startZoomBtn');
    const resetBtn = document.getElementById('resetZoomBtn');
    const backBtn = document.getElementById('backZoomBtn');
    const fullscreenBtn = document.getElementById('fullscreenZoomBtn');
    const scoreEl = document.getElementById('zoomScore');
    const roundEl = document.getElementById('zoomRound');
    const timeEl = document.getElementById('zoomTime');
    const messageEl = document.getElementById('zoomMessage');
    const zoomedImageEl = document.getElementById('zoomedImage');
    const optionsContainer = document.getElementById('zoomOptions');
    const difficultySelect = document.getElementById('zoomDifficulty');
    const optionsSelect = document.getElementById('zoomOptionsSelect');
    const usernameInput = document.getElementById('usernameInput');
    const zoomIndicator = document.getElementById('zoomLevelText');
    const zoomContainer = document.getElementById('zoomContainer');

    let gameState = {
        isGameActive: false,
        score: 0,
        round: 0,
        startTime: null,
        timerInterval: null,
        currentImage: null,
        correctAnswer: null,
        options: []
    };

    const difficultyLevels = {
        'easy': 0.8,
        'medium': 0.5,
        'hard': 0.3,
        'insane': 0.15
    };

    function startTimer() {
        if (gameState.timerInterval) clearInterval(gameState.timerInterval);
        gameState.timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - gameState.startTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            timeEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }, 100);
    }

    function stopTimer() {
        if (gameState.timerInterval) clearInterval(gameState.timerInterval);
    }

    function getZoomedImageData(imageUrl) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = img.width;
                canvas.height = img.height;
                ctx.drawImage(img, 0, 0);

                // Get random crop area (zoom in)
                const zoomLevel = difficultyLevels[difficultySelect.value] || 0.5;
                const cropWidth = img.width * zoomLevel;
                const cropHeight = img.height * zoomLevel;
                const maxX = img.width - cropWidth;
                const maxY = img.height - cropHeight;
                const cropX = Math.random() * maxX;
                const cropY = Math.random() * maxY;

                // Get cropped data
                const imageData = ctx.getImageData(cropX, cropY, cropWidth, cropHeight);
                resolve({
                    imageData: imageData,
                    zoomLevel: Math.round((1 / zoomLevel) * 100),
                    x: cropX,
                    y: cropY,
                    width: cropWidth,
                    height: cropHeight
                });
            };
            img.onerror = () => resolve(null);
            img.src = imageUrl;
        });
    }

    function displayZoomedImage() {
        getZoomedImageData(gameState.currentImage).then((data) => {
            if (!data) {
                messageEl.textContent = 'Failed to load image';
                return;
            }

            // Create canvas and render cropped image
            const canvas = document.createElement('canvas');
            canvas.width = data.imageData.width;
            canvas.height = data.imageData.height;
            const ctx = canvas.getContext('2d');
            ctx.putImageData(data.imageData, 0, 0);

            zoomedImageEl.src = canvas.toDataURL();
            zoomIndicator.textContent = `${data.zoomLevel}%`;
        });
    }

    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function startRound() {
        if (!gameState.isGameActive) return;

        gameState.round++;
        roundEl.textContent = gameState.round;

        // Pick random image as target
        gameState.currentImage = ZOOM_IMAGES[Math.floor(Math.random() * ZOOM_IMAGES.length)];
        gameState.correctAnswer = gameState.currentImage;

        // Generate options
        const numOptions = parseInt(optionsSelect.value, 10) || 4;
        let options = [gameState.correctAnswer];

        // Add random other images
        const otherImages = ZOOM_IMAGES.filter(img => img !== gameState.currentImage);
        while (options.length < numOptions && otherImages.length > 0) {
            const randomImg = otherImages[Math.floor(Math.random() * otherImages.length)];
            if (!options.includes(randomImg)) {
                options.push(randomImg);
            }
        }

        gameState.options = shuffle(options);

        // Display zoomed image
        displayZoomedImage();

        // Display options
        renderOptions();
        messageEl.textContent = 'Which image is this?';
    }

    function renderOptions() {
        optionsContainer.innerHTML = '';
        gameState.options.forEach((imageUrl, idx) => {
            const thumbnail = document.createElement('div');
            thumbnail.className = 'zoom-option-card';
            thumbnail.style.cursor = 'pointer';

            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = `option ${idx + 1}`;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';

            thumbnail.appendChild(img);
            thumbnail.addEventListener('click', () => checkAnswer(imageUrl, thumbnail));

            optionsContainer.appendChild(thumbnail);
        });
    }

    function checkAnswer(selected, element) {
        if (selected === gameState.correctAnswer) {
            // Correct!
            // Base score of 100, multiplied by difficulty level
            const difficultyMultipliers = {
                'easy': 1,
                'medium': 1.5,
                'hard': 2,
                'insane': 3
            };
            const difficulty = difficultySelect.value || 'easy';
            const multiplier = difficultyMultipliers[difficulty] || 1;
            const pointsEarned = Math.floor(100 * multiplier);
            
            gameState.score += pointsEarned;
            scoreEl.textContent = gameState.score;
            element.classList.add('correct');
            messageEl.innerHTML = `<div class="feedback success"><i class="fas fa-check"></i> Correct! +${pointsEarned} points</div>`;
            messageEl.className = 'zoom-message success';

            // Disable all options
            document.querySelectorAll('.zoom-option-card').forEach(card => {
                card.style.pointerEvents = 'none';
            });

            // Next round after delay
            setTimeout(() => {
                messageEl.innerHTML = '';
                messageEl.className = 'zoom-message';
                startRound();
            }, 1000);
        } else {
            // Wrong!
            element.classList.add('incorrect');
            messageEl.innerHTML = '<div class="feedback error"><i class="fas fa-times"></i> Wrong! Game Over</div>';
            messageEl.className = 'zoom-message error';

            // Show correct answer
            document.querySelectorAll('.zoom-option-card').forEach((card, idx) => {
                if (gameState.options[idx] === gameState.correctAnswer) {
                    card.classList.add('correct');
                }
                card.style.pointerEvents = 'none';
            });

            // End game
            setTimeout(() => {
                endGame();
            }, 1500);
        }
    }

    function endGame() {
        gameState.isGameActive = false;
        stopTimer();
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';

        const elapsed = Math.floor((Date.now() - gameState.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;

        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-trophy"></i>
                <h2>Game Over!</h2>
                <p>Final Score: <strong>${gameState.score}</strong> points</p>
                <p>Rounds Completed: <strong>${gameState.round}</strong></p>
                <p>Time: ${minutes}:${seconds.toString().padStart(2, '0')}</p>
            </div>
        `;
        messageEl.className = 'zoom-message';

        // Submit score
        try {
            const username = (usernameInput && usernameInput.value.trim()) || 'Anonymous';
            const payload = {
                collection: CURRENT_COLLECTION,
                gameType: 'zoom',
                score: gameState.score,
                rounds: gameState.round,
                time: elapsed,
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

    function initializeGame() {
        if (ZOOM_IMAGES.length < 2) {
            messageEl.textContent = 'Need at least 2 images to play!';
            messageEl.className = 'zoom-message error';
            return;
        }

        gameState.isGameActive = true;
        gameState.score = 0;
        gameState.round = 0;
        gameState.startTime = Date.now();
        scoreEl.textContent = '0';
        roundEl.textContent = '0';
        messageEl.textContent = '';
        messageEl.className = 'zoom-message';
        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';

        startTimer();
        startRound();
    }

    // Event listeners
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            initializeGame();
        });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            stopTimer();
            gameState = {
                isGameActive: false,
                score: 0,
                round: 0,
                startTime: null,
                timerInterval: null,
                currentImage: null,
                correctAnswer: null,
                options: []
            };
            scoreEl.textContent = '0';
            roundEl.textContent = '0';
            timeEl.textContent = '0:00';
            messageEl.textContent = '';
            messageEl.className = 'zoom-message';
            optionsContainer.innerHTML = '';
            zoomedImageEl.src = '';
            startBtn.style.display = 'inline-block';
            resetBtn.style.display = 'none';
        });
    }

    if (backBtn) {
        backBtn.addEventListener('click', () => {
            window.location.href = `/collection/${CURRENT_COLLECTION}`;
        });
    }

    // Fullscreen functionality
    if (fullscreenBtn && zoomContainer) {
        fullscreenBtn.addEventListener('click', () => {
            zoomContainer.classList.toggle('fullscreen');
            if (zoomContainer.classList.contains('fullscreen')) {
                fullscreenBtn.innerHTML = '<i class="fas fa-compress"></i> Exit Fullscreen';
                fullscreenBtn.classList.add('exit-fullscreen');
                document.body.style.overflow = 'hidden';
            } else {
                fullscreenBtn.innerHTML = '<i class="fas fa-expand"></i> Fullscreen';
                fullscreenBtn.classList.remove('exit-fullscreen');
                document.body.style.overflow = '';
            }
        });

        // Exit fullscreen on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && zoomContainer.classList.contains('fullscreen')) {
                zoomContainer.classList.remove('fullscreen');
                fullscreenBtn.innerHTML = '<i class="fas fa-expand"></i> Fullscreen';
                fullscreenBtn.classList.remove('exit-fullscreen');
                document.body.style.overflow = '';
            }
        });
    }

    // Settings change listeners
    if (difficultySelect) {
        difficultySelect.addEventListener('change', () => {
            if (gameState.isGameActive) {
                // Refresh current zoomed image with new difficulty
                displayZoomedImage();
            }
        });
    }
});

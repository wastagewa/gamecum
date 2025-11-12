// puzzle.js - Jigsaw Puzzle Game with Canvas-Based Interlocking Pieces
(function () {
    const puzzleBoard = document.getElementById('puzzleBoard');
    const piecesStash = document.getElementById('piecesStash');
    const scoreEl = document.getElementById('score');
    const peeksEl = document.getElementById('peeks');
    const timeEl = document.getElementById('time');
    const pieceCountInput = document.getElementById('pieceCount');
    const newImageBtn = document.getElementById('newImage');
    const showPreviewBtn = document.getElementById('showPreview');
    const previewImage = document.getElementById('previewImage');
    const previewModal = document.getElementById('previewModal');
    const previewTimer = document.getElementById('previewTimer');
    const winMessage = document.getElementById('winMessage');
    const finalScore = document.getElementById('finalScore');
    const finalTime = document.getElementById('finalTime');
    const finalPieces = document.getElementById('finalPieces');
    const playAgain = document.getElementById('playAgain');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const victoryModal = document.getElementById('victoryModal');
    const victoryImage = document.getElementById('victoryImage');
    const victoryScore = document.getElementById('victoryScore');
    const victoryTime = document.getElementById('victoryTime');
    const victoryPieces = document.getElementById('victoryPieces');
    const victoryPlayAgain = document.getElementById('victoryPlayAgain');

    let pieceCount = 16;
    let gridCols = 4;
    let gridRows = 4;
    let boardSlots = [];
    let stashPieces = [];
    let score = 1000;
    let peeks = 0;
    let seconds = 0;
    let timer = null;
    let currentImage = '';
    let isSolved = false;
    let draggedPiece = null;
    let previewTimerInterval = null;
    let pieceRotations = {}; // Store rotation angle for each piece (pieceId: angle)

    function startTimer() {
        if (timer) return;
        timer = setInterval(() => {
            seconds++;
            timeEl.textContent = `${seconds}s`;
            // Reduce score slowly over time (1 point per 2 seconds)
            if (seconds % 2 === 0 && score > 0) {
                score = Math.max(0, score - 1);
                scoreEl.textContent = score;
            }
        }, 1000);
    }

    function stopTimer() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    function resetStats() {
        seconds = 0;
        peeks = 0;
        score = pieceCount * 50; // More pieces = higher starting score
        timeEl.textContent = '0s';
        scoreEl.textContent = score;
        peeksEl.textContent = '0';
        stopTimer();
        isSolved = false;
        winMessage.style.display = 'none';
    }

    function shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    function calculateGrid(numPieces) {
        // Calculate closest grid dimensions for given number of pieces
        const sqrt = Math.sqrt(numPieces);
        gridRows = Math.round(sqrt);
        gridCols = Math.ceil(numPieces / gridRows);
        
        // Adjust if necessary
        while (gridRows * gridCols < numPieces) {
            gridCols++;
        }
        
        return { rows: gridRows, cols: gridCols };
    }

    function isSolvable(puzzle, size) {
        // Count inversions
        let inversions = 0;
        const flatPuzzle = puzzle.filter(x => x !== size * size - 1);
        
        for (let i = 0; i < flatPuzzle.length; i++) {
            for (let j = i + 1; j < flatPuzzle.length; j++) {
                if (flatPuzzle[i] > flatPuzzle[j]) {
                    inversions++;
                }
            }
        }

        // For odd grid size, puzzle is solvable if inversions is even
        if (size % 2 === 1) {
            return inversions % 2 === 0;
        } else {
            // For even grid size, also consider row of empty tile
            const emptyRow = Math.floor(puzzle.indexOf(size * size - 1) / size);
            return (inversions + emptyRow) % 2 === 1;
        }
    }

    function generatePuzzle(numPieces) {
        calculateGrid(numPieces);
        
        // Initialize board slots (empty)
        boardSlots = Array(numPieces).fill(null);
        
        // Create shuffled pieces for stash with random rotations
        const pieces = Array.from({ length: numPieces }, (_, i) => i);
        shuffle(pieces);
        stashPieces = pieces;
        
        // Assign random rotation to each piece (0, 90, 180, 270 degrees)
        pieceRotations = {};
        for (let i = 0; i < numPieces; i++) {
            const rotations = [0, 90, 180, 270];
            pieceRotations[i] = rotations[Math.floor(Math.random() * rotations.length)];
        }
        
        return { boardSlots, stashPieces };
    }

    function checkSolved() {
        // Check if all board slots are filled with correct pieces AND correctly rotated (0 degrees)
        return boardSlots.every((piece, idx) => piece === idx && pieceRotations[piece] === 0);
    }

    function handleDragStart(e, pieceData) {
        if (isSolved) return;
        
        draggedPiece = pieceData;
        e.target.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify(pieceData));
        
        startTimer();
    }

    function handleDragEnd(e) {
        e.target.style.opacity = '1';
        draggedPiece = null;
    }

    function handleDragOver(e) {
        if (e.preventDefault) {
            e.preventDefault();
        }
        e.dataTransfer.dropEffect = 'move';
        return false;
    }

    function handleDragEnter(e) {
        const slot = e.target.closest('.puzzle-slot');
        if (slot) {
            slot.classList.add('puzzle-slot-drag-over');
        }
    }

    function handleDragLeave(e) {
        const slot = e.target.closest('.puzzle-slot');
        if (slot) {
            slot.classList.remove('puzzle-slot-drag-over');
        }
    }

    function handleDropOnBoard(e, slotIndex) {
        if (e.stopPropagation) {
            e.stopPropagation();
        }
        e.preventDefault();

        const slot = e.target.closest('.puzzle-slot');
        if (slot) {
            slot.classList.remove('puzzle-slot-drag-over');
        }

        if (!draggedPiece) return;

        // Place piece in board slot
        if (draggedPiece.source === 'stash') {
            // From stash to board - check if slot is occupied
            if (boardSlots[slotIndex] !== null) {
                // Return existing piece to stash
                stashPieces.push(boardSlots[slotIndex]);
            }
            boardSlots[slotIndex] = draggedPiece.pieceId;
            stashPieces = stashPieces.filter(id => id !== draggedPiece.pieceId);
        } else if (draggedPiece.source === 'board') {
            // Moving from one board position to another
            const temp = boardSlots[slotIndex];
            boardSlots[slotIndex] = draggedPiece.pieceId;
            boardSlots[draggedPiece.fromIndex] = temp; // Can be null
        }
        
        renderBoard();
        renderStash();
        
        if (checkSolved()) {
            handleWin();
        }

        return false;
    }

    function handleDropOnStash(e) {
        if (e.stopPropagation) {
            e.stopPropagation();
        }
        e.preventDefault();

        if (!draggedPiece || draggedPiece.source !== 'board') return;

        // Return piece from board to stash
        stashPieces.push(draggedPiece.pieceId);
        boardSlots[draggedPiece.fromIndex] = null;
        
        renderBoard();
        renderStash();

        return false;
    }

    // Store edge definitions globally
    let edgeDefinitions = {
        horizontal: {},
        vertical: {}
    };

    // No jigsaw shapes needed - pieces are simple squares that rotate

    function createJigsawPiece(pieceId, isDraggable = true, inBoard = false) {
        const piece = document.createElement('div');
        piece.className = 'jigsaw-piece';
        piece.draggable = isDraggable && !isSolved;
        piece.dataset.pieceId = pieceId;
        
        // Calculate position in original image
        const row = Math.floor(pieceId / gridCols);
        const col = pieceId % gridCols;
        
        // Use exact percentage positioning for crisp alignment
        const bgPosX = gridCols > 1 ? (col * 100) / (gridCols - 1) : 50;
        const bgPosY = gridRows > 1 ? (row * 100) / (gridRows - 1) : 50;

        piece.style.backgroundImage = `url('${currentImage}')`;
        piece.style.backgroundSize = `${gridCols * 100}% ${gridRows * 100}%`;
        piece.style.backgroundPosition = `${bgPosX}% ${bgPosY}%`;

        // Apply rotation
        const rotation = pieceRotations[pieceId] || 0;
        piece.style.transform = `rotate(${rotation}deg)`;
        piece.dataset.rotation = rotation;

        // If in board, make piece fill the slot completely
        if (inBoard) {
            piece.style.width = '100%';
            piece.style.height = '100%';
        }

        // Add click handler for rotation
        piece.addEventListener('click', (e) => {
            if (!isSolved) {
                e.stopPropagation();
                rotatePiece(pieceId);
            }
        });
        
        return piece;
    }

    function rotatePiece(pieceId) {
        // Rotate by 90 degrees clockwise
        pieceRotations[pieceId] = (pieceRotations[pieceId] + 90) % 360;
        
        // Re-render to apply rotation
        renderBoard();
        renderStash();
        
        // Check if puzzle is solved after rotation
        if (checkSolved()) {
            handleWin();
        }
    }

    function renderBoard() {
        puzzleBoard.innerHTML = '';
        puzzleBoard.style.gridTemplateColumns = `repeat(${gridCols}, 1fr)`;
        puzzleBoard.style.gridTemplateRows = `repeat(${gridRows}, 1fr)`;

        boardSlots.forEach((pieceId, slotIndex) => {
            const slot = document.createElement('div');
            slot.className = 'puzzle-slot';
            
            if (pieceId !== null) {
                const piece = createJigsawPiece(pieceId, true, true);
                piece.addEventListener('dragstart', (e) => handleDragStart(e, { 
                    pieceId, 
                    source: 'board',
                    fromIndex: slotIndex 
                }));
                piece.addEventListener('dragend', handleDragEnd);
                slot.appendChild(piece);
            } else {
                slot.innerHTML = '<div class="slot-placeholder"></div>';
            }

            slot.addEventListener('dragover', handleDragOver);
            slot.addEventListener('dragenter', handleDragEnter);
            slot.addEventListener('dragleave', handleDragLeave);
            slot.addEventListener('drop', (e) => handleDropOnBoard(e, slotIndex));

            puzzleBoard.appendChild(slot);
        });
    }

    function renderStash() {
        piecesStash.innerHTML = '';
        
        if (stashPieces.length === 0) {
            piecesStash.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted-text);">All pieces placed!</div>';
            return;
        }

        stashPieces.forEach(pieceId => {
            const piece = createJigsawPiece(pieceId, true, false);
            piece.addEventListener('dragstart', (e) => handleDragStart(e, { 
                pieceId, 
                source: 'stash' 
            }));
            piece.addEventListener('dragend', handleDragEnd);
            piecesStash.appendChild(piece);
        });

        // Make stash a drop zone to return pieces
        piecesStash.addEventListener('dragover', handleDragOver);
        piecesStash.addEventListener('drop', handleDropOnStash);
    }

    function handleWin() {
        isSolved = true;
        stopTimer();
        
        // Update old win message (kept for compatibility)
        winMessage.style.display = 'block';
        finalScore.textContent = score;
        finalTime.textContent = `${seconds}s`;
        finalPieces.textContent = pieceCount;

        // Show victory modal with complete image after brief delay
        setTimeout(() => {
            victoryImage.src = currentImage;
            victoryScore.textContent = score;
            victoryTime.textContent = `${seconds}s`;
            victoryPieces.textContent = pieceCount;
            victoryModal.style.display = 'flex';
            
            // Exit fullscreen if in fullscreen mode
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
        }, 800);

        // Celebration animation on board
        puzzleBoard.style.filter = 'brightness(1.2)';
        puzzleBoard.style.transform = 'scale(1.02)';
        puzzleBoard.style.transition = 'all 0.3s ease';
        setTimeout(() => {
            puzzleBoard.style.filter = '';
            puzzleBoard.style.transform = '';
        }, 1000);
    }

    function showPreviewModal() {
        if (isSolved) return;
        
        // Reduce score
        score = Math.max(0, score - 50);
        scoreEl.textContent = score;
        peeks++;
        peeksEl.textContent = peeks;
        
        // Show modal with countdown
        previewImage.src = currentImage;
        previewModal.style.display = 'flex';
        
        let countdown = 5;
        previewTimer.textContent = countdown;
        
        if (previewTimerInterval) clearInterval(previewTimerInterval);
        
        previewTimerInterval = setInterval(() => {
            countdown--;
            previewTimer.textContent = countdown;
            
            if (countdown <= 0) {
                clearInterval(previewTimerInterval);
                previewModal.style.display = 'none';
            }
        }, 1000);
    }

    function initPuzzle(image) {
        currentImage = image;
        pieceCount = parseInt(pieceCountInput.value) || 16;
        pieceCount = Math.max(9, Math.min(100, pieceCount));
        pieceCountInput.value = pieceCount;
        
        resetStats();
        generatePuzzle(pieceCount);
        renderBoard();
        renderStash();
    }

    function selectRandomImage() {
        if (!SERVER_IMAGES || SERVER_IMAGES.length === 0) {
            puzzleBoard.innerHTML = '<p style="text-align:center;padding:40px;color:var(--muted-text);">No images available. Please upload some images first.</p>';
            return;
        }
        const randomImage = SERVER_IMAGES[Math.floor(Math.random() * SERVER_IMAGES.length)];
        initPuzzle(randomImage);
    }

    // Event Listeners
    pieceCountInput.addEventListener('change', () => {
        const val = parseInt(pieceCountInput.value) || 16;
        pieceCountInput.value = Math.max(9, Math.min(100, val));
        // Restart puzzle with new piece count
        if (currentImage) {
            initPuzzle(currentImage);
        }
    });

    newImageBtn.addEventListener('click', selectRandomImage);

    playAgain.addEventListener('click', selectRandomImage);

    victoryPlayAgain.addEventListener('click', () => {
        victoryModal.style.display = 'none';
        selectRandomImage();
    });

    // Close victory modal on background click
    victoryModal.addEventListener('click', (e) => {
        if (e.target === victoryModal) {
            victoryModal.style.display = 'none';
        }
    });

    showPreviewBtn.addEventListener('click', showPreviewModal);

    // Close preview modal on click
    previewModal.addEventListener('click', () => {
        if (previewTimerInterval) {
            clearInterval(previewTimerInterval);
        }
        previewModal.style.display = 'none';
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (isSolved) return;

        if (e.key.toLowerCase() === 'n' && !e.target.matches('input')) {
            e.preventDefault();
            selectRandomImage();
        }
        
        if (e.key.toLowerCase() === 'p' && !e.target.matches('input')) {
            e.preventDefault();
            showPreviewModal();
        }
    });

    // Fullscreen toggle
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(err => console.warn('Fullscreen request failed', err));
            } else {
                document.exitFullscreen().catch(err => console.warn('Exit fullscreen failed', err));
            }
        });
    }

    // Update button icon when entering/exiting fullscreen
    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) {
            document.body.classList.add('game-fullscreen');
            if (fullscreenBtn) {
                fullscreenBtn.innerHTML = '<i class="fas fa-compress"></i> Exit Fullscreen';
            }
        } else {
            document.body.classList.remove('game-fullscreen');
            if (fullscreenBtn) {
                fullscreenBtn.innerHTML = '<i class="fas fa-expand"></i> Fullscreen';
            }
        }
    });

    // Initialize game on page load
    if (SERVER_IMAGES && SERVER_IMAGES.length > 0) {
        selectRandomImage();
    } else {
        puzzleBoard.innerHTML = '<p style="text-align:center;padding:40px;color:var(--muted-text);">No images available. Please upload some images first.</p>';
    }
})();

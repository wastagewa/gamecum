// Games Modal Functionality
document.addEventListener('DOMContentLoaded', () => {
    const gamesMenuBtn = document.getElementById('gamesMenuBtn');
    const gamesModal = document.getElementById('gamesModal');
    const gamesModalClose = document.getElementById('gamesModalClose');
    const gamesGrid = document.getElementById('gamesGrid');
    const CURRENT_COLLECTION = window.CURRENT_COLLECTION || "Real";

    const games = [
        {
            name: 'Memory Game',
            icon: 'fa-gamepad',
            description: 'Classic memory card matching game',
            url: `/collection/${CURRENT_COLLECTION}/game`
        },
        {
            name: 'Jigsaw Puzzle',
            icon: 'fa-puzzle-piece',
            description: 'Piece together jigsaw puzzles',
            url: `/collection/${CURRENT_COLLECTION}/puzzle`
        },
        {
            name: 'Sequence Memory',
            icon: 'fa-brain',
            description: 'Remember and repeat sequences',
            url: `/collection/${CURRENT_COLLECTION}/sequence`
        },
        {
            name: 'Flash Cards',
            icon: 'fa-images',
            description: 'Study with animated flash cards',
            url: `/collection/${CURRENT_COLLECTION}/flashcards`
        },
        {
            name: 'Image Hunt',
            icon: 'fa-search',
            description: 'Find specific images quickly',
            url: `/collection/${CURRENT_COLLECTION}/hunt`
        },
        {
            name: 'Zoom Challenge',
            icon: 'fa-search-plus',
            description: 'Identify zoomed-in image portions',
            url: `/collection/${CURRENT_COLLECTION}/zoom`
        },
        {
            name: 'Whack-a-Mole',
            icon: 'fa-hammer',
            description: 'Click images as they appear on screen',
            url: `/collection/${CURRENT_COLLECTION}/whack`
        },
        {
            name: 'Character Chat',
            icon: 'fa-comments',
            description: 'Chat with AI-powered characters',
            url: `/collection/${CURRENT_COLLECTION}/chatbot`
        }
    ];

    if (gamesMenuBtn && gamesModal) {
        gamesMenuBtn.addEventListener('click', () => {
            gamesGrid.innerHTML = '';
            games.forEach(game => {
                const gameCard = document.createElement('a');
                gameCard.href = game.url;
                gameCard.className = 'game-card';
                gameCard.innerHTML = `
                    <div class="game-card-icon">
                        <i class="fas ${game.icon}"></i>
                    </div>
                    <h3>${game.name}</h3>
                    <p>${game.description}</p>
                `;
                gamesGrid.appendChild(gameCard);
            });
            gamesModal.classList.add('active');
        });

        gamesModalClose.addEventListener('click', () => {
            gamesModal.classList.remove('active');
        });

        gamesModal.addEventListener('click', (e) => {
            if (e.target === gamesModal) {
                gamesModal.classList.remove('active');
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && gamesModal.classList.contains('active')) {
                gamesModal.classList.remove('active');
            }
        });
    }
});

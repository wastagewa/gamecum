// Games Modal Functionality
document.addEventListener('DOMContentLoaded', () => {
    const gamesMenuBtn = document.getElementById('gamesMenuBtn');
    const gamesModal = document.getElementById('gamesModal');
    const gamesModalClose = document.getElementById('gamesModalClose');
    const gamesGrid = document.getElementById('gamesGrid');
    // Read the collection name injected by the template:
    //   <script>const CURRENT_COLLECTION = "{{ collection }}";</script>
    // `const` at script-tag level is NOT a window property, so
    // window.CURRENT_COLLECTION is always undefined — reference it directly.
    const _coll = (typeof CURRENT_COLLECTION !== 'undefined' ? CURRENT_COLLECTION : '') || 'Real';

    const games = [
        {
            name: 'Memory Game',
            icon: 'fa-gamepad',
            description: 'Classic memory card matching game',
            url: `/collection/${_coll}/game`
        },
        {
            name: 'Jigsaw Puzzle',
            icon: 'fa-puzzle-piece',
            description: 'Piece together jigsaw puzzles',
            url: `/collection/${_coll}/puzzle`
        },
        {
            name: 'Sequence Memory',
            icon: 'fa-brain',
            description: 'Remember and repeat sequences',
            url: `/collection/${_coll}/sequence`
        },
        {
            name: 'Flash Cards',
            icon: 'fa-images',
            description: 'Study with animated flash cards',
            url: `/collection/${_coll}/flashcards`
        },
        {
            name: 'Image Hunt',
            icon: 'fa-search',
            description: 'Find specific images quickly',
            url: `/collection/${_coll}/hunt`
        },
        {
            name: 'Zoom Challenge',
            icon: 'fa-search-plus',
            description: 'Identify zoomed-in image portions',
            url: `/collection/${_coll}/zoom`
        },
        {
            name: 'Whack-a-Mole',
            icon: 'fa-hammer',
            description: 'Click images as they appear on screen',
            url: `/collection/${_coll}/whack`
        },
        {
            name: 'Recall Grid',
            icon: 'fa-location-dot',
            description: 'Memorize where each image was placed',
            url: `/collection/${_coll}/recall`
        },
        {
            name: 'Missing Piece',
            icon: 'fa-eye-slash',
            description: 'Spot which image disappeared from the grid',
            url: `/collection/${_coll}/missing`
        },
        {
            name: 'Trail Trace',
            icon: 'fa-route',
            description: 'Memorize the image grid, then follow a logic path',
            url: `/collection/${_coll}/trail`
        },
        {
            name: 'Remix Match',
            icon: 'fa-wand-magic-sparkles',
            description: 'Match the target image to its remixed visual clone',
            url: `/collection/${_coll}/remix`
        },
        {
            name: 'Tag Match',
            icon: 'fa-tag',
            description: 'Match tag cards with images containing those tags',
            url: `/collection/${_coll}/tag-match`
        },
        {
            name: 'Chat',
            icon: 'fa-comment-dots',
            description: 'Pick an image, bring the character to life, and chat with them!',
            url: `/collection/${_coll}/chat`
        },
        {
            name: 'Spotlight',
            icon: 'fa-circle-dot',
            description: 'A tiny peephole drifts across a hidden image — name it before it\'s fully exposed!',
            url: `/collection/${_coll}/spotlight`
        },
        {
            name: 'Flash Memory',
            icon: 'fa-bolt',
            description: 'Image flashes on screen for a shrinking window of time — pick it from the lineup!',
            url: `/collection/${_coll}/flashmemory`
        },
        {
            name: 'Who\'s That?',
            icon: 'fa-masks-theater',
            description: 'Tags shown, no image — find which one in the lineup has ALL those tags!',
            url: `/collection/${_coll}/whoisthat`
        },
        {
            name: 'Odd One Out',
            icon: 'fa-question-circle',
            description: 'Three images share a hidden tag — find the one that doesn\'t!',
            url: `/collection/${_coll}/oddoneout`
        },
        {
            name: 'Speed Sort',
            icon: 'fa-bolt',
            description: 'Tag appears — quickly sort each image as YES or NO before time runs out!',
            url: `/collection/${_coll}/speedsort`
        },
        {
            name: 'Snap Match',
            icon: 'fa-camera-retro',
            description: 'Two images flash up — do they share a tag? React fast!',
            url: `/collection/${_coll}/snap`
        },
        {
            name: 'Hot Bracket',
            icon: 'fa-fire',
            description: 'Two images face off — click your favourite to vote. Crown the champion!',
            url: `/collection/${_coll}/bracket`
        },
        {
            name: 'Scratch Card',
            icon: 'fa-hand-sparkles',
            description: 'Drag to scratch away tiles and reveal the hidden image — then guess!',
            url: `/collection/${_coll}/scratch`
        },
        {
            name: 'Behind the Blur',
            icon: 'fa-eye',
            description: 'The image clears slowly — identify it before the fog lifts completely!',
            url: `/collection/${_coll}/behindblur`
        },
        {
            name: 'Silhouette Strike',
            icon: 'fa-user-secret',
            description: 'A black shadow bleeds to colour over time — name it before the full reveal!',
            url: `/collection/${_coll}/silhouette`
        },
        {
            name: 'Tower Defense',
            icon: 'fa-shield-heart',
            description: 'Images march across the belt — click to save your favourites before they scroll away!',
            url: `/collection/${_coll}/towerdefense`
        },
        {
            name: '3D Shooting Gallery',
            icon: 'fa-crosshairs',
            description: 'A real 3D fairground shooting range — targets slide and pop behind barriers. Shoot the target, dodge the decoys!',
            url: `/collection/${_coll}/shootinggallery`
        },
        {
            name: 'Orbiting Vault',
            icon: 'fa-dharmachakra',
            description: 'Framed images orbit on a rotating 3D vault ring — click the one matching the target before it swings out of view!',
            url: `/collection/${_coll}/orbitingvault`
        },
        {
            name: 'Zero-Gravity Cargo Bay',
            icon: 'fa-satellite',
            description: 'Image-pods drift freely through a zero-G cargo bay — tractor-beam the right one before it floats into the airlock!',
            url: `/collection/${_coll}/cargobay`
        },
        {
            name: 'Time-Loop Detective',
            icon: 'fa-clock-rotate-left',
            description: 'A noir room loops on a 24s tape — scrub the timeline to catch the suspect photo in the right frame at the right moment!',
            url: `/collection/${_coll}/timeloop`
        },
        {
            name: 'Gallery Heist Drone',
            icon: 'fa-helicopter',
            description: 'Free-fly a drone through a mansion of paintings — dodge the sweeping spotlights and scan the right one in each room!',
            url: `/collection/${_coll}/heistdrone`
        },
        {
            name: 'Bubble Burst',
            icon: 'fa-soap',
            description: 'Bubbles float up from the dark — pop every one containing the target image, dodge the decoys!',
            url: `/collection/${_coll}/bubbleburst`
        },
        {
            name: 'Image Pong',
            icon: 'fa-table-tennis-paddle-ball',
            description: 'Break tiles with a paddle and ball to reveal the hidden image — guess it fast for bonus points!',
            url: `/collection/${_coll}/breakout`
        },
        {
            name: 'Heat Map',
            icon: 'fa-fire',
            description: 'Hold and drag to paint what draws your eye — see your attention as a glowing heat map!',
            url: `/collection/${_coll}/heatmap`
        },
        {
            name: 'Gallery Walk',
            icon: 'fa-archway',
            description: 'Stroll through a private art gallery of your collection. Click any painting to examine it up close.',
            url: `/collection/${_coll}/gallerywalk`
        },

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

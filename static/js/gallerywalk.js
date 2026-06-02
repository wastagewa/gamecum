/**
 * Gallery Walk
 *
 * A coverflow-style virtual art gallery. Images are shown as paintings
 * in ornate gold frames inside a dark atmospheric gallery room.
 *
 * Navigation: ← → arrow keys, A/D, or the on-screen arrows.
 * Examine: click the front-most frame (or press Enter/Space) to open
 *          a fullscreen close-up with tags shown as a placard.
 * Close examine: Escape or "Step Back" button.
 *
 * Score = unique paintings examined × 50 (submitted as 'gallerywalk').
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const container     = document.getElementById('gwContainer');
    const sceneEl       = document.getElementById('gwScene');
    const galleryEl     = document.getElementById('gwGallery');
    const spotlightEl   = document.getElementById('gwSpotlight');
    const prevBtn       = document.getElementById('gwPrev');
    const nextBtn       = document.getElementById('gwNext');
    const counterEl     = document.getElementById('gwCounter');
    const hintEl        = document.getElementById('gwHint');
    const lobbyEl       = document.getElementById('gwLobby');
    const startBtn      = document.getElementById('startGwBtn');
    const placardEl     = document.getElementById('gwPlacard');
    const placardBgEl   = document.getElementById('gwPlacardBg');
    const placardImgEl  = document.getElementById('gwPlacardImg');
    const placardNumEl  = document.getElementById('gwPlacardNum');
    const placardTagsEl = document.getElementById('gwPlacardTags');
    const placardCloseBtn = document.getElementById('gwPlacardClose');
    const fsBtn         = document.getElementById('fullscreenGwBtn');
    const exitBtn       = document.getElementById('exitGwBtn');
    const backBtn       = document.getElementById('backGwBtn');
    const usernameInput = document.getElementById('gwUsername');
    const examinedEl    = document.getElementById('gwExamined');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    // ── Data ──────────────────────────────────────────────────────────────────
    let allImages = [];

    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('GalleryWalk: load error', e); }
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let currentIdx    = 0;
    let frames        = [];          // { el, imgObj }
    let isActive      = false;
    let isExamining   = false;
    let examined      = new Set();   // indices of images opened in examine view
    let startTime     = null;
    let navLocked     = false;       // brief lock during CSS transition

    // ── Position config ───────────────────────────────────────────────────────
    // Key = absolute distance from current image (0, 1, 2, 3, 4+)
    // xPct is % of the frame's own width added to the base center offset
    const DIST_CONFIG = [
        { xPct:   0, scale: 1.00, opacity: 1.0,  zIdx: 5 }, // 0 – current
        { xPct: 115, scale: 0.64, opacity: 0.85, zIdx: 4 }, // 1
        { xPct: 210, scale: 0.40, opacity: 0.55, zIdx: 3 }, // 2
        { xPct: 285, scale: 0.25, opacity: 0.28, zIdx: 2 }, // 3
        { xPct: 340, scale: 0.16, opacity: 0,    zIdx: 1 }, // 4+
    ];

    function getConfig(absDist) {
        return DIST_CONFIG[Math.min(absDist, DIST_CONFIG.length - 1)];
    }

    // ── Build gallery ─────────────────────────────────────────────────────────
    function buildGallery() {
        galleryEl.innerHTML = '';
        frames = [];

        allImages.forEach((imgObj, i) => {
            const frame = document.createElement('div');
            frame.className = 'gw-frame';

            const inner = document.createElement('div');
            inner.className = 'gw-frame-inner';

            const img = document.createElement('img');
            img.src      = imgObj.url;
            img.alt      = '';
            img.draggable = false;

            const num = document.createElement('div');
            num.className   = 'gw-frame-num';
            num.textContent = i + 1;

            inner.appendChild(img);
            frame.appendChild(inner);
            frame.appendChild(num);

            frame.addEventListener('click', () => onFrameClick(i));

            galleryEl.appendChild(frame);
            frames.push({ el: frame, imgObj });
        });

        applyAllPositions(false);
    }

    // ── Position updates ──────────────────────────────────────────────────────
    function applyAllPositions(animate) {
        frames.forEach(({ el }, i) => {
            const relDist = i - currentIdx;
            const absDist = Math.abs(relDist);
            const sign    = relDist >= 0 ? 1 : -1;
            const cfg     = getConfig(absDist);

            el.style.transition = animate
                ? 'transform 0.42s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.42s ease'
                : 'none';

            // translateX(-50%) centers the frame, then shift by sign × xPct% of its own width
            el.style.transform = `translateX(calc(-50% + ${sign * cfg.xPct}%)) translateY(-50%) scale(${cfg.scale})`;
            el.style.opacity   = cfg.opacity;
            el.style.zIndex    = cfg.zIdx;

            if (i === currentIdx) {
                el.classList.add('gw-frame--current');
            } else {
                el.classList.remove('gw-frame--current');
            }
        });

        counterEl.textContent = `${currentIdx + 1} / ${allImages.length}`;
    }

    // ── Navigation ────────────────────────────────────────────────────────────
    function navigate(delta) {
        if (!isActive || isExamining || navLocked) return;
        const next = currentIdx + delta;
        if (next < 0 || next >= allImages.length) return;
        currentIdx = next;
        navLocked  = true;
        applyAllPositions(true);
        // Update prev/next button disabled state
        prevBtn.disabled = currentIdx === 0;
        nextBtn.disabled = currentIdx === allImages.length - 1;
        setTimeout(() => { navLocked = false; }, 440);
    }

    function onFrameClick(i) {
        if (!isActive || isExamining) return;
        if (i === currentIdx) {
            openExamine(i);
        } else {
            // Jump to clicked frame
            currentIdx = i;
            applyAllPositions(true);
            prevBtn.disabled = currentIdx === 0;
            nextBtn.disabled = currentIdx === allImages.length - 1;
        }
    }

    // ── Examine (placard) ─────────────────────────────────────────────────────
    function openExamine(i) {
        if (isExamining) return;
        isExamining = true;

        const { imgObj } = frames[i];
        examined.add(i);
        examinedEl.textContent = examined.size;

        placardImgEl.src       = imgObj.url;
        placardNumEl.textContent = `Painting #${i + 1}`;
        const tags = imgObj.tags || [];
        placardTagsEl.textContent = tags.length > 0 ? tags.join('  ·  ') : 'No tags';

        // Blur the blurred background
        placardBgEl.style.backgroundImage = `url(${imgObj.url})`;

        placardEl.classList.add('gw-placard--active');
        frames[i].el.classList.add('gw-frame--examining');
    }

    function closeExamine() {
        if (!isExamining) return;
        isExamining = false;
        placardEl.classList.remove('gw-placard--active');
        frames[currentIdx]?.el.classList.remove('gw-frame--examining');
    }

    // ── Keyboard ──────────────────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (!isActive) return;

        if (isExamining) {
            if (e.key === 'Escape') closeExamine();
            return;
        }

        switch (e.key) {
            case 'ArrowLeft':  case 'a': case 'A': navigate(-1); break;
            case 'ArrowRight': case 'd': case 'D': navigate( 1); break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                openExamine(currentIdx);
                break;
            case 'Escape':
                exitGallery();
                break;
        }
    });

    // ── Touch swipe ───────────────────────────────────────────────────────────
    let touchStartX = null;
    sceneEl.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
    sceneEl.addEventListener('touchend',   (e) => {
        if (touchStartX === null) return;
        const dx = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(dx) > 40) navigate(dx < 0 ? 1 : -1);
        touchStartX = null;
    });

    // ── Enter / Exit gallery ──────────────────────────────────────────────────
    function enterGallery() {
        if (allImages.length < 1) return;
        isActive   = true;
        currentIdx = 0;
        examined   = new Set();
        startTime  = Date.now();
        examinedEl.textContent = '0';

        buildGallery();
        lobbyEl.classList.add('gw-lobby--hidden');
        prevBtn.style.display   = 'flex';
        nextBtn.style.display   = 'flex';
        counterEl.style.display = 'block';
        hintEl.style.display    = 'flex';
        exitBtn.style.display   = 'inline-block';

        prevBtn.disabled = true;
        nextBtn.disabled = allImages.length <= 1;
    }

    function exitGallery() {
        if (!isActive) return;
        closeExamine();
        isActive = false;

        // Submit score
        const score   = examined.size * 50;
        const elapsed = Math.floor((Date.now() - (startTime || Date.now())) / 1000);
        const user    = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType:   'gallerywalk',
                score,
                time:       elapsed,
                username:   user,
            })
        }).catch(() => {});

        // Reset to lobby
        galleryEl.innerHTML     = '';
        frames                  = [];
        lobbyEl.classList.remove('gw-lobby--hidden');
        prevBtn.style.display   = 'none';
        nextBtn.style.display   = 'none';
        counterEl.style.display = 'none';
        hintEl.style.display    = 'none';
        exitBtn.style.display   = 'none';
    }

    // ── Fullscreen ────────────────────────────────────────────────────────────
    if (fsBtn) {
        fsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                container.requestFullscreen().catch(e => console.warn(e));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === container;
            fsBtn.innerHTML = isFS
                ? '<i class="fas fa-compress"></i> Exit Fullscreen'
                : '<i class="fas fa-expand"></i> Fullscreen';
        });
    }

    // ── Wiring ────────────────────────────────────────────────────────────────
    startBtn.addEventListener('click',      enterGallery);
    exitBtn.addEventListener('click',       exitGallery);
    prevBtn.addEventListener('click',       () => navigate(-1));
    nextBtn.addEventListener('click',       () => navigate(1));
    placardCloseBtn.addEventListener('click', closeExamine);
    placardBgEl.addEventListener('click',   closeExamine);
    backBtn.addEventListener('click', () => {
        exitGallery();
        if (document.fullscreenElement) document.exitFullscreen();
        window.location.href = `/collection/${COLLECTION}`;
    });

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    await loadImages();
    if (allImages.length < 1) {
        lobbyEl.querySelector('.gw-lobby-sub').textContent = 'No images found in this collection.';
        startBtn.disabled = true;
    }
});

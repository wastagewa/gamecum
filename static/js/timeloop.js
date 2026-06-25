/**
 * Time-Loop Detective — Three.js r134
 *
 * A noir study where 6 picture frames each cycle through 2–3 photos on a
 * fixed, repeating loop (24s). Every frame's schedule is generated once at
 * round start and stays stable for the whole game — like reviewing the same
 * security tape over and over, just hunting a different photo each round.
 *   • The HUD shows a target ("suspect") photo. Scrub the tape (or let it
 *     play live) to find which frame shows it and during which window, then
 *     click that frame while it's actually displaying it.
 *       Correct frame+moment → +pts (combo-scaled), new suspect picked.
 *       Wrong frame/moment    → −pts, −1 life, combo resets.
 *   • The frames are static — no aiming skill, just investigation. The tape
 *     keeps playing live in the background even while you scrub a preview.
 *   • 3 lives. The round is untimed — it only ends after 3 mistakes.
 *
 * gameType: 'timeloop'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    if (typeof THREE === 'undefined') {
        console.error('Three.js failed to load — check CDN link.');
        return;
    }

    /* ── DOM ────────────────────────────────────────────────────────── */
    const tlContainer   = document.getElementById('tlContainer');
    const canvasWrap     = document.getElementById('tlCanvasWrap');
    const startBtn        = document.getElementById('startTlBtn');
    const resetBtn        = document.getElementById('resetTlBtn');
    const fsBtn            = document.getElementById('fullscreenTlBtn');
    const backBtn         = document.getElementById('backTlBtn');
    const scoreEl           = document.getElementById('tlScore');
    const timerEl           = document.getElementById('tlTimer');
    const livesEl           = document.getElementById('tlLives');
    const comboEl           = document.getElementById('tlCombo');
    const messageEl       = document.getElementById('tlMessage');
    const targetImgEl     = document.getElementById('tlTargetImg');
    const floatsLayerEl  = document.getElementById('tlFloatsLayer');
    const flashEl           = document.getElementById('tlFlash');
    const scrubEl           = document.getElementById('tlScrub');
    const scrubValEl       = document.getElementById('tlScrubVal');
    const loopLenEl        = document.getElementById('tlLoopLen');
    const usernameInput   = document.getElementById('tlUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    const LOOP_DURATION = 24;
    scrubEl.max = String(LOOP_DURATION);
    loopLenEl.textContent = String(LOOP_DURATION);

    let isScrubbing = false;
    scrubEl.addEventListener('pointerdown', () => { isScrubbing = true; });
    scrubEl.addEventListener('input', () => { scrubValEl.textContent = parseFloat(scrubEl.value).toFixed(1); });
    ['pointerup', 'mouseup', 'touchend', 'change'].forEach(evt => {
        scrubEl.addEventListener(evt, () => { isScrubbing = false; });
    });

    /* ══════════════════════════════════════════════════════════════════
       THREE.JS SCENE
    ══════════════════════════════════════════════════════════════════ */
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0807);
    scene.fog = new THREE.FogExp2(0x0a0807, 0.05);

    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 40);
    camera.position.set(0, 1.7, 3.2);
    camera.lookAt(0, 1.8, -3.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width   = '100%';
    renderer.domElement.style.height  = '100%';
    canvasWrap.appendChild(renderer.domElement);

    function handleResize() {
        const w = canvasWrap.clientWidth;
        const h = Math.max(220, Math.round(w * 9 / 16));
        canvasWrap.style.height = h + 'px';
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', handleResize);

    /* ── Texture loader ──────────────────────────────────────────────── */
    // Loads at native resolution + max anisotropy, and reports the image's
    // real aspect ratio so frames can fit it without stretching/squashing.
    const texLoader  = new THREE.TextureLoader();
    const texCache    = {};
    const aspectCache = {};
    const maxAniso    = renderer.capabilities.getMaxAnisotropy();

    function getTex(url, onAspect) {
        if (texCache[url]) {
            if (onAspect && aspectCache[url]) onAspect(aspectCache[url]);
            return texCache[url];
        }
        const t = texLoader.load(url, (loaded) => {
            const img = loaded.image;
            const aspect = (img && img.width && img.height) ? img.width / img.height : 1;
            aspectCache[url] = aspect;
            if (onAspect) onAspect(aspect);
        });
        t.encoding   = THREE.sRGBEncoding;
        t.anisotropy = maxAniso;
        t.minFilter  = THREE.LinearMipmapLinearFilter;
        t.magFilter  = THREE.LinearFilter;
        texCache[url] = t;
        return t;
    }

    const FRAME_MAX_W = 1.15, FRAME_MAX_H = 1.45;

    function fitPlaneSize(aspect) {
        if (aspect >= FRAME_MAX_W / FRAME_MAX_H) {
            return { w: FRAME_MAX_W, h: FRAME_MAX_W / aspect };
        }
        return { w: FRAME_MAX_H * aspect, h: FRAME_MAX_H };
    }

    function refitImagePlane(mesh, aspect) {
        const { w, h } = fitPlaneSize(aspect);
        mesh.geometry.dispose();
        mesh.geometry = new THREE.PlaneGeometry(w, h);
    }

    /* ══════════════════════════════════════════════════════════════════
       NOIR ROOM ENVIRONMENT
    ══════════════════════════════════════════════════════════════════ */
    scene.add(new THREE.AmbientLight(0x1c2230, 0.9));

    const keyLight = new THREE.DirectionalLight(0xffd9a8, 0.5);
    keyLight.position.set(-2, 5, 4);
    keyLight.castShadow = true;
    scene.add(keyLight);

    const deskLamp = new THREE.PointLight(0xffaa55, 1.1, 6);
    deskLamp.position.set(1.4, 1.9, -0.7);
    scene.add(deskLamp);

    const woodMat = new THREE.MeshStandardMaterial({ color: 0x241710, metalness: 0.1, roughness: 0.85 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x141a18, metalness: 0.05, roughness: 0.9 });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 7), woodMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -3.5);
    floor.receiveShadow = true;
    scene.add(floor);

    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(8, 7), wallMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, 4.2, -3.5);
    scene.add(ceiling);

    const backWall = new THREE.Mesh(new THREE.PlaneGeometry(8, 4.2), wallMat);
    backWall.position.set(0, 2.1, -7);
    scene.add(backWall);

    [-1, 1].forEach((side) => {
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(7, 4.2), wallMat);
        wall.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
        wall.position.set(side * 4, 2.1, -3.5);
        scene.add(wall);
    });

    // Desk
    const desk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 0.7), woodMat);
    desk.position.set(1.4, 0.5, -0.7);
    desk.castShadow = true;
    desk.receiveShadow = true;
    scene.add(desk);

    // Bookshelf
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(1.0, 3.2, 0.5), woodMat);
    shelf.position.set(-3.2, 1.6, -2.0);
    shelf.castShadow = true;
    scene.add(shelf);
    for (let i = 0; i < 3; i++) {
        const edge = new THREE.Mesh(
            new THREE.BoxGeometry(1.02, 0.05, 0.52),
            new THREE.MeshStandardMaterial({ color: 0x4a3320, metalness: 0.1, roughness: 0.7 })
        );
        edge.position.set(-3.2, 0.5 + i * 1.0, -2.0);
        scene.add(edge);
    }

    // Mantle under the back-center frame
    const mantle = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.18, 0.5), woodMat);
    mantle.position.set(0, 1.0, -6.7);
    mantle.castShadow = true;
    scene.add(mantle);

    // Suggestion of venetian-blind light shafts (decorative, non-shadow)
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xffcf99, transparent: true, opacity: 0.06, side: THREE.DoubleSide });
    for (let i = 0; i < 3; i++) {
        const beam = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 6), beamMat);
        beam.position.set(-2.6 + i * 1.0, 2.1, -2.5);
        beam.rotation.y = Math.PI / 7;
        beam.rotation.z = Math.PI / 10;
        scene.add(beam);
    }

    /* ══════════════════════════════════════════════════════════════════
       FRAME SLOTS (static positions, oriented once toward the fixed camera)
    ══════════════════════════════════════════════════════════════════ */
    const SLOT_DEFS = [
        { x: -2.3, y: 2.6, z: -6.85 }, // back wall, upper-left
        { x:  2.3, y: 2.6, z: -6.85 }, // back wall, upper-right
        { x:  0.0, y: 1.65, z: -6.85 }, // back wall, above mantle
        { x: -3.85, y: 2.1, z: -3.0 }, // left wall
        { x:  3.85, y: 2.1, z: -3.0 }, // right wall
        { x:  1.4, y: 1.75, z: -0.65 }, // standing desk frame
    ];

    function makeFrameMesh() {
        const backing = new THREE.Mesh(
            new THREE.BoxGeometry(FRAME_MAX_W * 1.18, FRAME_MAX_H * 1.18, 0.05),
            new THREE.MeshStandardMaterial({ color: 0x3a2a18, metalness: 0.5, roughness: 0.4 })
        );
        const image = new THREE.Mesh(
            new THREE.PlaneGeometry(FRAME_MAX_W, FRAME_MAX_H),
            new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
        );
        scene.add(backing);
        scene.add(image);
        return { backing, image };
    }

    let allImages = [];

    async function loadCollection() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('TimeLoop: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    let slots = [];          // { backing, image, segments:[{startT,endT,image}], phaseOffset, lastSegIndex, flickerT }
    let entryPool = [];       // flattened {slotIndex, segIndex, image}
    let clickable = [];
    let hitParticles = [];
    let floatingTexts = [];

    function segmentIndexAt(slot, t) {
        const segLen = LOOP_DURATION / slot.segments.length;
        let local = (t + slot.phaseOffset) % LOOP_DURATION;
        if (local < 0) local += LOOP_DURATION;
        return Math.min(slot.segments.length - 1, Math.floor(local / segLen));
    }

    function buildRoom() {
        slots.forEach(s => { scene.remove(s.backing); scene.remove(s.image); });
        slots = [];
        entryPool = [];

        const segCount = allImages.length >= 18 ? 3 : 2;
        const pool = shuffle(allImages);
        let cursor = 0;

        SLOT_DEFS.forEach((def, slotIndex) => {
            const { backing, image } = makeFrameMesh();
            backing.position.set(def.x, def.y, def.z);
            image.position.set(def.x, def.y, def.z);
            // Nudge the image slightly toward the camera side of the backing
            // so it doesn't z-fight, then orient both once toward the fixed
            // camera. lookAt() points local -Z at the camera, which shows the
            // image plane's back (mirrored) face — rotate 180° to fix it.
            const towardCam = camera.position.clone().sub(backing.position).normalize();
            image.position.addScaledVector(towardCam, 0.04);
            backing.lookAt(camera.position);
            image.lookAt(camera.position);
            image.rotateY(Math.PI);

            const segLen = LOOP_DURATION / segCount;
            const segments = [];
            for (let k = 0; k < segCount; k++) {
                const imgObj = pool[cursor % pool.length];
                cursor++;
                segments.push({ startT: k * segLen, endT: (k + 1) * segLen, image: imgObj });
                entryPool.push({ slotIndex, segIndex: k, image: imgObj });
            }

            slots.push({
                backing, image, segments,
                phaseOffset: Math.random() * LOOP_DURATION,
                lastSegIndex: -1,
                flickerT: 0,
            });
            clickable.push(image);
        });
    }

    function applySlotImage(slot, segIndex) {
        const imgObj = slot.segments[segIndex].image;
        slot.image.material.map = getTex(imgObj.url, aspect => refitImagePlane(slot.image, aspect));
        slot.image.material.needsUpdate = true;
        slot.flickerT = 1;
    }

    function pickNewTarget() {
        if (!entryPool.length) return;
        let entry;
        do {
            entry = entryPool[Math.floor(Math.random() * entryPool.length)];
        } while (entryPool.length > 1 && state.targetEntry &&
                 entry.slotIndex === state.targetEntry.slotIndex && entry.segIndex === state.targetEntry.segIndex);
        state.targetEntry = entry;
        targetImgEl.src = entry.image.url;
    }

    /* ══════════════════════════════════════════════════════════════════
       STATE
    ══════════════════════════════════════════════════════════════════ */
    let state = { active: false, score: 0, lives: 3, combo: 1,
                  targetEntry: null, startTime: null, elapsed: 0, autoTime: 0 };

    /* ══════════════════════════════════════════════════════════════════
       HIT PARTICLES + FLOATING TEXT (shared helpers)
    ══════════════════════════════════════════════════════════════════ */
    function spawnHitParticles(worldPos, colHex, count) {
        for (let i = 0; i < count; i++) {
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(0.045, 4, 4),
                new THREE.MeshBasicMaterial({ color: colHex })
            );
            mesh.position.copy(worldPos);
            scene.add(mesh);
            hitParticles.push({
                mesh,
                vel: new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3 + 0.5, (Math.random() - 0.5) * 4),
                life: 1,
                maxLife: 0.4 + Math.random() * 0.3,
            });
        }
    }

    function updateParticles(dt) {
        for (let i = hitParticles.length - 1; i >= 0; i--) {
            const p = hitParticles[i];
            p.vel.y -= 6 * dt;
            p.mesh.position.addScaledVector(p.vel, dt);
            p.life -= dt / p.maxLife;
            if (p.life <= 0) {
                scene.remove(p.mesh);
                p.mesh.geometry.dispose();
                p.mesh.material.dispose();
                hitParticles.splice(i, 1);
            }
        }
    }

    function worldToCanvas(worldPos) {
        const v = worldPos.clone().project(camera);
        const r = renderer.domElement.getBoundingClientRect();
        return { x: (v.x + 1) / 2 * r.width, y: (-v.y + 1) / 2 * r.height };
    }

    function spawnFloatText(worldPos, text, color) {
        const { x, y } = worldToCanvas(worldPos);
        const el = document.createElement('div');
        el.className = 'tl-float-text';
        el.textContent = text;
        el.style.left = x + 'px';
        el.style.top  = y + 'px';
        el.style.color = color;
        floatsLayerEl.appendChild(el);
        floatingTexts.push({ el, startY: y, startTime: performance.now() });
    }

    function updateFloatTexts(ts) {
        for (let i = floatingTexts.length - 1; i >= 0; i--) {
            const f = floatingTexts[i];
            const p = Math.min(1, (ts - f.startTime) / 1100);
            f.el.style.top = (f.startY - p * 72) + 'px';
            f.el.style.opacity = 1 - p * p;
            if (p >= 1) { f.el.remove(); floatingTexts.splice(i, 1); }
        }
    }

    function flashScreen(bg) {
        flashEl.style.background = bg;
        flashEl.style.opacity = '1';
        requestAnimationFrame(() => requestAnimationFrame(() => { flashEl.style.opacity = '0'; }));
    }

    function renderLives() {
        livesEl.textContent = '❤️'.repeat(state.lives) + '🖤'.repeat(3 - state.lives);
    }

    /* ══════════════════════════════════════════════════════════════════
       POINTER: CLICK
    ══════════════════════════════════════════════════════════════════ */
    const raycaster = new THREE.Raycaster();
    const mouseNDC  = new THREE.Vector2();

    canvasWrap.addEventListener('click', e => {
        if (!state.active) return;
        const r = canvasWrap.getBoundingClientRect();
        mouseNDC.set(
            ((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1
        );
        raycaster.setFromCamera(mouseNDC, camera);
        const hits = raycaster.intersectObjects(clickable);
        if (!hits.length) return;

        const hitPoint = hits[0].point;
        const slotIndex = slots.findIndex(s => s.image === hits[0].object);
        if (slotIndex === -1) return;
        const slot = slots[slotIndex];
        const displayTime = isScrubbing ? parseFloat(scrubEl.value) : state.autoTime;
        const segIndex = segmentIndexAt(slot, displayTime);

        const isCorrect = state.targetEntry &&
            slotIndex === state.targetEntry.slotIndex && segIndex === state.targetEntry.segIndex;

        if (isCorrect) {
            state.combo = Math.min(8, state.combo + 1);
            const pts = 150 * state.combo;
            state.score += pts;
            scoreEl.textContent = state.score;
            comboEl.textContent = `×${state.combo}`;
            comboEl.classList.toggle('tl-combo--hot', state.combo >= 4);

            spawnHitParticles(hitPoint, 0xffbf55, 20);
            spawnFloatText(hitPoint, `+${pts}`, '#ffbf55');
            flashScreen('rgba(255,191,85,0.18)');
            pickNewTarget();
        } else {
            state.combo = 1;
            state.lives = Math.max(0, state.lives - 1);
            state.score = Math.max(0, state.score - 60);
            scoreEl.textContent = state.score;
            comboEl.textContent = '×1';
            comboEl.classList.remove('tl-combo--hot');
            renderLives();

            spawnHitParticles(hitPoint, 0xff2244, 10);
            spawnFloatText(hitPoint, '−60', '#ff3355');
            flashScreen('rgba(255,0,40,0.28)');

            livesEl.classList.add('tl-shake');
            setTimeout(() => livesEl.classList.remove('tl-shake'), 380);

            if (state.lives <= 0) setTimeout(endGame, 550);
        }
    });

    // Touch support — treat as click at touch point
    canvasWrap.addEventListener('touchend', e => {
        if (e.target !== renderer.domElement) return;
        e.preventDefault();
        const t = e.changedTouches[0];
        const fakeClick = new MouseEvent('click', { clientX: t.clientX, clientY: t.clientY, bubbles: true });
        canvasWrap.dispatchEvent(fakeClick);
    }, { passive: false });

    /* ══════════════════════════════════════════════════════════════════
       ANIMATION LOOP
    ══════════════════════════════════════════════════════════════════ */
    let prevTs = 0;

    function animate(ts) {
        requestAnimationFrame(animate);
        const dt = Math.min((ts - prevTs) / 1000, 0.05);
        prevTs = ts;

        if (state.active) {
            state.autoTime = (state.autoTime + dt) % LOOP_DURATION;
            state.elapsed += dt;
            timerEl.textContent = Math.floor(state.elapsed);

            if (!isScrubbing) {
                scrubEl.value = state.autoTime.toFixed(2);
                scrubValEl.textContent = state.autoTime.toFixed(1);
            }

            const displayTime = isScrubbing ? parseFloat(scrubEl.value) : state.autoTime;
            slots.forEach(slot => {
                const segIndex = segmentIndexAt(slot, displayTime);
                if (segIndex !== slot.lastSegIndex) {
                    slot.lastSegIndex = segIndex;
                    applySlotImage(slot, segIndex);
                }
                if (slot.flickerT > 0) {
                    slot.flickerT = Math.max(0, slot.flickerT - dt * 7);
                    slot.image.material.opacity = 0.4 + 0.6 * (1 - slot.flickerT);
                    slot.image.material.transparent = true;
                } else {
                    slot.image.material.opacity = 1;
                }
            });
        }

        updateParticles(dt);
        updateFloatTexts(ts);

        renderer.render(scene, camera);
    }

    /* ══════════════════════════════════════════════════════════════════
       GAME LIFECYCLE
    ══════════════════════════════════════════════════════════════════ */
    function clearScene() {
        slots.forEach(s => { scene.remove(s.backing); scene.remove(s.image); });
        slots = [];
        entryPool = [];
        clickable.length = 0;

        hitParticles.forEach(p => { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); });
        hitParticles.length = 0;

        floatingTexts.forEach(f => f.el.remove());
        floatingTexts.length = 0;
    }

    async function initGame() {
        if (allImages.length < 12) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 12 images to play!</div>';
            return;
        }

        clearScene();
        buildRoom();

        state = {
            active: true,
            score: 0,
            lives: 3,
            combo: 1,
            targetEntry: null,
            startTime: Date.now(),
            elapsed: 0,
            autoTime: 0,
        };
        pickNewTarget();

        scoreEl.textContent = '0';
        timerEl.textContent = '0';
        comboEl.textContent = '×1';
        comboEl.classList.remove('tl-combo--hot');
        renderLives();
        messageEl.innerHTML = '';
        scrubEl.value = '0';
        scrubValEl.textContent = '0.0';

        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';
    }

    function endGame() {
        if (!state.active) return;
        state.active = false;

        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-clock-rotate-left"></i>
                <h2>Case Closed!</h2>
                <p>Survived <strong>${elapsed}s</strong> — Final Score: <strong>${state.score}</strong></p>
            </div>`;

        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';

        const user = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType: 'timeloop',
                score: state.score,
                time: elapsed,
                username: user,
            })
        }).catch(() => {});
    }

    function resetGame() {
        state.active = false;
        clearScene();
        scoreEl.textContent = '0';
        timerEl.textContent = '0';
        comboEl.textContent = '×1';
        comboEl.classList.remove('tl-combo--hot');
        livesEl.textContent = '❤️❤️❤️';
        messageEl.innerHTML = '';
        targetImgEl.src = '';
        scrubEl.value = '0';
        scrubValEl.textContent = '0.0';
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
    }

    /* ══════════════════════════════════════════════════════════════════
       FULLSCREEN
    ══════════════════════════════════════════════════════════════════ */
    if (fsBtn) {
        fsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                tlContainer.requestFullscreen().catch(err => console.warn(err));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === tlContainer;
            fsBtn.innerHTML = isFS
                ? '<i class="fas fa-compress"></i> Exit Fullscreen'
                : '<i class="fas fa-expand"></i> Fullscreen';
            setTimeout(handleResize, 60);
        });
    }

    /* ══════════════════════════════════════════════════════════════════
       WIRING & BOOTSTRAP
    ══════════════════════════════════════════════════════════════════ */
    startBtn.addEventListener('click', initGame);
    resetBtn.addEventListener('click', resetGame);
    backBtn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        window.location.href = `/collection/${COLLECTION}`;
    });

    await loadCollection();
    handleResize();
    timerEl.textContent = '0';

    if (allImages.length < 12) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:1rem">Need at least 12 images to play!</div>';
        startBtn.disabled = true;
    }

    requestAnimationFrame(animate);
});

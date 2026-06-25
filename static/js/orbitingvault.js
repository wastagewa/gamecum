/**
 * Orbiting Vault — Three.js r134
 *
 * A ring of framed images orbits continuously around a fixed camera, like
 * picture frames mounted on a slowly spinning vault mechanism.
 *   • Each frame is billboarded (always faces the camera) as it swings
 *     through its circular path — near the front it's large and easy to
 *     read, near the back it's small and foreshortened.
 *   • The HUD shows a target thumbnail. Click the ring frame holding that
 *     exact image before it's lost in the rotation.
 *       Correct frame → +pts (combo-scaled). Frame flies toward camera,
 *         fades, then re-seats with a fresh image.
 *       Wrong frame    → −pts, −1 life, combo resets, brief red pulse.
 *   • Ring speed is configurable: either a constant speed the player picks,
 *     or a progressive mode that speeds up with every correct hit.
 *   • 3 lives. The round is untimed — it only ends after 3 mistakes.
 *
 * gameType: 'orbitingvault'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    if (typeof THREE === 'undefined') {
        console.error('Three.js failed to load — check CDN link.');
        return;
    }

    /* ── DOM ────────────────────────────────────────────────────────── */
    const ovContainer   = document.getElementById('ovContainer');
    const canvasWrap     = document.getElementById('ovCanvasWrap');
    const startBtn        = document.getElementById('startOvBtn');
    const resetBtn        = document.getElementById('resetOvBtn');
    const fsBtn            = document.getElementById('fullscreenOvBtn');
    const backBtn         = document.getElementById('backOvBtn');
    const scoreEl           = document.getElementById('ovScore');
    const timerEl           = document.getElementById('ovTimer');
    const livesEl           = document.getElementById('ovLives');
    const comboEl           = document.getElementById('ovCombo');
    const messageEl       = document.getElementById('ovMessage');
    const targetImgEl     = document.getElementById('ovTargetImg');
    const floatsLayerEl  = document.getElementById('ovFloatsLayer');
    const flashEl           = document.getElementById('ovFlash');
    const speedSl            = document.getElementById('ovSpeed');
    const speedValEl       = document.getElementById('ovSpeedVal');
    const speedLabelEl    = document.getElementById('ovSpeedLabel');
    const modeBtns          = Array.from(document.querySelectorAll('.ov-mode-btn'));
    const usernameInput   = document.getElementById('ovUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    let speedMode = 'progressive'; // 'progressive' | 'constant'
    modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            modeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            speedMode = btn.dataset.mode;
            speedLabelEl.textContent = speedMode === 'constant' ? 'Constant speed' : 'Starting speed';
            if (state.active) {
                state.speedMode = speedMode;
                if (speedMode === 'constant') state.ringSpeed = state.baseSpeed;
            }
        });
    });
    speedSl.addEventListener('input', () => {
        speedValEl.textContent = parseFloat(speedSl.value).toFixed(2);
    });

    /* ══════════════════════════════════════════════════════════════════
       THREE.JS SCENE
    ══════════════════════════════════════════════════════════════════ */
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05030a);
    scene.fog = new THREE.FogExp2(0x05030a, 0.045);

    const RING_CENTER = new THREE.Vector3(0, 1.6, -2.2);
    const RING_RADIUS = 4.3;

    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 60);
    camera.position.set(0, 1.6, 7.6);
    camera.lookAt(RING_CENTER);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
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

    /* ══════════════════════════════════════════════════════════════════
       VAULT ENVIRONMENT
    ══════════════════════════════════════════════════════════════════ */
    scene.add(new THREE.AmbientLight(0x2a1a3a, 1.0));

    const keyLight = new THREE.DirectionalLight(0xfff0d0, 0.65);
    keyLight.position.set(2, 6, 8);
    scene.add(keyLight);

    const spotCenter = new THREE.SpotLight(0xffe9b0, 1.1, 26, Math.PI / 5, 0.5);
    spotCenter.position.set(0, 6.5, 4);
    spotCenter.target.position.copy(RING_CENTER);
    scene.add(spotCenter);
    scene.add(spotCenter.target);

    const rimLight = new THREE.PointLight(0xd4af37, 1.3, 16);
    rimLight.position.set(0, 2.2, -1.5);
    scene.add(rimLight);

    // Floor
    const floor = new THREE.Mesh(
        new THREE.CircleGeometry(12, 48),
        new THREE.MeshStandardMaterial({ color: 0x0c0814, metalness: 0.3, roughness: 0.85 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -2.2);
    scene.add(floor);

    // Decorative vault-door backdrop disc + concentric rings
    const backdrop = new THREE.Mesh(
        new THREE.CircleGeometry(6.4, 64),
        new THREE.MeshStandardMaterial({ color: 0x140f1f, metalness: 0.55, roughness: 0.4 })
    );
    backdrop.position.set(0, 1.6, -7.4);
    scene.add(backdrop);

    [5.6, 4.7, 3.9].forEach((r, i) => {
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(r, 0.045, 8, 64),
            new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.8, roughness: 0.3, emissive: 0x3a2a08, emissiveIntensity: 0.4 })
        );
        ring.position.set(0, 1.6, -7.38 + i * 0.01);
        scene.add(ring);
    });


    /* ══════════════════════════════════════════════════════════════════
       GAME DATA & STATE
    ══════════════════════════════════════════════════════════════════ */
    let allImages = [];

    async function loadCollection() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('OrbitingVault: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // Bounding box each frame's image is fit into (object-fit: contain —
    // preserves the image's real aspect ratio instead of stretching it).
    const FRAME_MAX_W = 1.65, FRAME_MAX_H = 2.05;

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

    let state = { active: false, score: 0, lives: 3, combo: 1,
                  targetIndex: -1, startTime: null, elapsed: 0,
                  ringSpeed: 0.3, baseSpeed: 0.3, speedMode: 'progressive' };

    let slots         = [];   // ring frame slots
    let clickable      = [];  // image meshes currently safe to click
    let pool           = [];  // shuffled image pool for respawns
    let poolPtr        = -1;
    let activeUrls     = new Set();
    let hitParticles  = [];
    let floatingTexts = [];
    let hoveredSlot    = null;

    function takeNextImage() {
        for (let tries = 0; tries < pool.length; tries++) {
            poolPtr = (poolPtr + 1) % pool.length;
            const cand = pool[poolPtr];
            if (!activeUrls.has(cand.url)) return cand;
        }
        return null;
    }

    function makeFrame(imgObj) {
        const backing = new THREE.Mesh(
            new THREE.BoxGeometry(FRAME_MAX_W * 1.16, FRAME_MAX_H * 1.16, 0.06),
            new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.75, roughness: 0.3 })
        );
        const image = new THREE.Mesh(
            new THREE.PlaneGeometry(FRAME_MAX_W, FRAME_MAX_H),
            new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
        );
        // `image` must already be assigned before this call: getTex()'s
        // aspect callback can fire synchronously on a texture-cache hit.
        image.material.map = getTex(imgObj.url, aspect => refitImagePlane(image, aspect));
        image.material.needsUpdate = true;
        scene.add(backing);
        scene.add(image);
        return { backing, image };
    }

    function buildRing(n) {
        slots.forEach(s => { scene.remove(s.backing); scene.remove(s.image); });
        slots = [];
        activeUrls = new Set();

        pool    = shuffle(allImages);
        poolPtr = n - 1;

        for (let i = 0; i < n; i++) {
            const imgObj = pool[i];
            activeUrls.add(imgObj.url);
            const { backing, image } = makeFrame(imgObj);
            slots.push({
                index: i,
                angle0: (i / n) * Math.PI * 2,
                imgObj,
                backing,
                image,
                hitting: false,
                hitT: 0,
                bobPhase: Math.random() * Math.PI * 2,
            });
        }
    }

    function respawnSlot(slot) {
        activeUrls.delete(slot.imgObj.url);
        const next = takeNextImage();
        if (next) {
            slot.imgObj = next;
            activeUrls.add(next.url);
        } else {
            activeUrls.add(slot.imgObj.url); // collection too small — keep existing image
        }
        slot.image.material.map = getTex(slot.imgObj.url, aspect => refitImagePlane(slot.image, aspect));
        slot.image.material.needsUpdate = true;
        slot.hitting = false;
        slot.hitT = 0;
        slot.image.material.opacity = 1;
        slot.backing.material.opacity = 1;
    }

    function pickNewTarget() {
        const candidates = slots.filter(s => !s.hitting);
        if (!candidates.length) return;
        const choice = candidates[Math.floor(Math.random() * candidates.length)];
        state.targetIndex = choice.index;
        targetImgEl.src = choice.imgObj.url;
    }

    /* ══════════════════════════════════════════════════════════════════
       RING UPDATE (position + billboard every frame)
    ══════════════════════════════════════════════════════════════════ */
    let ringRotation = 0;

    function updateRing(dt, elapsed) {
        ringRotation += state.ringSpeed * dt;
        clickable.length = 0;

        slots.forEach(slot => {
            if (slot.hitting) {
                slot.hitT = Math.min(1, slot.hitT + dt * 2.2);
                slot.backing.position.lerpVectors(slot.hitFrom, slot.hitTo, slot.hitT);
                slot.image.position.lerpVectors(slot.hitFrom, slot.hitTo, slot.hitT);
                const fade = Math.max(0, 1 - slot.hitT * 1.3);
                slot.backing.material.opacity = fade;
                slot.image.material.opacity   = fade;
                slot.backing.material.transparent = true;
                slot.image.material.transparent   = true;
                if (slot.hitT >= 1) respawnSlot(slot);
                return;
            }

            const angle = ringRotation + slot.angle0;
            const x = RING_CENTER.x + RING_RADIUS * Math.sin(angle);
            const z = RING_CENTER.z + RING_RADIUS * Math.cos(angle);
            const y = RING_CENTER.y + Math.sin(elapsed * 0.6 + slot.bobPhase) * 0.08;

            slot.backing.position.set(x, y, z);
            slot.image.position.set(x, y, z + 0.045);
            slot.backing.lookAt(camera.position);
            // lookAt() points local -Z at the camera, which shows the plane's
            // back (mirrored) face — rotate 180° so the correct front face shows.
            slot.image.lookAt(camera.position);
            slot.image.rotateY(Math.PI);

            const isHover = hoveredSlot === slot;
            const scale = isHover ? 1.1 : 1.0;
            slot.backing.scale.setScalar(scale);
            slot.image.scale.setScalar(scale);

            clickable.push(slot.image);
        });
    }

    /* ══════════════════════════════════════════════════════════════════
       HIT PARTICLES
    ══════════════════════════════════════════════════════════════════ */
    function spawnHitParticles(worldPos, colHex, count) {
        for (let i = 0; i < count; i++) {
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(0.05, 4, 4),
                new THREE.MeshBasicMaterial({ color: colHex })
            );
            mesh.position.copy(worldPos);
            scene.add(mesh);
            hitParticles.push({
                mesh,
                vel: new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 5 + 1, (Math.random() - 0.5) * 4),
                life: 1,
                maxLife: 0.4 + Math.random() * 0.3,
            });
        }
    }

    function updateParticles(dt) {
        for (let i = hitParticles.length - 1; i >= 0; i--) {
            const p = hitParticles[i];
            p.vel.y -= 8 * dt;
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

    /* ══════════════════════════════════════════════════════════════════
       FLOATING SCORE TEXTS
    ══════════════════════════════════════════════════════════════════ */
    function worldToCanvas(worldPos) {
        const v = worldPos.clone().project(camera);
        const r = renderer.domElement.getBoundingClientRect();
        return { x: (v.x + 1) / 2 * r.width, y: (-v.y + 1) / 2 * r.height };
    }

    function spawnFloatText(worldPos, text, color) {
        const { x, y } = worldToCanvas(worldPos);
        const el = document.createElement('div');
        el.className = 'ov-float-text';
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

    /* ══════════════════════════════════════════════════════════════════
       POINTER: HOVER + CLICK
    ══════════════════════════════════════════════════════════════════ */
    const raycaster = new THREE.Raycaster();
    const mouseNDC  = new THREE.Vector2();

    function ndcFromEvent(e) {
        const r = canvasWrap.getBoundingClientRect();
        mouseNDC.set(
            ((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1
        );
    }

    canvasWrap.addEventListener('mousemove', e => {
        if (!state.active) return;
        ndcFromEvent(e);
        raycaster.setFromCamera(mouseNDC, camera);
        const hits = raycaster.intersectObjects(clickable);
        if (hits.length) {
            const slot = slots.find(s => s.image === hits[0].object);
            hoveredSlot = slot || null;
            canvasWrap.style.cursor = 'pointer';
        } else {
            hoveredSlot = null;
            canvasWrap.style.cursor = 'default';
        }
    });

    canvasWrap.addEventListener('click', e => {
        if (!state.active) return;
        ndcFromEvent(e);
        raycaster.setFromCamera(mouseNDC, camera);
        const hits = raycaster.intersectObjects(clickable);
        if (!hits.length) return;

        const hitPoint = hits[0].point;
        const slot = slots.find(s => s.image === hits[0].object);
        if (!slot || slot.hitting) return;

        if (slot.index === state.targetIndex) {
            state.combo = Math.min(8, state.combo + 1);
            const pts = 150 * state.combo;
            state.score += pts;
            scoreEl.textContent = state.score;
            comboEl.textContent = `×${state.combo}`;
            comboEl.classList.toggle('ov-combo--hot', state.combo >= 4);

            slot.hitting = true;
            slot.hitT = 0;
            slot.hitFrom = slot.image.position.clone();
            slot.hitTo = slot.image.position.clone();
            slot.hitTo.z += 3.0;

            spawnHitParticles(hitPoint, 0xffd700, 22);
            spawnFloatText(hitPoint, `+${pts}`, '#ffd700');
            flashScreen('rgba(255,215,0,0.18)');

            if (state.speedMode === 'progressive') {
                state.ringSpeed = Math.min(state.baseSpeed + 0.7, state.ringSpeed + 0.018);
            }
            pickNewTarget();
        } else {
            state.combo = 1;
            state.lives = Math.max(0, state.lives - 1);
            state.score = Math.max(0, state.score - 60);
            scoreEl.textContent = state.score;
            comboEl.textContent = '×1';
            comboEl.classList.remove('ov-combo--hot');
            renderLives();

            spawnHitParticles(hitPoint, 0xff2244, 12);
            spawnFloatText(hitPoint, '−60', '#ff3355');
            flashScreen('rgba(255,0,40,0.28)');

            livesEl.classList.add('ov-shake');
            setTimeout(() => livesEl.classList.remove('ov-shake'), 380);

            if (state.lives <= 0) setTimeout(endGame, 550);
        }
    });

    // Touch support — treat as click at touch point
    canvasWrap.addEventListener('touchend', e => {
        e.preventDefault();
        const t = e.changedTouches[0];
        const fakeClick = new MouseEvent('click', { clientX: t.clientX, clientY: t.clientY, bubbles: true });
        canvasWrap.dispatchEvent(fakeClick);
    }, { passive: false });

    /* ══════════════════════════════════════════════════════════════════
       LIVES DISPLAY
    ══════════════════════════════════════════════════════════════════ */
    function renderLives() {
        livesEl.textContent = '❤️'.repeat(state.lives) + '🖤'.repeat(3 - state.lives);
    }

    /* ══════════════════════════════════════════════════════════════════
       ANIMATION LOOP
    ══════════════════════════════════════════════════════════════════ */
    let prevTs = 0;

    function animate(ts) {
        requestAnimationFrame(animate);
        const dt = Math.min((ts - prevTs) / 1000, 0.05);
        prevTs = ts;
        const elapsed = ts / 1000;

        updateRing(dt, elapsed);
        updateParticles(dt);
        updateFloatTexts(ts);

        if (state.active) {
            state.elapsed += dt;
            timerEl.textContent = Math.floor(state.elapsed);
        }

        renderer.render(scene, camera);
    }

    /* ══════════════════════════════════════════════════════════════════
       GAME LIFECYCLE
    ══════════════════════════════════════════════════════════════════ */
    function clearScene() {
        slots.forEach(s => { scene.remove(s.backing); scene.remove(s.image); });
        slots = [];
        clickable.length = 0;

        hitParticles.forEach(p => { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); });
        hitParticles.length = 0;

        floatingTexts.forEach(f => f.el.remove());
        floatingTexts.length = 0;

        hoveredSlot = null;
    }

    async function initGame() {
        if (allImages.length < 6) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 6 images to play!</div>';
            return;
        }

        clearScene();

        const ringSize  = Math.max(6, Math.min(10, allImages.length));
        const baseSpeed = parseFloat(speedSl.value);
        buildRing(ringSize);
        ringRotation = 0;

        state = {
            active: true,
            score: 0,
            lives: 3,
            combo: 1,
            targetIndex: -1,
            startTime: Date.now(),
            elapsed: 0,
            ringSpeed: baseSpeed,
            baseSpeed: baseSpeed,
            speedMode: speedMode,
        };
        pickNewTarget();

        scoreEl.textContent = '0';
        timerEl.textContent = '0';
        comboEl.textContent = '×1';
        comboEl.classList.remove('ov-combo--hot');
        renderLives();
        messageEl.innerHTML = '';

        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';
    }

    function endGame() {
        if (!state.active) return;
        state.active = false;

        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-dharmachakra"></i>
                <h2>Vault Sealed!</h2>
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
                gameType: 'orbitingvault',
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
        comboEl.classList.remove('ov-combo--hot');
        livesEl.textContent = '❤️❤️❤️';
        messageEl.innerHTML = '';
        targetImgEl.src = '';
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
    }

    /* ══════════════════════════════════════════════════════════════════
       FULLSCREEN
    ══════════════════════════════════════════════════════════════════ */
    if (fsBtn) {
        fsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                ovContainer.requestFullscreen().catch(err => console.warn(err));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === ovContainer;
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
    speedValEl.textContent = parseFloat(speedSl.value).toFixed(2);

    if (allImages.length < 6) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:1rem">Need at least 6 images to play!</div>';
        startBtn.disabled = true;
    }

    requestAnimationFrame(animate);
});

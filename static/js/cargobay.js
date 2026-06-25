/**
 * Zero-Gravity Cargo Bay — Three.js r134
 *
 * Image-pods drift freely in a bounded 3D volume inside a space-station
 * cargo bay, each billboarded (always faces the camera) so they stay
 * readable while they tumble through space.
 *   • The HUD shows a target thumbnail. Click the pod holding that exact
 *     image to tractor-beam it in.
 *       Correct pod → +pts (combo-scaled). Pod flies toward camera, fades,
 *         then re-seats elsewhere with a fresh image.
 *       Wrong pod    → −pts, −1 life, combo resets, gets knocked away.
 *   • Pods that drift into the airlock at the back of the bay are lost and
 *     replaced — if it was the current target, a new target is picked
 *     (no penalty; the bay is volumetric, so losing sight of one happens).
 *   • 3 lives. The round is untimed — it only ends after 3 mistakes.
 *
 * gameType: 'cargobay'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    if (typeof THREE === 'undefined') {
        console.error('Three.js failed to load — check CDN link.');
        return;
    }

    /* ── DOM ────────────────────────────────────────────────────────── */
    const cbContainer   = document.getElementById('cbContainer');
    const canvasWrap    = document.getElementById('cbCanvasWrap');
    const startBtn      = document.getElementById('startCbBtn');
    const resetBtn      = document.getElementById('resetCbBtn');
    const fsBtn         = document.getElementById('fullscreenCbBtn');
    const backBtn       = document.getElementById('backCbBtn');
    const scoreEl       = document.getElementById('cbScore');
    const timerEl       = document.getElementById('cbTimer');
    const livesEl       = document.getElementById('cbLives');
    const comboEl       = document.getElementById('cbCombo');
    const messageEl     = document.getElementById('cbMessage');
    const targetImgEl   = document.getElementById('cbTargetImg');
    const floatsLayerEl = document.getElementById('cbFloatsLayer');
    const flashEl       = document.getElementById('cbFlash');
    const usernameInput = document.getElementById('cbUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    /* ══════════════════════════════════════════════════════════════════
       THREE.JS SCENE
    ══════════════════════════════════════════════════════════════════ */
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070d);
    scene.fog = new THREE.FogExp2(0x05070d, 0.05);

    // Bounded volume the pods drift inside. zFar is the airlock loss boundary.
    const BOUNDS = { xMin: -4.0, xMax: 4.0, yMin: 0.7, yMax: 3.7, zNear: -2.2, zFar: -9.5 };

    const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 80);
    camera.position.set(0, 2.0, 3.0);
    camera.lookAt(0, 2.0, -6);

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
    // real aspect ratio so pods can fit it without stretching/squashing.
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
       CARGO BAY ENVIRONMENT
    ══════════════════════════════════════════════════════════════════ */
    scene.add(new THREE.AmbientLight(0x1a2a4a, 1.1));

    const keyLight = new THREE.DirectionalLight(0xcfe8ff, 0.5);
    keyLight.position.set(1, 5, 5);
    scene.add(keyLight);

    const cyanFill = new THREE.PointLight(0x44ccff, 0.8, 14);
    cyanFill.position.set(0, 3, 1);
    scene.add(cyanFill);

    const metalMat = new THREE.MeshStandardMaterial({ color: 0x12161f, metalness: 0.6, roughness: 0.55 });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 13), metalMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, BOUNDS.yMin - 0.4, -6);
    scene.add(floor);

    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 13), metalMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, BOUNDS.yMax + 0.4, -6);
    scene.add(ceiling);

    [-1, 1].forEach((side) => {
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(13, 4.4), metalMat);
        wall.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
        wall.position.set(side * (BOUNDS.xMax + 0.6), 2.2, -6);
        scene.add(wall);
    });

    // Structural beams along the ceiling edge for a bit of detail
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x1c2230, metalness: 0.7, roughness: 0.4 });
    for (let z = -1; z >= -10; z -= 2.4) {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(9.4, 0.14, 0.14), beamMat);
        beam.position.set(0, BOUNDS.yMax + 0.32, z);
        scene.add(beam);
    }

    // Airlock — glowing ring + dark membrane at the far loss boundary
    const airlockGroup = new THREE.Group();
    airlockGroup.position.set(0, 2.2, BOUNDS.zFar - 0.05);
    const airlockRing = new THREE.Mesh(
        new THREE.TorusGeometry(1.9, 0.13, 12, 48),
        new THREE.MeshStandardMaterial({ color: 0xff6622, emissive: 0xff3300, emissiveIntensity: 0.9, metalness: 0.6, roughness: 0.35 })
    );
    airlockGroup.add(airlockRing);
    const airlockMembrane = new THREE.Mesh(
        new THREE.CircleGeometry(1.75, 32),
        new THREE.MeshBasicMaterial({ color: 0x1a0a05, transparent: true, opacity: 0.85 })
    );
    airlockGroup.add(airlockMembrane);
    scene.add(airlockGroup);

    const airlockLight = new THREE.PointLight(0xff5522, 1.4, 10);
    airlockLight.position.copy(airlockGroup.position);
    airlockLight.position.z += 1.5;
    scene.add(airlockLight);

    // Starfield glimpsed beyond the airlock
    const starGeo = new THREE.BufferGeometry();
    const starCount = 500;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
        starPos[i * 3]     = (Math.random() - 0.5) * 40;
        starPos[i * 3 + 1] = (Math.random() - 0.5) * 30 + 2;
        starPos[i * 3 + 2] = -12 - Math.random() * 30;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starField = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.07, sizeAttenuation: true, transparent: true, opacity: 0.9 }));
    scene.add(starField);

    /* ══════════════════════════════════════════════════════════════════
       GAME DATA & STATE
    ══════════════════════════════════════════════════════════════════ */
    let allImages = [];

    async function loadCollection() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success) allImages = data.images;
        } catch (e) { console.error('CargoBay: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // Bounding box each pod's image is fit into (object-fit: contain —
    // preserves the image's real aspect ratio instead of stretching it).
    const FRAME_MAX_W = 1.3, FRAME_MAX_H = 1.6;
    const POD_SPEED   = 0.35;
    const MIN_SEP     = 1.7; // minimum initial separation between pod centers

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
                  targetIndex: -1, startTime: null, elapsed: 0 };

    let pods          = [];
    let clickable     = [];
    let pool          = [];
    let poolPtr       = -1;
    let activeUrls    = new Set();
    let hitParticles  = [];
    let floatingTexts = [];
    let hoveredPod    = null;

    function takeNextImage() {
        for (let tries = 0; tries < pool.length; tries++) {
            poolPtr = (poolPtr + 1) % pool.length;
            const cand = pool[poolPtr];
            if (!activeUrls.has(cand.url)) return cand;
        }
        return null;
    }

    function randomVelocity() {
        const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
        v.normalize().multiplyScalar(POD_SPEED * (0.6 + Math.random() * 0.7));
        return v;
    }

    function randomPosition(existing) {
        for (let tries = 0; tries < 12; tries++) {
            const p = new THREE.Vector3(
                BOUNDS.xMin + Math.random() * (BOUNDS.xMax - BOUNDS.xMin),
                BOUNDS.yMin + Math.random() * (BOUNDS.yMax - BOUNDS.yMin),
                BOUNDS.zNear - 1.0 - Math.random() * (BOUNDS.zNear - BOUNDS.zFar - 1.5)
            );
            const tooClose = existing.some(o => o.distanceTo(p) < MIN_SEP);
            if (!tooClose) return p;
        }
        return new THREE.Vector3(
            BOUNDS.xMin + Math.random() * (BOUNDS.xMax - BOUNDS.xMin),
            BOUNDS.yMin + Math.random() * (BOUNDS.yMax - BOUNDS.yMin),
            BOUNDS.zNear - 1.0 - Math.random() * (BOUNDS.zNear - BOUNDS.zFar - 1.5)
        );
    }

    function makePod(imgObj) {
        const backing = new THREE.Mesh(
            new THREE.BoxGeometry(FRAME_MAX_W * 1.16, FRAME_MAX_H * 1.16, 0.06),
            new THREE.MeshStandardMaterial({ color: 0x4fb8d8, metalness: 0.7, roughness: 0.35 })
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

    function buildPods(n) {
        pods.forEach(p => { scene.remove(p.backing); scene.remove(p.image); });
        pods = [];
        activeUrls = new Set();

        pool    = shuffle(allImages);
        poolPtr = n - 1;

        const placed = [];
        for (let i = 0; i < n; i++) {
            const imgObj = pool[i];
            activeUrls.add(imgObj.url);
            const { backing, image } = makePod(imgObj);
            const pos = randomPosition(placed);
            placed.push(pos);
            pods.push({
                imgObj, backing, image,
                pos: pos.clone(),
                vel: randomVelocity(),
                spinAngle: Math.random() * Math.PI * 2,
                spinRate: (Math.random() - 0.5) * 0.6,
                hitting: false,
                hitT: 0,
                consuming: false,
                consumeT: 0,
            });
        }
    }

    function respawnPod(pod) {
        activeUrls.delete(pod.imgObj.url);
        const next = takeNextImage();
        if (next) {
            pod.imgObj = next;
            activeUrls.add(next.url);
        } else {
            activeUrls.add(pod.imgObj.url); // collection too small — keep existing image
        }
        pod.image.material.map = getTex(pod.imgObj.url, aspect => refitImagePlane(pod.image, aspect));
        pod.image.material.needsUpdate = true;

        pod.pos.copy(randomPosition(pods.filter(p => p !== pod).map(p => p.pos)));
        pod.vel = randomVelocity();
        pod.hitting = false;
        pod.hitT = 0;
        pod.consuming = false;
        pod.consumeT = 0;
        pod.image.material.opacity = 1;
        pod.backing.material.opacity = 1;
        pod.backing.scale.setScalar(1);
        pod.image.scale.setScalar(1);
    }

    function pickNewTarget() {
        const candidates = pods.filter(p => !p.hitting && !p.consuming);
        if (!candidates.length) return;
        const choice = candidates[Math.floor(Math.random() * candidates.length)];
        state.targetIndex = pods.indexOf(choice);
        targetImgEl.src = choice.imgObj.url;
    }

    /* ══════════════════════════════════════════════════════════════════
       POD UPDATE (drift + bounds + billboard every frame)
    ══════════════════════════════════════════════════════════════════ */
    function updatePods(dt) {
        clickable.length = 0;

        pods.forEach((pod, idx) => {
            if (pod.hitting) {
                pod.hitT = Math.min(1, pod.hitT + dt * 2.2);
                pod.backing.position.lerpVectors(pod.hitFrom, pod.hitTo, pod.hitT);
                pod.image.position.lerpVectors(pod.hitFrom, pod.hitTo, pod.hitT);
                const fade = Math.max(0, 1 - pod.hitT * 1.3);
                pod.backing.material.opacity = fade;
                pod.image.material.opacity   = fade;
                pod.backing.material.transparent = true;
                pod.image.material.transparent   = true;
                if (pod.hitT >= 1) respawnPod(pod);
                return;
            }

            if (pod.consuming) {
                pod.consumeT = Math.min(1, pod.consumeT + dt * 1.8);
                pod.backing.scale.setScalar(1 - pod.consumeT);
                pod.image.scale.setScalar(1 - pod.consumeT);
                if (pod.consumeT >= 1) {
                    const wasTarget = (state.targetIndex === idx);
                    respawnPod(pod);
                    if (wasTarget) pickNewTarget();
                }
                return;
            }

            // ── Drift + bounce ───────────────────────────────────────
            pod.pos.addScaledVector(pod.vel, dt);
            if (pod.pos.x < BOUNDS.xMin || pod.pos.x > BOUNDS.xMax) {
                pod.vel.x *= -1;
                pod.pos.x = Math.max(BOUNDS.xMin, Math.min(BOUNDS.xMax, pod.pos.x));
            }
            if (pod.pos.y < BOUNDS.yMin || pod.pos.y > BOUNDS.yMax) {
                pod.vel.y *= -1;
                pod.pos.y = Math.max(BOUNDS.yMin, Math.min(BOUNDS.yMax, pod.pos.y));
            }
            if (pod.pos.z > BOUNDS.zNear) {
                pod.vel.z *= -1;
                pod.pos.z = BOUNDS.zNear;
            }
            if (pod.pos.z < BOUNDS.zFar) {
                pod.consuming = true;
                pod.consumeT = 0;
                spawnHitParticles(pod.pos, 0xff6622, 16);
                return;
            }

            pod.spinAngle += pod.spinRate * dt;

            pod.backing.position.copy(pod.pos);
            pod.image.position.copy(pod.pos);
            pod.image.position.z += 0.045;

            pod.backing.lookAt(camera.position);
            // lookAt() points local -Z at the camera, which shows the plane's
            // back (mirrored) face — rotate 180° so the correct front face shows.
            pod.image.lookAt(camera.position);
            pod.image.rotateY(Math.PI);
            pod.backing.rotateZ(pod.spinAngle);
            pod.image.rotateZ(pod.spinAngle);

            const isHover = hoveredPod === pod;
            const scale = isHover ? 1.12 : 1.0;
            pod.backing.scale.setScalar(scale);
            pod.image.scale.setScalar(scale);

            clickable.push(pod.image);
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
                vel: new THREE.Vector3((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5),
                life: 1,
                maxLife: 0.4 + Math.random() * 0.3,
            });
        }
    }

    function updateParticles(dt) {
        for (let i = hitParticles.length - 1; i >= 0; i--) {
            const p = hitParticles[i];
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
        el.className = 'cb-float-text';
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
            const pod = pods.find(p => p.image === hits[0].object);
            hoveredPod = pod || null;
            canvasWrap.style.cursor = 'pointer';
        } else {
            hoveredPod = null;
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
        const pod = pods.find(p => p.image === hits[0].object);
        const idx = pods.indexOf(pod);
        if (!pod || pod.hitting || pod.consuming) return;

        if (idx === state.targetIndex) {
            state.combo = Math.min(8, state.combo + 1);
            const pts = 150 * state.combo;
            state.score += pts;
            scoreEl.textContent = state.score;
            comboEl.textContent = `×${state.combo}`;
            comboEl.classList.toggle('cb-combo--hot', state.combo >= 4);

            pod.hitting = true;
            pod.hitT = 0;
            pod.hitFrom = pod.image.position.clone();
            pod.hitTo = pod.image.position.clone();
            pod.hitTo.z += 3.0;

            spawnHitParticles(hitPoint, 0x44ddff, 22);
            spawnFloatText(hitPoint, `+${pts}`, '#44ddff');
            flashScreen('rgba(68,221,255,0.18)');

            pickNewTarget();
        } else {
            state.combo = 1;
            state.lives = Math.max(0, state.lives - 1);
            state.score = Math.max(0, state.score - 60);
            scoreEl.textContent = state.score;
            comboEl.textContent = '×1';
            comboEl.classList.remove('cb-combo--hot');
            renderLives();

            // Knock the wrong pod away as a "repel" punishment (no removal)
            const away = pod.pos.clone().sub(camera.position).normalize();
            pod.vel.copy(away.multiplyScalar(POD_SPEED * 2.2));

            spawnHitParticles(hitPoint, 0xff2244, 12);
            spawnFloatText(hitPoint, '−60', '#ff3355');
            flashScreen('rgba(255,0,40,0.28)');

            livesEl.classList.add('cb-shake');
            setTimeout(() => livesEl.classList.remove('cb-shake'), 380);

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

        updatePods(dt);
        updateParticles(dt);
        updateFloatTexts(ts);

        airlockRing.material.emissiveIntensity = 0.7 + Math.abs(Math.sin(elapsed * 2)) * 0.5;
        starField.rotation.y += dt * 0.005;

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
        pods.forEach(p => { scene.remove(p.backing); scene.remove(p.image); });
        pods = [];
        clickable.length = 0;

        hitParticles.forEach(p => { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); });
        hitParticles.length = 0;

        floatingTexts.forEach(f => f.el.remove());
        floatingTexts.length = 0;

        hoveredPod = null;
    }

    async function initGame() {
        if (allImages.length < 6) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 6 images to play!</div>';
            return;
        }

        clearScene();

        const podCount = Math.max(6, Math.min(9, allImages.length));
        buildPods(podCount);

        state = {
            active: true,
            score: 0,
            lives: 3,
            combo: 1,
            targetIndex: -1,
            startTime: Date.now(),
            elapsed: 0,
        };
        pickNewTarget();

        scoreEl.textContent = '0';
        timerEl.textContent = '0';
        comboEl.textContent = '×1';
        comboEl.classList.remove('cb-combo--hot');
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
                <i class="fas fa-satellite"></i>
                <h2>Bay Locked Down!</h2>
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
                gameType: 'cargobay',
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
        comboEl.classList.remove('cb-combo--hot');
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
                cbContainer.requestFullscreen().catch(err => console.warn(err));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === cbContainer;
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

    if (allImages.length < 6) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:1rem">Need at least 6 images to play!</div>';
        startBtn.disabled = true;
    }

    requestAnimationFrame(animate);
});

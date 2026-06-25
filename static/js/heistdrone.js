/**
 * Gallery Heist Drone — Three.js r134
 *
 * Free-fly a drone (Pointer Lock mouse-look + WASD + Space/Shift) through a
 * 3-room mansion connected by corridors. Paintings are billboarded onto the
 * walls; click while locked to scan whatever's under the center crosshair.
 *   • The HUD shows a target painting. Scan it (correct) for +pts (combo-
 *     scaled); the slot gets a fresh image and a new target is picked,
 *     possibly in a different room.
 *   • Sweeping ceiling spotlights patrol the rooms/corridors. Standing in
 *     a beam, or scanning the wrong painting, both cost a life from the
 *     same pool (1.5s of invulnerability after each beam-hit so lingering
 *     in a beam doesn't melt all 3 lives at once).
 *   • Collision is simple box-volume containment per room/corridor, not
 *     full mesh physics — good enough to keep the drone inside the mansion
 *     and force it through doorways.
 *   • 3 lives. The round is untimed — it only ends after 3 mistakes.
 *
 * Desktop-only: free-fly + mouse-look has no reasonable touch equivalent.
 *
 * gameType: 'heistdrone'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    if (typeof THREE === 'undefined') {
        console.error('Three.js failed to load — check CDN link.');
        return;
    }

    /* ── DOM ────────────────────────────────────────────────────────── */
    const hdContainer   = document.getElementById('hdContainer');
    const canvasWrap     = document.getElementById('hdCanvasWrap');
    const startBtn        = document.getElementById('startHdBtn');
    const resetBtn        = document.getElementById('resetHdBtn');
    const fsBtn            = document.getElementById('fullscreenHdBtn');
    const backBtn         = document.getElementById('backHdBtn');
    const scoreEl           = document.getElementById('hdScore');
    const timerEl           = document.getElementById('hdTimer');
    const livesEl           = document.getElementById('hdLives');
    const comboEl           = document.getElementById('hdCombo');
    const messageEl       = document.getElementById('hdMessage');
    const targetImgEl     = document.getElementById('hdTargetImg');
    const floatsLayerEl  = document.getElementById('hdFloatsLayer');
    const flashEl           = document.getElementById('hdFlash');
    const lockOverlayEl  = document.getElementById('hdLockOverlay');
    const crosshairEl     = document.getElementById('hdCrosshair');
    const usernameInput   = document.getElementById('hdUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;

    /* ══════════════════════════════════════════════════════════════════
       THREE.JS SCENE
    ══════════════════════════════════════════════════════════════════ */
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x06060a);
    scene.fog = new THREE.FogExp2(0x06060a, 0.035);

    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 60);
    const START_POS = new THREE.Vector3(0, 1.7, -1);
    camera.position.copy(START_POS);
    let yaw = 0, pitch = 0;

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
    // real aspect ratio so paintings can fit it without stretching/squashing.
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

    const FRAME_MAX_W = 1.25, FRAME_MAX_H = 1.55;

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
       MANSION LAYOUT (rooms + corridors as AABB collision zones)
    ══════════════════════════════════════════════════════════════════ */
    const ZONES = [
        { xMin: -4, xMax: 4, yMin: 0.3, yMax: 4.0, zMin: -9,  zMax: 0   }, // Room A — entry hall
        { xMin: -1, xMax: 1, yMin: 0.3, yMax: 3.0, zMin: -11, zMax: -9  }, // Corridor A→B
        { xMin: -5, xMax: 5, yMin: 0.3, yMax: 4.2, zMin: -19, zMax: -11 }, // Room B — gallery
        { xMin: -1, xMax: 1, yMin: 0.3, yMax: 3.0, zMin: -21, zMax: -19 }, // Corridor B→C
        { xMin: -4, xMax: 4, yMin: 0.3, yMax: 4.0, zMin: -28, zMax: -21 }, // Room C — vault antechamber
    ];

    function pointValid(p) {
        for (let i = 0; i < ZONES.length; i++) {
            const z = ZONES[i];
            if (p.x >= z.xMin && p.x <= z.xMax && p.y >= z.yMin && p.y <= z.yMax && p.z >= z.zMin && p.z <= z.zMax) return true;
        }
        return false;
    }

    function moveWithCollision(pos, delta) {
        const probe = pos.clone();
        probe.x += delta.x;
        if (pointValid(probe)) pos.x = probe.x;
        probe.copy(pos);
        probe.y += delta.y;
        if (pointValid(probe)) pos.y = probe.y;
        probe.copy(pos);
        probe.z += delta.z;
        if (pointValid(probe)) pos.z = probe.z;
    }

    const wallMat  = new THREE.MeshStandardMaterial({ color: 0x171b22, metalness: 0.2, roughness: 0.8 });
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x10090f, metalness: 0.3, roughness: 0.7 });
    const ceilMat  = new THREE.MeshStandardMaterial({ color: 0x0c0c10, metalness: 0.1, roughness: 0.9 });

    function buildRoomShell(zone, opts) {
        opts = opts || {};
        const w = zone.xMax - zone.xMin;
        const d = zone.zMax - zone.zMin;
        const h = zone.yMax - zone.yMin;
        const cx = (zone.xMin + zone.xMax) / 2;
        const cz = (zone.zMin + zone.zMax) / 2;

        const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(cx, zone.yMin, cz);
        scene.add(floor);

        const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilMat);
        ceiling.rotation.x = Math.PI / 2;
        ceiling.position.set(cx, zone.yMax, cz);
        scene.add(ceiling);

        if (!opts.skipSideWalls) {
            [-1, 1].forEach((side) => {
                const wall = new THREE.Mesh(new THREE.PlaneGeometry(d, h), wallMat);
                wall.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
                wall.position.set(side === -1 ? zone.xMin : zone.xMax, (zone.yMin + zone.yMax) / 2, cz);
                scene.add(wall);
            });
        }

        // Far wall (z = zMin), optionally split around a doorway gap
        if (opts.farDoor) {
            const segW = (zone.xMax - opts.farDoor.xMin);
            const leftSeg = new THREE.Mesh(new THREE.PlaneGeometry(opts.farDoor.xMin - zone.xMin, h), wallMat);
            leftSeg.position.set((zone.xMin + opts.farDoor.xMin) / 2, (zone.yMin + zone.yMax) / 2, zone.zMin);
            scene.add(leftSeg);
            const rightSeg = new THREE.Mesh(new THREE.PlaneGeometry(zone.xMax - opts.farDoor.xMax, h), wallMat);
            rightSeg.position.set((opts.farDoor.xMax + zone.xMax) / 2, (zone.yMin + zone.yMax) / 2, zone.zMin);
            scene.add(rightSeg);
        } else if (!opts.skipFarWall) {
            const farWall = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
            farWall.position.set(cx, (zone.yMin + zone.yMax) / 2, zone.zMin);
            scene.add(farWall);
        }
    }

    buildRoomShell(ZONES[0], { skipFarWall: true, farDoor: { xMin: -1, xMax: 1 } }); // Room A
    buildRoomShell(ZONES[1]);                                                        // Corridor A-B
    buildRoomShell(ZONES[2], { farDoor: { xMin: -1, xMax: 1 } });                     // Room B
    buildRoomShell(ZONES[3]);                                                        // Corridor B-C
    buildRoomShell(ZONES[4]);                                                        // Room C (solid dead-end wall)

    scene.add(new THREE.AmbientLight(0x1a1a28, 1.0));
    const heistKeyLight = new THREE.DirectionalLight(0x88aaff, 0.35);
    heistKeyLight.position.set(2, 8, 4);
    scene.add(heistKeyLight);

    /* ══════════════════════════════════════════════════════════════════
       SWEEPING SPOTLIGHTS
    ══════════════════════════════════════════════════════════════════ */
    function makeSpotlight(pos, baseYaw, basePitch, sweepRange, sweepSpeed, coneAngleDeg, coneLength) {
        const coneAngleRad = THREE.MathUtils.degToRad(coneAngleDeg);
        const coneRadius = Math.tan(coneAngleRad) * coneLength;

        const geo = new THREE.ConeGeometry(coneRadius, coneLength, 20, 1, true);
        geo.translate(0, -coneLength / 2, 0); // apex moved to local origin, cone extends toward -Y
        const beamMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            color: 0xff4433, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false,
        }));
        beamMesh.position.copy(pos);
        scene.add(beamMesh);

        const glow = new THREE.PointLight(0xff5533, 0.6, coneLength * 0.6);
        glow.position.copy(pos);
        scene.add(glow);

        return {
            pos: pos.clone(), beamMesh, glow,
            baseYaw, basePitch, sweepRange, sweepSpeed,
            coneAngleRad, coneLength,
            dir: new THREE.Vector3(0, -1, 0),
            cooldownPing: 0,
        };
    }

    function updateSpotlight(sp, elapsed) {
        const yawNow = sp.baseYaw + Math.sin(elapsed * sp.sweepSpeed) * sp.sweepRange;
        sp.dir.set(
            Math.cos(sp.basePitch) * Math.sin(yawNow),
            Math.sin(sp.basePitch),
            Math.cos(sp.basePitch) * Math.cos(yawNow)
        ).normalize();
        sp.beamMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), sp.dir);
    }

    function isInSpotlight(sp, playerPos) {
        const toPlayer = playerPos.clone().sub(sp.pos);
        const dist = toPlayer.length();
        if (dist > sp.coneLength || dist < 0.05) return false;
        toPlayer.normalize();
        const angle = Math.acos(THREE.MathUtils.clamp(toPlayer.dot(sp.dir), -1, 1));
        return angle <= sp.coneAngleRad;
    }

    const spotlights = [
        makeSpotlight(new THREE.Vector3(0, 3.9, -4.5), 0, -1.0, 0.9, 0.5, 26, 7),
        makeSpotlight(new THREE.Vector3(0, 2.8, -10),  0, -1.1, 0.3, 0.8, 20, 4.5),
        makeSpotlight(new THREE.Vector3(-2, 4.1, -14), 0.3, -1.0, 0.8, 0.45, 26, 7),
        makeSpotlight(new THREE.Vector3(2, 4.1, -16),  -0.3, -1.0, 0.8, 0.4, 26, 7),
        makeSpotlight(new THREE.Vector3(0, 2.8, -20),  0, -1.1, 0.3, 0.8, 20, 4.5),
        makeSpotlight(new THREE.Vector3(0, 3.9, -24.5), 0, -1.0, 0.9, 0.5, 26, 7),
    ];

    /* ══════════════════════════════════════════════════════════════════
       PAINTING SLOTS
    ══════════════════════════════════════════════════════════════════ */
    const SLOT_DEFS = [
        { x: -2.5, y: 2.0, z: -8.85 }, { x: 2.5, y: 2.0, z: -8.85 },
        { x: -3.85, y: 2.0, z: -5 },   { x: 3.85, y: 2.0, z: -5 },
        { x: -3, y: 2.2, z: -18.85 }, { x: 0, y: 2.2, z: -18.85 }, { x: 3, y: 2.2, z: -18.85 },
        { x: -4.85, y: 2.2, z: -15 }, { x: 4.85, y: 2.2, z: -15 },
        { x: -2.5, y: 2.0, z: -27.85 }, { x: 2.5, y: 2.0, z: -27.85 },
        { x: -3.85, y: 2.0, z: -24 }, { x: 3.85, y: 2.0, z: -24 },
    ];

    function makeFrameMesh() {
        const backing = new THREE.Mesh(
            new THREE.BoxGeometry(FRAME_MAX_W * 1.16, FRAME_MAX_H * 1.16, 0.05),
            new THREE.MeshStandardMaterial({ color: 0x2a2230, metalness: 0.55, roughness: 0.4 })
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
        } catch (e) { console.error('HeistDrone: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    let slots = [];
    let clickable = [];
    let pool = [];
    let poolPtr = -1;
    let activeUrls = new Set();
    let hitParticles = [];
    let floatingTexts = [];
    let hoveredSlot = null;

    function takeNextImage() {
        for (let tries = 0; tries < pool.length; tries++) {
            poolPtr = (poolPtr + 1) % pool.length;
            const cand = pool[poolPtr];
            if (!activeUrls.has(cand.url)) return cand;
        }
        return null;
    }

    function buildSlots() {
        slots.forEach(s => { scene.remove(s.backing); scene.remove(s.image); });
        slots = [];
        clickable.length = 0;
        activeUrls = new Set();

        const n = SLOT_DEFS.length;
        pool = shuffle(allImages);
        poolPtr = n - 1;

        SLOT_DEFS.forEach((def, i) => {
            const imgObj = pool[i];
            activeUrls.add(imgObj.url);
            const { backing, image } = makeFrameMesh();
            backing.position.set(def.x, def.y, def.z);
            image.position.set(def.x, def.y, def.z);
            slots.push({ imgObj, backing, image });
            clickable.push(image);
        });
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
    }

    function pickNewTarget() {
        if (!slots.length) return;
        const choice = slots[Math.floor(Math.random() * slots.length)];
        state.targetSlot = choice;
        targetImgEl.src = choice.imgObj.url;
    }

    /* ══════════════════════════════════════════════════════════════════
       STATE
    ══════════════════════════════════════════════════════════════════ */
    let state = { active: false, score: 0, lives: 3, combo: 1,
                  targetSlot: null, startTime: null, elapsed: 0, spotInvuln: 0 };

    /* ══════════════════════════════════════════════════════════════════
       SHARED FX HELPERS
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
        el.className = 'hd-float-text';
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

    function loseLife(reason) {
        state.combo = 1;
        state.lives = Math.max(0, state.lives - 1);
        comboEl.textContent = '×1';
        comboEl.classList.remove('hd-combo--hot');
        renderLives();
        flashScreen('rgba(255,0,40,0.3)');
        livesEl.classList.add('hd-shake');
        setTimeout(() => livesEl.classList.remove('hd-shake'), 380);
        if (state.lives <= 0) setTimeout(endGame, 550);
    }

    /* ══════════════════════════════════════════════════════════════════
       POINTER LOCK + INPUT
    ══════════════════════════════════════════════════════════════════ */
    const keys = { w: false, a: false, s: false, d: false, space: false, shift: false };
    const MOUSE_SENS = 0.0024;
    const MOVE_SPEED = 4.0;
    const UP_SPEED = 3.2;

    function isLocked() { return document.pointerLockElement === renderer.domElement; }

    canvasWrap.addEventListener('click', () => {
        if (!isLocked()) {
            renderer.domElement.requestPointerLock().catch(() => {});
            return;
        }
        if (!state.active) return;
        performScan();
    });

    document.addEventListener('pointerlockchange', () => {
        const locked = isLocked();
        lockOverlayEl.style.display = locked ? 'none' : 'flex';
        crosshairEl.style.display   = locked ? 'block' : 'none';
        if (!locked) {
            keys.w = keys.a = keys.s = keys.d = keys.space = keys.shift = false;
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (!isLocked()) return;
        yaw   -= e.movementX * MOUSE_SENS;
        pitch -= e.movementY * MOUSE_SENS;
        pitch = Math.max(-1.4, Math.min(1.4, pitch));
    });

    document.addEventListener('keydown', (e) => {
        if (!isLocked()) return;
        switch (e.code) {
            case 'KeyW': keys.w = true; break;
            case 'KeyA': keys.a = true; break;
            case 'KeyS': keys.s = true; break;
            case 'KeyD': keys.d = true; break;
            case 'Space': keys.space = true; e.preventDefault(); break;
            case 'ShiftLeft': case 'ShiftRight': keys.shift = true; break;
        }
    });
    document.addEventListener('keyup', (e) => {
        switch (e.code) {
            case 'KeyW': keys.w = false; break;
            case 'KeyA': keys.a = false; break;
            case 'KeyS': keys.s = false; break;
            case 'KeyD': keys.d = false; break;
            case 'Space': keys.space = false; break;
            case 'ShiftLeft': case 'ShiftRight': keys.shift = false; break;
        }
    });

    function updateMovement(dt) {
        camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));

        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const right   = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const move = new THREE.Vector3();
        if (keys.w) move.add(forward);
        if (keys.s) move.addScaledVector(forward, -1);
        if (keys.d) move.add(right);
        if (keys.a) move.addScaledVector(right, -1);
        if (move.lengthSq() > 0) move.normalize().multiplyScalar(MOVE_SPEED * dt);
        if (keys.space) move.y += UP_SPEED * dt;
        if (keys.shift) move.y -= UP_SPEED * dt;

        moveWithCollision(camera.position, move);
    }

    /* ══════════════════════════════════════════════════════════════════
       SCAN ACTION (raycast from screen center)
    ══════════════════════════════════════════════════════════════════ */
    const raycaster = new THREE.Raycaster();
    const CENTER = new THREE.Vector2(0, 0);

    function performScan() {
        raycaster.setFromCamera(CENTER, camera);
        const hits = raycaster.intersectObjects(clickable);
        if (!hits.length) return;

        const hitPoint = hits[0].point;
        const slot = slots.find(s => s.image === hits[0].object);
        if (!slot) return;

        if (slot === state.targetSlot) {
            state.combo = Math.min(8, state.combo + 1);
            const pts = 150 * state.combo;
            state.score += pts;
            scoreEl.textContent = state.score;
            comboEl.textContent = `×${state.combo}`;
            comboEl.classList.toggle('hd-combo--hot', state.combo >= 4);

            spawnHitParticles(hitPoint, 0x44ddff, 20);
            spawnFloatText(hitPoint, `+${pts}`, '#44ddff');
            flashScreen('rgba(68,221,255,0.18)');

            respawnSlot(slot);
            pickNewTarget();
        } else {
            state.score = Math.max(0, state.score - 60);
            scoreEl.textContent = state.score;
            spawnHitParticles(hitPoint, 0xff2244, 10);
            spawnFloatText(hitPoint, '−60', '#ff3355');
            loseLife('wrong-scan');
        }
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

        spotlights.forEach(sp => updateSpotlight(sp, elapsed));

        if (state.active && isLocked()) {
            updateMovement(dt);
            state.elapsed += dt;
            timerEl.textContent = Math.floor(state.elapsed);

            if (state.spotInvuln > 0) {
                state.spotInvuln -= dt;
            } else if (spotlights.some(sp => isInSpotlight(sp, camera.position))) {
                state.spotInvuln = 1.5;
                spawnFloatText(camera.position.clone().add(new THREE.Vector3(0, -0.3, -1)), 'SPOTTED!', '#ff5533');
                loseLife('spotted');
            }
        }

        // Billboard every painting toward the (now possibly moved) camera
        slots.forEach(slot => {
            slot.backing.lookAt(camera.position);
            slot.image.lookAt(camera.position);
            slot.image.rotateY(Math.PI);
            const isHover = hoveredSlot === slot;
            slot.backing.scale.setScalar(isHover ? 1.08 : 1.0);
            slot.image.scale.setScalar(isHover ? 1.08 : 1.0);
        });

        if (state.active && isLocked()) {
            raycaster.setFromCamera(CENTER, camera);
            const hits = raycaster.intersectObjects(clickable);
            hoveredSlot = hits.length ? slots.find(s => s.image === hits[0].object) : null;
        } else {
            hoveredSlot = null;
        }

        updateParticles(dt);
        updateFloatTexts(ts);

        renderer.render(scene, camera);
    }

    /* ══════════════════════════════════════════════════════════════════
       GAME LIFECYCLE
    ══════════════════════════════════════════════════════════════════ */
    function clearSlots() {
        slots.forEach(s => { scene.remove(s.backing); scene.remove(s.image); });
        slots = [];
        clickable.length = 0;
        hoveredSlot = null;
    }

    function clearFx() {
        hitParticles.forEach(p => { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); });
        hitParticles.length = 0;
        floatingTexts.forEach(f => f.el.remove());
        floatingTexts.length = 0;
    }

    async function initGame() {
        if (allImages.length < SLOT_DEFS.length) {
            messageEl.innerHTML = `<div class="feedback error">Need at least ${SLOT_DEFS.length} images to play!</div>`;
            return;
        }

        clearSlots();
        clearFx();
        buildSlots();

        camera.position.copy(START_POS);
        yaw = 0; pitch = 0;

        state = {
            active: true,
            score: 0,
            lives: 3,
            combo: 1,
            targetSlot: null,
            startTime: Date.now(),
            elapsed: 0,
            spotInvuln: 0,
        };
        pickNewTarget();

        scoreEl.textContent = '0';
        timerEl.textContent = '0';
        comboEl.textContent = '×1';
        comboEl.classList.remove('hd-combo--hot');
        renderLives();
        messageEl.innerHTML = '';

        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';
    }

    function endGame() {
        if (!state.active) return;
        state.active = false;
        if (document.pointerLockElement) document.exitPointerLock();

        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-helicopter"></i>
                <h2>Heist Blown!</h2>
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
                gameType: 'heistdrone',
                score: state.score,
                time: elapsed,
                username: user,
            })
        }).catch(() => {});
    }

    function resetGame() {
        state.active = false;
        if (document.pointerLockElement) document.exitPointerLock();
        clearSlots();
        clearFx();
        scoreEl.textContent = '0';
        timerEl.textContent = '0';
        comboEl.textContent = '×1';
        comboEl.classList.remove('hd-combo--hot');
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
                hdContainer.requestFullscreen().catch(err => console.warn(err));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === hdContainer;
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
        if (document.pointerLockElement) document.exitPointerLock();
        if (document.fullscreenElement) document.exitFullscreen();
        window.location.href = `/collection/${COLLECTION}`;
    });

    await loadCollection();
    handleResize();
    timerEl.textContent = '0';

    if (allImages.length < SLOT_DEFS.length) {
        messageEl.innerHTML = `<div class="feedback error" style="margin-top:1rem">Need at least ${SLOT_DEFS.length} images to play!</div>`;
        startBtn.disabled = true;
    }

    requestAnimationFrame(animate);
});

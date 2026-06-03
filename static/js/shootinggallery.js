/**
 * 3D Shooting Gallery — Three.js r134
 *
 * A fully 3D fairground shooting range.
 *   • Three barrier rows recede into the scene at different depths.
 *   • Target images (PlaneGeometry + texture) slide, bob, and pop behind
 *     the barriers. Decoy images mix in the crowd.
 *   • Move your mouse to aim a custom crosshair. Click to fire.
 *       Correct target → +pts (depth-scaled × combo). Combo climbs to ×8.
 *       Decoy          → −75 pts, −1 life, combo resets.
 *   • 3 lives. Game ends when the timer hits 0 or lives reach 0.
 *   • Carnival lights pulse, hit particles burst, floating score texts rise.
 *
 * gameType: 'shootinggallery'
 */
document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    if (typeof THREE === 'undefined') {
        console.error('Three.js failed to load — check CDN link.');
        return;
    }

    /* ── DOM ────────────────────────────────────────────────────────── */
    const sgContainer   = document.getElementById('sgContainer');
    const canvasWrap    = document.getElementById('sgCanvasWrap');
    const startBtn      = document.getElementById('startSgBtn');
    const resetBtn      = document.getElementById('resetSgBtn');
    const fsBtn         = document.getElementById('fullscreenSgBtn');
    const backBtn       = document.getElementById('backSgBtn');
    const scoreEl       = document.getElementById('sgScore');
    const timerEl       = document.getElementById('sgTimer');
    const livesEl       = document.getElementById('sgLives');
    const comboEl       = document.getElementById('sgCombo');
    const messageEl     = document.getElementById('sgMessage');
    const targetImgEl   = document.getElementById('sgTargetImg');
    const crosshairEl   = document.getElementById('sgCrosshair');
    const floatsLayerEl = document.getElementById('sgFloatsLayer');
    const flashEl       = document.getElementById('sgFlash');
    const durationSl    = document.getElementById('sgDuration');
    const durationValEl = document.getElementById('sgDurationVal');
    const usernameInput = document.getElementById('sgUsername');

    const savedUser = localStorage.getItem('imgur.username');
    if (savedUser) usernameInput.value = savedUser;
    durationSl.addEventListener('input', () => { durationValEl.textContent = durationSl.value; });

    /* ══════════════════════════════════════════════════════════════════
       THREE.JS SCENE
    ══════════════════════════════════════════════════════════════════ */
    const scene    = new THREE.Scene();
    scene.background = new THREE.Color(0x06030f);
    scene.fog        = new THREE.FogExp2(0x06030f, 0.048);

    const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 60);
    camera.position.set(0, 2.1, 8.0);
    camera.lookAt(0, 1.6, -1.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
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
    const texLoader = new THREE.TextureLoader();
    const texCache  = {};

    function getTex(url) {
        if (texCache[url]) return texCache[url];
        const t = texLoader.load(url);
        t.encoding = THREE.sRGBEncoding;
        texCache[url] = t;
        return t;
    }

    /* ── Row configuration (3 depth lanes) ─────────────────────────── */
    //  barrierY = height of the wooden plank top surface
    //  pts      = base score per hit (multiplied by combo)
    //  scale    = size scale for targets in this row (perspective simulation)
    //  speed    = base lateral speed factor
    const ROWS = [
        { z: -2.5,  scale: 1.00, barrierY: 1.05, pts: 100, speed: 1.3 },
        { z: -5.5,  scale: 0.67, barrierY: 0.78, pts: 220, speed: 1.9 },
        { z: -9.5,  scale: 0.44, barrierY: 0.55, pts: 380, speed: 2.7 },
    ];

    /* ══════════════════════════════════════════════════════════════════
       MATERIALS (reused across geometry)
    ══════════════════════════════════════════════════════════════════ */
    const matWoodDark  = new THREE.MeshLambertMaterial({ color: 0x3a1e0a });
    const matWoodMid   = new THREE.MeshLambertMaterial({ color: 0x5a300e });
    const matWoodLight = new THREE.MeshLambertMaterial({ color: 0x8b5a20 });
    const matWall      = new THREE.MeshLambertMaterial({ color: 0x18083a });
    const matCeiling   = new THREE.MeshLambertMaterial({ color: 0x0c0522 });

    /* ══════════════════════════════════════════════════════════════════
       LIGHTS
    ══════════════════════════════════════════════════════════════════ */
    scene.add(new THREE.AmbientLight(0x30185a, 1.1));

    // Front key light
    const keyLight = new THREE.DirectionalLight(0xffd0ff, 0.55);
    keyLight.position.set(0, 6, 9);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);

    // Spot down the lane
    const spotLane = new THREE.SpotLight(0xffffff, 1.0, 28, Math.PI / 7, 0.45);
    spotLane.position.set(0, 5.5, 1);
    spotLane.target.position.set(0, 1, -6);
    spotLane.castShadow = true;
    scene.add(spotLane);
    scene.add(spotLane.target);

    // Carnival bulb lights
    const BULB_COLS  = [0xff1a44, 0xffcc00, 0x00ddff, 0xff44ee, 0x44ffaa, 0xff8800];
    const BULB_XS    = [-5.5, -3.3, -1.1, 1.1, 3.3, 5.5];
    const carnivalPts = [];   // PointLight[]
    const carnivalBulbs = []; // Mesh[]

    BULB_COLS.forEach((col, i) => {
        const pl = new THREE.PointLight(col, 1.5, 9);
        pl.position.set(BULB_XS[i], 3.9, -1.2);
        scene.add(pl);
        carnivalPts.push(pl);

        const bulbMesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.13, 8, 8),
            new THREE.MeshBasicMaterial({ color: col })
        );
        bulbMesh.position.copy(pl.position);
        scene.add(bulbMesh);
        carnivalBulbs.push(bulbMesh);
    });

    /* ══════════════════════════════════════════════════════════════════
       ENVIRONMENT GEOMETRY
    ══════════════════════════════════════════════════════════════════ */

    // Floor
    const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(18, 32), matWoodDark);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(0, 0, -6);
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);

    // Back wall with alternating stripes
    for (let i = 0; i < 8; i++) {
        const s = new THREE.Mesh(
            new THREE.PlaneGeometry(1.75, 7),
            new THREE.MeshLambertMaterial({ color: i % 2 === 0 ? 0x28106a : 0x130630 })
        );
        s.position.set(-6.125 + i * 1.75, 3.5, -13.0);
        scene.add(s);
    }

    // Left / right side walls
    [-7.5, 7.5].forEach((x, idx) => {
        const w = new THREE.Mesh(new THREE.PlaneGeometry(32, 7), matWall);
        w.rotation.y = idx === 0 ? Math.PI / 2 : -Math.PI / 2;
        w.position.set(x, 3.5, -6);
        scene.add(w);
    });

    // Ceiling
    const ceilMesh = new THREE.Mesh(new THREE.PlaneGeometry(18, 32), matCeiling);
    ceilMesh.rotation.x = Math.PI / 2;
    ceilMesh.position.set(0, 4.4, -6);
    scene.add(ceilMesh);

    // Counter (front — where the player "stands")
    const counterTop = new THREE.Mesh(new THREE.BoxGeometry(15, 0.22, 0.7), matWoodMid);
    counterTop.position.set(0, 1.05, 6.2);
    counterTop.castShadow = true;
    scene.add(counterTop);
    const counterFace = new THREE.Mesh(new THREE.BoxGeometry(15, 0.85, 0.16), matWoodDark);
    counterFace.position.set(0, 0.6, 6.58);
    scene.add(counterFace);

    // Barriers — one plank + rail + posts per row
    ROWS.forEach(row => {
        // Main plank
        const plank = new THREE.Mesh(new THREE.BoxGeometry(14, 0.20, 0.30), matWoodMid);
        plank.position.set(0, row.barrierY, row.z);
        plank.castShadow = true;
        scene.add(plank);

        // Top rail (lighter wood)
        const rail = new THREE.Mesh(new THREE.BoxGeometry(14, 0.065, 0.11), matWoodLight);
        rail.position.set(0, row.barrierY + 0.13, row.z);
        scene.add(rail);

        // Support posts
        for (let px = -5.5; px <= 5.5; px += 2.75) {
            const post = new THREE.Mesh(
                new THREE.BoxGeometry(0.1, row.barrierY + 0.25, 0.1),
                matWoodDark
            );
            post.position.set(px, (row.barrierY + 0.25) / 2, row.z);
            scene.add(post);
        }
    });

    // Bunting string + flags across the front
    const stringMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.011, 0.011, 13.5, 4),
        new THREE.MeshBasicMaterial({ color: 0x777777 })
    );
    stringMesh.rotation.z = Math.PI / 2;
    stringMesh.position.set(0, 3.85, -1.2);
    scene.add(stringMesh);

    const buntingCols = [0xee1111, 0xff9900, 0xffee00, 0x00cc44, 0x0088ff, 0xff00bb];
    BULB_XS.forEach((bx, bi) => {
        const shape = new THREE.Shape();
        shape.moveTo(0, 0); shape.lineTo(0.3, 0); shape.lineTo(0.15, -0.42); shape.closePath();
        const flag = new THREE.Mesh(
            new THREE.ShapeGeometry(shape),
            new THREE.MeshBasicMaterial({ color: buntingCols[bi], side: THREE.DoubleSide })
        );
        flag.position.set(bx - 0.15, 3.86, -1.2);
        scene.add(flag);
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
        } catch (e) { console.error('ShootingGallery: load error', e); }
    }

    function shuffle(a) {
        const arr = a.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    let state = { active: false, score: 0, lives: 3, combo: 1, timeLeft: 60,
                  target: null, startTime: null };

    let targets       = [];   // active target objects
    let hitParticles  = [];   // {mesh, vel, life, maxLife}
    let floatingTexts = [];   // {el, startY, startTime}
    let decoyPool     = [];   // shuffled decoy images
    let shootableMeshes = []; // rebuilt each frame for raycaster
    let lastAutoSpawn = 0;    // seconds elapsed, for continuous spawning

    /* ══════════════════════════════════════════════════════════════════
       TARGET SPAWNING & MANAGEMENT
    ══════════════════════════════════════════════════════════════════ */
    const PATTERNS = ['slide', 'bob', 'pop'];

    function makeTarget(rowIdx, imgObj, isTarget) {
        const row = ROWS[rowIdx];
        const tw  = 0.92 * row.scale;
        const th  = 1.25 * row.scale;

        const geo = new THREE.PlaneGeometry(tw, th);
        const tex = getTex(imgObj.url);
        const mat = new THREE.MeshLambertMaterial({
            map: tex, side: THREE.DoubleSide, transparent: true, opacity: 1,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;

        const pattern = PATTERNS[Math.floor(Math.random() * PATTERNS.length)];
        const startX  = (Math.random() - 0.5) * 8.5;
        const baseY   = row.barrierY + th / 2 + 0.06;
        const hideY   = row.barrierY - th * 0.95;
        const initY   = (pattern === 'pop') ? hideY : baseY;

        mesh.position.set(startX, initY, row.z + 0.08);
        scene.add(mesh);

        const speedMult = 1 + Math.min(1.5, Math.floor(state.score / 1200) * 0.12);
        const rawSpd    = row.speed + Math.random() * 1.1;
        const vx        = (Math.random() < 0.5 ? 1 : -1) * rawSpd * speedMult;

        const tObj = {
            mesh, imgObj, isTarget,
            rowIdx, row, tw, th,
            baseY, hideY,
            pattern,
            x:          startX,
            vx,
            // bob
            bobPhase:   Math.random() * Math.PI * 2,
            bobSpeed:   0.65 + Math.random() * 0.7,
            bobAmp:     th * 0.42,
            // pop
            popState:   pattern === 'pop' ? 'down' : 'up',
            popTimer:   0,
            popUpDur:   1.7 + Math.random() * 1.6,
            popDownDur: 0.9 + Math.random() * 1.1,
            // spin (rare)
            spinY:      Math.random() < 0.25 ? (Math.random() - 0.5) * 1.5 : 0,
            // lifecycle
            alive:      true,
            visible:    pattern !== 'pop',
            age:        0,
            maxAge:     16 + Math.random() * 10,
            // hit animation
            hitting:    false,
            hitT:       0,
            hitFrom:    null,
            hitTo:      null,
        };
        targets.push(tObj);
        return tObj;
    }

    function destroyTarget(t) {
        scene.remove(t.mesh);
        t.mesh.geometry.dispose();
        t.mesh.material.dispose();
        t.alive = false;
    }

    function spawnWave() {
        // Guarantee at least one target per wave; fill remaining with 25-35% targets
        ROWS.forEach((_, ri) => {
            const count = 1 + Math.floor(Math.random() * 2);
            for (let k = 0; k < count; k++) {
                const forceTarget = (k === 0 && ri === 0); // first slot in front row always target
                const isT  = forceTarget || Math.random() < 0.30;
                const img  = isT
                    ? state.target
                    : decoyPool[Math.floor(Math.random() * decoyPool.length)];
                if (img) makeTarget(ri, img, isT);
            }
        });
    }

    function spawnOne() {
        if (!state.active) return;
        const ri  = Math.floor(Math.random() * ROWS.length);
        const isT = Math.random() < 0.30;
        const img = isT ? state.target : decoyPool[Math.floor(Math.random() * decoyPool.length)];
        if (img) makeTarget(ri, img, isT);
    }

    /* ══════════════════════════════════════════════════════════════════
       TARGET PHYSICS UPDATE
    ══════════════════════════════════════════════════════════════════ */
    function updateTargets(dt, elapsed) {
        shootableMeshes.length = 0;

        for (let i = targets.length - 1; i >= 0; i--) {
            const t = targets[i];
            if (!t.alive) { targets.splice(i, 1); continue; }

            // ── Hit-fly animation ──────────────────────────────────
            if (t.hitting) {
                t.hitT = Math.min(1, t.hitT + dt * 2.5);
                t.mesh.position.lerpVectors(t.hitFrom, t.hitTo, t.hitT);
                t.mesh.rotation.z += dt * 5.0;
                t.mesh.material.opacity = Math.max(0, 1 - t.hitT * 1.4);
                if (t.hitT >= 1) destroyTarget(t);
                continue;
            }

            t.age += dt;
            if (t.age > t.maxAge) { destroyTarget(t); continue; }

            // ── Lateral movement (all patterns) ─────────────────────
            t.x += t.vx * dt;
            if (t.x > 5.8 || t.x < -5.8) {
                t.vx *= -1;
                t.x   = Math.max(-5.8, Math.min(5.8, t.x));
            }
            t.mesh.position.x = t.x;

            // ── Vertical pattern ─────────────────────────────────────
            if (t.pattern === 'slide') {
                t.mesh.position.y = t.baseY;
                t.visible = true;

            } else if (t.pattern === 'bob') {
                const newY = t.baseY + Math.sin(elapsed * t.bobSpeed + t.bobPhase) * t.bobAmp;
                t.mesh.position.y = newY;
                t.visible = (newY > t.row.barrierY + 0.05);

            } else { // pop
                t.popTimer += dt;
                let targetY;
                if (t.popState === 'up') {
                    targetY = t.baseY;
                    if (t.popTimer >= t.popUpDur) { t.popState = 'down'; t.popTimer = 0; }
                } else {
                    targetY = t.hideY;
                    if (t.popTimer >= t.popDownDur) { t.popState = 'up'; t.popTimer = 0; }
                }
                // Smooth lerp for pop
                t.mesh.position.y += (targetY - t.mesh.position.y) * Math.min(1, dt * 8);
                t.visible = (t.mesh.position.y > t.row.barrierY + 0.08);
            }

            // ── Spin ─────────────────────────────────────────────────
            if (t.spinY !== 0) t.mesh.rotation.y += t.spinY * dt;

            // Only add visible targets to the raycaster list
            if (t.visible) shootableMeshes.push(t.mesh);
        }
    }

    /* ══════════════════════════════════════════════════════════════════
       HIT PARTICLES  (per-particle geometry for safe disposal)
    ══════════════════════════════════════════════════════════════════ */
    function spawnHitParticles(worldPos, colHex, count) {
        for (let i = 0; i < count; i++) {
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(0.048, 4, 4),
                new THREE.MeshBasicMaterial({ color: colHex })
            );
            mesh.position.copy(worldPos);
            scene.add(mesh);
            hitParticles.push({
                mesh,
                vel: new THREE.Vector3(
                    (Math.random() - 0.5) * 7,
                    Math.random() * 6 + 1,
                    Math.random() * 3 + 0.5
                ),
                life:    1,
                maxLife: 0.38 + Math.random() * 0.32,
            });
        }
    }

    function updateParticles(dt) {
        for (let i = hitParticles.length - 1; i >= 0; i--) {
            const p = hitParticles[i];
            p.vel.y -= 9.8 * dt;
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
       FLOATING SCORE TEXTS  (HTML divs projected from 3-D)
    ══════════════════════════════════════════════════════════════════ */
    function worldToCanvas(worldPos) {
        const v = worldPos.clone().project(camera);
        const r = renderer.domElement.getBoundingClientRect();
        return { x: (v.x + 1) / 2 * r.width, y: (-v.y + 1) / 2 * r.height };
    }

    function spawnFloatText(worldPos, text, color) {
        const { x, y } = worldToCanvas(worldPos);
        const el = document.createElement('div');
        el.className  = 'sg-float-text';
        el.textContent = text;
        el.style.left  = x + 'px';
        el.style.top   = y + 'px';
        el.style.color = color;
        floatsLayerEl.appendChild(el);
        floatingTexts.push({ el, startY: y, startTime: performance.now() });
    }

    function updateFloatTexts(ts) {
        for (let i = floatingTexts.length - 1; i >= 0; i--) {
            const f  = floatingTexts[i];
            const p  = Math.min(1, (ts - f.startTime) / 1100);
            f.el.style.top     = (f.startY - p * 72) + 'px';
            f.el.style.opacity = 1 - p * p;
            if (p >= 1) { f.el.remove(); floatingTexts.splice(i, 1); }
        }
    }

    /* ══════════════════════════════════════════════════════════════════
       SCREEN FLASH
    ══════════════════════════════════════════════════════════════════ */
    function flashScreen(bg) {
        flashEl.style.background = bg;
        flashEl.style.opacity    = '1';
        // Double rAF to let the opacity:1 paint before we start fading
        requestAnimationFrame(() => requestAnimationFrame(() => {
            flashEl.style.opacity = '0';
        }));
    }

    /* ══════════════════════════════════════════════════════════════════
       CROSSHAIR & AIMING
    ══════════════════════════════════════════════════════════════════ */
    const raycaster = new THREE.Raycaster();
    const mouseNDC  = new THREE.Vector2();
    let   mouseWrapX = 0, mouseWrapY = 0;

    canvasWrap.addEventListener('mousemove', e => {
        const r = canvasWrap.getBoundingClientRect();
        mouseWrapX = e.clientX - r.left;
        mouseWrapY = e.clientY - r.top;
        crosshairEl.style.left    = mouseWrapX + 'px';
        crosshairEl.style.top     = mouseWrapY  + 'px';
        crosshairEl.style.display = 'block';

        mouseNDC.set(
            (mouseWrapX / r.width)  * 2 - 1,
            -(mouseWrapY / r.height) * 2 + 1
        );
        raycaster.setFromCamera(mouseNDC, camera);
        const onTarget = raycaster.intersectObjects(shootableMeshes).length > 0;
        crosshairEl.classList.toggle('sg-crosshair--aim', onTarget);
    });

    canvasWrap.addEventListener('mouseleave', () => {
        crosshairEl.style.display = 'none';
    });

    /* ══════════════════════════════════════════════════════════════════
       SHOOTING
    ══════════════════════════════════════════════════════════════════ */
    canvasWrap.addEventListener('click', e => {
        if (!state.active) return;

        const r = canvasWrap.getBoundingClientRect();
        mouseNDC.set(
            ((e.clientX - r.left) / r.width)  * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1
        );
        raycaster.setFromCamera(mouseNDC, camera);
        const hits = raycaster.intersectObjects(shootableMeshes);
        if (!hits.length) return;

        const hitMesh  = hits[0].object;
        const hitPoint = hits[0].point;
        const tObj     = targets.find(t => t.mesh === hitMesh && t.alive && !t.hitting);
        if (!tObj) return;

        // Launch hit-fly animation
        tObj.hitting = true;
        tObj.hitT    = 0;
        tObj.hitFrom = tObj.mesh.position.clone();
        tObj.hitTo   = tObj.mesh.position.clone();
        tObj.hitTo.z += 3.0;
        tObj.hitTo.y -= 2.0;

        // Remove from shootable list immediately
        const idx = shootableMeshes.indexOf(hitMesh);
        if (idx !== -1) shootableMeshes.splice(idx, 1);

        // ── Correct target ────────────────────────────────────────
        if (tObj.isTarget) {
            state.combo  = Math.min(8, state.combo + 1);
            const pts    = tObj.row.pts * state.combo;
            state.score += pts;
            scoreEl.textContent = state.score;
            comboEl.textContent = `×${state.combo}`;
            comboEl.classList.toggle('sg-combo--hot', state.combo >= 4);

            spawnHitParticles(hitPoint, 0x00ff88, 22);
            spawnFloatText(hitPoint, `+${pts}`, '#00ff88');
            flashScreen('rgba(0,255,100,0.16)');

            crosshairEl.classList.add('sg-crosshair--fired');
            setTimeout(() => crosshairEl.classList.remove('sg-crosshair--fired'), 180);

            // Schedule a replacement target
            setTimeout(spawnOne, 700 + Math.random() * 600);

        // ── Decoy ─────────────────────────────────────────────────
        } else {
            state.combo  = 1;
            state.lives  = Math.max(0, state.lives - 1);
            state.score  = Math.max(0, state.score - 75);
            scoreEl.textContent = state.score;
            comboEl.textContent = '×1';
            comboEl.classList.remove('sg-combo--hot');
            renderLives();

            spawnHitParticles(hitPoint, 0xff2244, 14);
            spawnFloatText(hitPoint, '−75', '#ff3355');
            flashScreen('rgba(255,0,40,0.30)');

            livesEl.classList.add('sg-shake');
            setTimeout(() => livesEl.classList.remove('sg-shake'), 380);

            if (state.lives <= 0) setTimeout(endGame, 550);
        }
    });

    // Touch support — treat as click at touch point
    canvasWrap.addEventListener('touchend', e => {
        e.preventDefault();
        const t   = e.changedTouches[0];
        const r   = canvasWrap.getBoundingClientRect();
        const fakeClick = new MouseEvent('click', {
            clientX: t.clientX, clientY: t.clientY, bubbles: true
        });
        canvasWrap.dispatchEvent(fakeClick);
    }, { passive: false });

    /* ══════════════════════════════════════════════════════════════════
       CARNIVAL LIGHT PULSE
    ══════════════════════════════════════════════════════════════════ */
    function updateCarnivalLights(elapsed) {
        carnivalPts.forEach((pl, i) => {
            pl.intensity = 0.85 + 0.75 * Math.abs(Math.sin(elapsed * 2.1 + i * 1.05));
        });
    }

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
        const dt      = Math.min((ts - prevTs) / 1000, 0.05);
        prevTs        = ts;
        const elapsed = ts / 1000;

        updateCarnivalLights(elapsed);
        updateTargets(dt, elapsed);
        updateParticles(dt);
        updateFloatTexts(ts);

        if (state.active) {
            // Countdown timer
            state.timeLeft -= dt;
            timerEl.textContent = Math.max(0, Math.ceil(state.timeLeft));
            if (state.timeLeft <= 0) endGame();

            // Auto-refill the gallery if it gets thin
            const aliveCount = targets.filter(t => t.alive && !t.hitting).length;
            if (elapsed - lastAutoSpawn > 3.0 && aliveCount < 7) {
                spawnOne();
                lastAutoSpawn = elapsed;
            }
        }

        renderer.render(scene, camera);
    }

    /* ══════════════════════════════════════════════════════════════════
       GAME LIFECYCLE
    ══════════════════════════════════════════════════════════════════ */
    function clearScene() {
        targets.forEach(t => {
            scene.remove(t.mesh);
            t.mesh.geometry.dispose();
            t.mesh.material.dispose();
        });
        targets.length = 0;

        hitParticles.forEach(p => {
            scene.remove(p.mesh);
            p.mesh.geometry.dispose();
            p.mesh.material.dispose();
        });
        hitParticles.length = 0;

        floatingTexts.forEach(f => f.el.remove());
        floatingTexts.length = 0;
        shootableMeshes.length = 0;
    }

    async function initGame() {
        if (allImages.length < 4) {
            messageEl.innerHTML = '<div class="feedback error">Need at least 4 images to play!</div>';
            return;
        }

        clearScene();

        const duration = parseInt(durationSl.value, 10);
        const target   = allImages[Math.floor(Math.random() * allImages.length)];
        decoyPool = shuffle(allImages.filter(img => img.url !== target.url));

        // Eagerly load target + first batch of decoy textures
        getTex(target.url);
        decoyPool.slice(0, 20).forEach(img => getTex(img.url));

        state = {
            active:    true,
            score:     0,
            lives:     3,
            combo:     1,
            timeLeft:  duration,
            target,
            startTime: Date.now(),
        };

        lastAutoSpawn = 0;
        scoreEl.textContent  = '0';
        timerEl.textContent  = duration;
        comboEl.textContent  = '×1';
        comboEl.classList.remove('sg-combo--hot');
        renderLives();
        messageEl.innerHTML  = '';
        targetImgEl.src      = target.url;

        startBtn.style.display = 'none';
        resetBtn.style.display = 'inline-block';

        // Initial wave + a second wave 2 s later to fill the range
        spawnWave();
        setTimeout(() => { if (state.active) spawnWave(); }, 2000);
    }

    function endGame() {
        if (!state.active) return;
        state.active = false;

        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        messageEl.innerHTML = `
            <div class="victory-message">
                <i class="fas fa-crosshairs"></i>
                <h2>${state.lives > 0 ? "Time's Up!" : 'Game Over!'}</h2>
                <p>Final Score: <strong>${state.score}</strong></p>
            </div>`;

        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'inline-block';

        const user = (usernameInput.value.trim()) || 'Anonymous';
        localStorage.setItem('imgur.username', user);
        fetch('/api/submit-score', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collection: COLLECTION,
                gameType:   'shootinggallery',
                score:      state.score,
                time:       elapsed,
                username:   user,
            })
        }).catch(() => {});
    }

    function resetGame() {
        state.active = false;
        clearScene();
        scoreEl.textContent  = '0';
        timerEl.textContent  = durationSl.value;
        comboEl.textContent  = '×1';
        comboEl.classList.remove('sg-combo--hot');
        livesEl.textContent  = '❤️❤️❤️';
        messageEl.innerHTML  = '';
        targetImgEl.src      = '';
        startBtn.style.display = 'inline-block';
        resetBtn.style.display = 'none';
    }

    /* ══════════════════════════════════════════════════════════════════
       FULLSCREEN
    ══════════════════════════════════════════════════════════════════ */
    if (fsBtn) {
        fsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                sgContainer.requestFullscreen().catch(err => console.warn(err));
            } else {
                document.exitFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            const isFS = document.fullscreenElement === sgContainer;
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
    timerEl.textContent = durationSl.value;

    if (allImages.length < 4) {
        messageEl.innerHTML = '<div class="feedback error" style="margin-top:1rem">Need at least 4 images to play!</div>';
        startBtn.disabled   = true;
    }

    requestAnimationFrame(animate);
});

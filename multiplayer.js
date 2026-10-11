/* =====================================================================
 *  Tactical FPS Arena 3D - 1v1 multiplayer add-on
 *  Loaded AFTER the main game script, so it shares the game's globals
 *  (state, player, scene, camera, WEAPONS, ...). Solo mode is untouched.
 * ===================================================================== */
(function () {
    'use strict';

    const SEND_MS = 50;          // network tick for player state
    const RESPAWN_MS = 3000;
    const PROTECT_MS = 2000;     // spawn protection

    const M = {
        mode: 'solo',            // solo | public | create | join
        joinCode: '',
        ws: null,
        phase: 'idle',           // idle | connecting | waiting | found | playing | over
        inMatch: false,
        started: false,          // both players ready and countdown finished
        idx: 0, limit: 10, kills: [0, 0],
        opps: new Map(), ffa: false, myId: -1, board: [], lastBy: -1, streakN: 0, streakT: 0,
        frozen: false, dead: false, respawnAt: 0, protectUntil: 0,
        pendingStart: null, lastSend: 0, lastHud: 0, tracers: []
    };

    /* ---------------------------------------------------------------
     *  UI
     * --------------------------------------------------------------- */
    const css = document.createElement('style');
    css.textContent = `
        #mp-mode, #mp-wait, #mp-result { position:absolute; inset:0; z-index:60; display:none; justify-content:center; align-items:center; background:rgba(6,8,13,.92); }
        .mp-card { width:440px; max-width:94vw; padding:30px 34px; text-align:center; border-radius:10px; }
        .mp-card .btn { margin-top:10px; }
        .mp-card .title { font-size:26px; }
        .mp-code { font:900 46px 'Orbitron',sans-serif; letter-spacing:10px; color:#00ff9d; margin:14px 0 4px; text-shadow:0 0 18px rgba(0,255,157,.45); }
        .mp-msg { color:#9eafc2; font-size:14px; letter-spacing:2px; margin:12px 0 6px; min-height:20px; }
        .mp-score { font:900 40px 'Orbitron',sans-serif; margin:10px 0 4px; color:#fff; }
        .mp-divider { height:1px; background:var(--line); margin:14px 0 4px; }
        #mp-hud { display:none; }
        body.mp-active #mp-hud { display:flex; }
        body.mp-active .hud-top:not(#mp-hud), body.mp-active #mission-panel { display:none !important; }
        #mp-hud .me b { color:var(--cyan); } #mp-hud .op b { color:var(--red); }
        #mp-hud .mid b { font-size:13px; color:#fff; letter-spacing:1px; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; }
        #mp-oppbar { display:none; position:absolute; top:84px; left:50%; transform:translateX(-50%); width:200px; height:6px; background:rgba(0,0,0,.55); border:1px solid #2a3442; }
        body.mp-active #mp-oppbar { display:block; }
        #mp-board { display:none; position:absolute; top:84px; right:18px; min-width:150px; padding:8px 10px; background:rgba(6,8,13,.72); border:1px solid #2a3442; font:700 12px Orbitron,sans-serif; letter-spacing:1px; color:#cfd8e3; }
        body.mp-ffa #mp-board { display:block; }
        body.mp-ffa #mp-oppbar { display:none !important; }
        #mp-board div { display:flex; justify-content:space-between; gap:14px; padding:2px 0; }
        #mp-board .me { color:#00e5ff; }
        #mp-oppbar i { display:block; height:100%; width:100%; background:var(--red); box-shadow:0 0 8px var(--red); transition:width .1s linear; }
    `;
    document.head.appendChild(css);

    const make = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; };

    const modeEl = make(`
        <div id="mp-mode"><div class="menu-card glass mp-card">
            <h1 class="title">SELECT MODE</h1>
            <div class="sub">CHOOSE HOW TO PLAY</div>
            <button class="btn green" data-mode="solo">SOLO &middot; WAVES VS BOTS</button>
            <div class="mp-divider"></div>
            <button class="btn green" data-mode="ffa">FFA &middot; 20-PLAYER FREE-FOR-ALL</button>
            <button class="btn" data-mode="public">1V1 &middot; PUBLIC MATCH (RANDOM MAP)</button>
            <button class="btn" data-mode="create">1V1 &middot; CREATE PRIVATE ROOM</button>
            <input id="mp-code-input" class="input-field" placeholder="ROOM CODE" maxlength="4" style="text-transform:uppercase;text-align:center">
            <button class="btn" data-mode="join">1V1 &middot; JOIN WITH CODE</button>
            <div class="mp-msg" id="mp-mode-msg"></div>
            <button class="btn grey" data-mode="cancel">CANCEL</button>
        </div></div>`);

    const waitEl = make(`
        <div id="mp-wait"><div class="menu-card glass mp-card">
            <h1 class="title" id="mp-wait-title">1V1 MATCH</h1>
            <div class="sub" id="mp-wait-sub"></div>
            <div class="mp-code" id="mp-wait-code" style="display:none"></div>
            <div class="mp-msg" id="mp-wait-msg"></div>
            <button class="btn green" id="mp-ready-btn" style="display:none">READY &mdash; FIGHT!</button>
            <button class="btn grey" id="mp-cancel-btn">CANCEL</button>
        </div></div>`);

    const resultEl = make(`
        <div id="mp-result"><div class="menu-card glass mp-card">
            <h1 class="title" id="mp-result-title">VICTORY</h1>
            <div class="sub" id="mp-result-sub"></div>
            <div class="mp-score" id="mp-result-score">0 - 0</div>
            <button class="btn" id="mp-result-btn">RETURN TO ARMORY</button>
        </div></div>`);

    const hudEl = make(`
        <div id="mp-hud" class="hud-top glass">
            <div class="me"><small>YOU</small><b id="mp-me">0</b></div>
            <div class="mid"><small id="mp-limit">FIRST TO 10</small><b id="mp-oppname">OPPONENT</b></div>
            <div class="op"><small id="mp-opplabel">OPP</small><b id="mp-opp">0</b></div>
        </div>`);
    const oppBar = make('<div id="mp-oppbar"><i></i></div>');
    const boardEl = make('<div id="mp-board"></div>');
    const esc = (t) => String(t).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');

    document.body.append(modeEl, waitEl, resultEl);
    $('hud').append(hudEl, oppBar, boardEl);

    /* ---------- original function references ---------- */
    const _deploy = window.deployToCombat;
    const _showStep = window.showDeployStep;
    const _fire = window.fireShot;
    const _die = window.die;
    const _startWave = window.startWave;
    const _updateWaves = window.updateWaves;
    const _updatePlayer = window.updatePlayer;
    const _radar = window.drawRadar;
    const _pause = window.pauseGame;
    const _setWeapon = window.setWeapon;

    /* ---------- mode picker ---------- */
    function openModePicker() {
        $('mp-code-input').value = '';
        $('mp-mode-msg').textContent = '';
        modeEl.style.display = 'flex';
    }
    modeEl.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
        const mode = b.dataset.mode;
        if (mode === 'cancel') { modeEl.style.display = 'none'; return; }
        if (mode === 'join') {
            const code = $('mp-code-input').value.trim().toUpperCase();
            if (code.length !== 4) { $('mp-mode-msg').textContent = 'ENTER THE 4-CHARACTER ROOM CODE'; return; }
            M.joinCode = code;
        }
        M.mode = mode;
        modeEl.style.display = 'none';
        openDeploymentSelection();
    }));

    // replace the lobby DEPLOY button so it opens the mode picker first
    const oldBtn = $('deploy-btn');
    const newBtn = oldBtn.cloneNode(true);
    oldBtn.parentNode.replaceChild(newBtn, oldBtn);
    newBtn.addEventListener('click', openModePicker);

    /* ---------- deployment flow tweaks ---------- */
    window.showDeployStep = function (step) {
        const oneVone = M.mode !== 'solo';
        const skipMap = M.mode === 'public' || M.mode === 'join' || M.mode === 'ffa';
        if (skipMap && step === 3) {              // map is random / chosen by the room host
            $('operator-select-overlay').style.display = 'none';
            window.deployToCombat();
            return;
        }
        _showStep(step);
        if (!oneVone) return;
        const names = { public: '1V1 PUBLIC', create: '1V1 PRIVATE', join: '1V1 JOIN', ffa: 'FREE-FOR-ALL' };
        const total = skipMap ? 2 : 3;
        $('deploy-step-label').textContent = 'DEPLOYMENT // ' + names[M.mode] + ' // STEP 0' + step + ' OF 0' + total;
        $('deploy-step-count').textContent = '0' + step + ' / 0' + total;
        if (skipMap && step === 2) {
            $('deploy-next-btn').textContent = M.mode === 'public' ? '\u25B6  FIND MATCH' : M.mode === 'ffa' ? '\u25B6  JOIN ARENA' : '\u25B6  JOIN ROOM';
            $('ability-help').textContent = M.mode === 'join' ? 'The room host picked the map.' : 'The server picks a random map.';
        }
        if (M.mode === 'create' && step === 3) $('deploy-next-btn').textContent = '\u25B6  CREATE ROOM';
    };

    window.deployToCombat = function () {
        if (M.mode === 'solo') return _deploy();
        startMatchmaking();
    };

    /* ---------- waiting overlay ---------- */
    function showWait(msg, o = {}) {
        $('mp-wait-title').textContent = o.title || '1V1 MATCH';
        $('mp-wait-sub').textContent = o.sub || '';
        const code = $('mp-wait-code');
        code.style.display = o.code ? 'block' : 'none';
        code.textContent = o.code || '';
        $('mp-wait-msg').textContent = msg;
        $('mp-ready-btn').style.display = o.ready ? 'block' : 'none';
        $('mp-ready-btn').innerHTML = o.readyLabel || 'READY &mdash; FIGHT!';
        $('mp-cancel-btn').textContent = o.cancelLabel || 'CANCEL';
        waitEl.style.display = 'flex';
    }
    const hideWait = () => { waitEl.style.display = 'none'; };

    function fail(msg) {
        closeSocket();
        M.phase = 'idle';
        M.pendingStart = null;
        showWait(msg, { title: 'CONNECTION PROBLEM', cancelLabel: 'BACK' });
    }

    $('mp-cancel-btn').addEventListener('click', () => {
        if (M.ws) send({ t: 'cancel' });
        closeSocket();
        M.opps.clear();
        M.phase = 'idle'; M.mode = 'solo'; M.pendingStart = null;
        hideWait();
    });

    /* ---------- networking ---------- */
    function serverUrl() {
        const q = new URLSearchParams(location.search).get('server');
        const host = q || location.host;
        if (!host) return null;
        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + host;
    }
    function send(obj) { const ws = M.ws; if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
    function closeSocket() {
        const ws = M.ws;
        M.ws = null;
        if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (_) {} }
    }
    const profile = () => ({ name: username, op: selectedOperatorId, ab: selectedAbilityId, w: selectedWeaponIndex });

    function startMatchmaking() {
        const url = serverUrl();
        if (!url) { showWait('OPEN THE GAME FROM THE SERVER ADDRESS (NOT FROM A FILE)', { title: 'NO SERVER', cancelLabel: 'BACK' }); return; }
        M.phase = 'connecting';
        showWait('CONNECTING TO SERVER...');
        closeSocket();
        let ws;
        try { ws = new WebSocket(url); } catch (e) { fail('COULD NOT CONNECT TO THE SERVER'); return; }
        M.ws = ws;
        ws.onopen = () => {
            if (M.mode === 'public') send(Object.assign({ t: 'find' }, profile()));
            else if (M.mode === 'ffa') send(Object.assign({ t: 'ffa' }, profile()));
            else if (M.mode === 'create') send(Object.assign({ t: 'create', map: $('map-select').value }, profile()));
            else if (M.mode === 'join') send(Object.assign({ t: 'join', code: M.joinCode }, profile()));
        };
        ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } handle(m); };
        ws.onerror = () => { if (M.ws === ws && M.phase === 'connecting') fail('COULD NOT REACH THE MULTIPLAYER SERVER'); };
        ws.onclose = () => {
            if (M.ws !== ws) return;
            M.ws = null;
            if (M.phase === 'connecting' || M.phase === 'waiting' || M.phase === 'found') fail('CONNECTION LOST');
            else if (M.inMatch && M.phase === 'playing') endLocal(-1, 'disconnect');
        };
    }

    function handle(m) {
        switch (m.t) {
            case 'waiting': M.phase = 'waiting'; showWait('SEARCHING FOR AN OPPONENT...', { sub: 'PUBLIC MATCH \u00B7 RANDOM MAP' }); break;
            case 'created': M.phase = 'waiting'; showWait('WAITING FOR YOUR FRIEND TO JOIN...', { code: m.code, sub: 'PRIVATE ROOM \u00B7 SHARE THIS CODE' }); break;
            case 'err': fail(m.msg || 'SOMETHING WENT WRONG'); break;
            case 'start': onFound(m); break;
            case 'go': onGo(); break;
            case 's': onState(m); break;
            case 'f': onRemoteShot(m); break;
            case 'h': onHitMe(m); break;
            case 'k': onKill(m); break;
            case 'end': endLocal(m.winner, m.reason, m.kills); break;
            case 'fstart': onFfaStart(m); break;
            case 'fjoin': { const o = newOpp(m.p.id, m.p); M.opps.set(m.p.id, o); if (M.inMatch) buildOpponent(o); break; }
            case 'fleave': { const o = M.opps.get(m.id); if (o) { if (o.mesh) disposeBot(o.mesh); M.opps.delete(m.id); } break; }
            case 'fend': endLocal(m.winner, 'ffa', null, m.board); break;
        }
    }

    /* ---------- match found / ready ---------- */
    const newOpp = (id, p) => ({ id, name: p.name, op: p.op, w: p.w, mesh: null, alive: true, seen: false, hp: 100, walk: 0, yaw: 0,
                                 pos: new THREE.Vector3(0, -100, 0), tx: 0, ty: 0, tz: 0, tyaw: 0 });

    function onFfaStart(m) {
        M.phase = 'found'; M.ffa = true;
        M.myId = m.id; M.idx = 0; M.limit = m.limit || 15; M.board = m.board || []; M.kills = [0, 0];
        M.opps.forEach((o) => { if (o.mesh) disposeBot(o.mesh); });
        M.opps.clear();
        (m.players || []).forEach((p) => M.opps.set(p.id, newOpp(p.id, p)));
        M.pendingStart = m;
        const label = MAPS[m.map] ? MAPS[m.map].label : m.map;
        showWait('MAP: ' + label + '  \u00B7  ' + (M.opps.size + 1) + ' / 20 IN ARENA', { title: 'ARENA READY', sub: 'FREE-FOR-ALL \u00B7 FIRST TO ' + m.limit, ready: true, readyLabel: '\u25B6  ENTER ARENA', cancelLabel: 'LEAVE' });
    }

    function onFound(m) {
        M.phase = 'found';
        M.idx = m.you; M.limit = m.limit || 10; M.kills = [0, 0];
        M.pendingStart = m;
        M.ffa = false; M.opps.clear();
        M.opps.set('o', newOpp('o', m.opp));
        const label = MAPS[m.map] ? MAPS[m.map].label : m.map;
        showWait('MAP: ' + label, { title: 'MATCH FOUND', sub: 'VS ' + m.opp.name.toUpperCase(), ready: true, cancelLabel: 'LEAVE' });
    }

    function enterMatch(m) {
        hideWait();
        if (MAPS[m.map]) $('map-select').value = m.map;      // original deploy applies the selected map
        M.inMatch = true; M.phase = 'playing'; M.frozen = !M.ffa; M.dead = false; M.started = M.ffa;
        document.body.classList.add('mp-active');
        document.body.classList.toggle('mp-ffa', M.ffa);
        _deploy();                                            // builds HUD, starts the match, locks the pointer
        placeAtSpawn(true);
        M.opps.forEach((o) => buildOpponent(o));
        updateHud(true);
        if (M.ffa) {
            M.protectUntil = performance.now() + PROTECT_MS;
            announce('FREE-FOR-ALL \u00B7 FIRST TO ' + M.limit, '#00ff9d');
            speak('Free for all. First to ' + M.limit + ' kills.');
        } else {
            announce('WAITING FOR OPPONENT...', '#00e5ff');
            send({ t: 'ready' });
        }
    }
    $('mp-ready-btn').addEventListener('click', () => { if (M.pendingStart) enterMatch(M.pendingStart); });

    function onGo() {
        if (!M.inMatch || M.phase !== 'playing') return;
        let n = 3;
        announce(String(n), '#ffb300');
        const iv = setInterval(() => {
            if (!M.inMatch || M.phase !== 'playing') { clearInterval(iv); return; }
            n--;
            if (n > 0) { announce(String(n), '#ffb300'); return; }
            clearInterval(iv);
            M.frozen = false; M.started = true;
            announce('FIGHT!', '#00ff9d');
            sfx.wave();
        }, 1000);
    }

    /* ---------- spawning ---------- */
    function placeAtSpawn(initial) {
        let pick = null;
        if (initial && !M.ffa) {
            const list = M.idx === 0 ? [[-45, 45], [45, 45], [0, 45], [-30, 45]] : [[45, -45], [-45, -45], [0, -45], [30, -45]];
            for (const c of list) if (!hitsSolid(c[0], 0, c[1], 0.8, 2.6)) { pick = c; break; }
        } else {
            let best = -1;
            const all = SPAWN_POINTS.concat([[-45, 45], [45, 45], [-45, -45], [45, -45], [-30, 0], [30, 0]]);
            for (const c of all) {
                if (hitsSolid(c[0], 0, c[1], 0.8, 2.6)) continue;
                let d = 1e9;
                M.opps.forEach((o) => { if (o.seen && o.alive) d = Math.min(d, Math.hypot(c[0] - o.pos.x, c[1] - o.pos.z)); });
                d = Math.min(d, 90) + Math.random() * 25;
                if (d > best) { best = d; pick = c; }
            }
        }
        if (!pick) { const p = pickFreePoint(0, false); pick = [p.x, p.z]; }
        player.pos.set(pick[0], 0, pick[1]);
        player.vel.set(0, 0, 0);
        player.vy = 0; player.pitch = 0;
        player.yaw = Math.atan2(pick[0], pick[1]);
    }

    /* ---------- opponent model ---------- */
    function buildOpponent(o) {
        const bot = buildBotModel('grunt');
        bot.scale.setScalar(0.68);                            // matches the player's size
        bot.userData.plate.color.setHex(0xff3d57);            // hostile red plating
        bot.userData.bar.visible = false;
        bot.visible = false;
        scene.add(bot);
        o.mesh = bot;
    }

    function onState(m) {
        const o = M.opps.get(m.id === undefined ? 'o' : m.id);
        if (!o) return;
        const wasAlive = o.alive;
        o.tx = m.x; o.ty = m.y; o.tz = m.z; o.tyaw = m.yaw;
        o.hp = m.hp; o.alive = !!m.al;
        if (!o.seen || (!wasAlive && o.alive)) { o.pos.set(m.x, m.y, m.z); o.yaw = m.yaw; o.seen = true; }
    }

    function onRemoteShot(m) {
        const o = M.opps.get(m.id === undefined ? 'o' : m.id);
        if (!o || !M.inMatch) return;
        const w = WEAPONS[m.w] || WEAPONS[0];
        const origin = new THREE.Vector3(m.o[0], m.o[1], m.o[2]);
        const dir = new THREE.Vector3(m.d[0], m.d[1], m.d[2]).normalize();
        const mesh = new THREE.Mesh(bulletGeo, tracerMat(0xff6a3d));
        mesh.position.copy(origin);
        mesh.lookAt(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z);
        scene.add(mesh);
        M.tracers.push({ mesh, dir, life: 0.45 });
        shotSound(w, clamp(1 / (1 + origin.distanceTo(player.pos) * 0.05), 0.08, 0.9));
    }

    function onHitMe(m) {
        if (!M.inMatch || M.phase !== 'playing' || M.frozen || M.dead) return;
        if (performance.now() < M.protectUntil) return;
        const a = M.opps.get(m.from === undefined ? 'o' : m.from);
        if (m.from !== undefined) M.lastBy = m.from;
        damagePlayer(Math.min(400, +m.dmg || 0), a && a.mesh ? a.mesh.position : null);
    }

    function onKill(m) {
        if (M.ffa) {
            M.board = m.board || M.board;
            const nm = (id) => id === M.myId ? 'YOU' : (M.opps.get(id) ? M.opps.get(id).name.toUpperCase() : 'PLAYER');
            if (m.killer === M.myId) { sfx.kill(); killVoice(); addFeed('YOU ELIMINATED ' + nm(m.victim), false, true); }
            else if (m.victim === M.myId) addFeed((m.killer >= 0 ? nm(m.killer) : 'SOMEONE') + ' ELIMINATED YOU', false, true);
            else addFeed(nm(m.killer) + ' ELIMINATED ' + nm(m.victim), false, false);
            updateHud(true);
            return;
        }
        M.kills = m.kills;
        const op1 = M.opps.get('o');
        const oppName = op1 ? op1.name : 'OPPONENT';
        if (m.killer === M.idx) { sfx.kill(); killVoice(); addFeed('YOU ELIMINATED ' + oppName.toUpperCase(), false, true); }
        else addFeed(oppName.toUpperCase() + ' ELIMINATED YOU', false, true);
        updateHud(true);
    }

    /* ---------- hit detection (shooter side) ---------- */
    const _rc = new THREE.Raycaster();
    const _o = new THREE.Vector3(), _base = new THREE.Vector3(), _dir = new THREE.Vector3();

    function hitscan() {
        const res = new Map();     // opponent id -> { dmg, head, point }
        const targets = [];
        M.opps.forEach((o) => { if (o.mesh && o.alive && o.seen) targets.push(o); });
        if (!targets.length) return res;
        const w = currentWeapon(), op = currentOperator();
        camera.updateMatrixWorld(true);
        camera.getWorldPosition(_o);
        camera.getWorldDirection(_base);
        const moveFactor = clamp(Math.hypot(player.vel.x, player.vel.z) / CFG.playerSpeed, 0, 1) * 0.6 + (player.grounded ? 0 : 1);
        const sp = w.spread * op.spread * (1 + bloom * 0.06 + moveFactor) * (1 - 0.65 * adsT);
        const R = 0.55, H = 1.85, HEAD = 1.33;
        for (let p = 0; p < w.pellets; p++) {
            _dir.copy(_base);
            _dir.x += (Math.random() - 0.5) * 2 * sp;
            _dir.y += (Math.random() - 0.5) * 2 * sp;
            _dir.z += (Math.random() - 0.5) * 2 * sp;
            _dir.normalize();
            const a = _dir.x * _dir.x + _dir.z * _dir.z;
            if (a < 1e-6) continue;
            let bestT = Infinity, best = null, bestY = 0;
            for (const o of targets) {
                const ox = _o.x - o.pos.x, oz = _o.z - o.pos.z;
                const b = ox * _dir.x + oz * _dir.z, c = ox * ox + oz * oz - R * R;
                const disc = b * b - a * c;
                if (disc < 0) continue;
                const sq = Math.sqrt(disc);
                let t = (-b - sq) / a;
                if (t < 0) t = (-b + sq) / a;
                if (t < 0 || t > 200) continue;
                const y = _o.y + _dir.y * t - o.pos.y;
                if (y < 0 || y > H) continue;
                if (t < bestT) { bestT = t; best = o; bestY = y; }
            }
            if (!best) continue;
            _rc.set(_o, _dir); _rc.near = 0; _rc.far = bestT;
            if (_rc.intersectObjects(solids, false).length) continue;      // a wall is in the way
            const head = bestY > HEAD;
            let r = res.get(best.id);
            if (!r) { r = { dmg: 0, head: false, point: null }; res.set(best.id, r); }
            r.dmg += w.damage * op.damage * (head ? 2 : 1);
            if (head) r.head = true;
            if (!r.point) r.point = new THREE.Vector3().copy(_o).addScaledVector(_dir, bestT);
        }
        return res;
    }

    window.fireShot = function (now) {
        if (!M.inMatch) return _fire(now);
        if (M.frozen || M.dead || M.phase !== 'playing') return;
        const hits = hitscan();
        const dir = camera.getWorldDirection(new THREE.Vector3());
        _fire(now);
        const mz = muzzleAnchor.getWorldPosition(new THREE.Vector3());
        send({ t: 'f', o: [mz.x, mz.y, mz.z], d: [dir.x, dir.y, dir.z], w: selectedWeaponIndex });
        hits.forEach((hit, id) => {
            if (hit.dmg <= 0) return;
            const msg = { t: 'h', dmg: Math.round(hit.dmg * 10) / 10, head: hit.head };
            if (M.ffa) msg.to = id;
            send(msg);
            const o = M.opps.get(id);
            if (o) o.hp = Math.max(0, o.hp - hit.dmg);
            showHitmarker(hit.head);
            sfx.hit(hit.head);
            if (hit.point) spawnSparks(hit.point, hit.head ? 7 : 4, hit.head ? sparkMats.white : sparkMats.cyan, 4.5, 0.3);
        });
    };

    /* ---------- death / respawn ---------- */
    window.die = function () {
        if (!M.inMatch) return _die();
        if (M.dead || M.phase !== 'playing') return;
        M.dead = true;
        M.respawnAt = performance.now() + RESPAWN_MS;
        mouseHeld = false; adsHeld = false;
        announce('ELIMINATED', '#ff3d57');
        M.streakN = 0;
        send({ t: 'd', by: M.lastBy });
    };

    function respawn() {
        M.dead = false; M.lastBy = -1;
        player.health = 100;
        setHealthHud();
        placeAtSpawn(false);
        WEAPONS.forEach((w, i) => { ammo[i] = w.mag; });
        cancelReload();
        updateAmmoHud();
        M.protectUntil = performance.now() + PROTECT_MS;
        announce('RESPAWNED', '#00ff9d');
    }

    /* ---------- end of match ---------- */
    function endLocal(winner, reason, kills, board) {
        if (!M.inMatch || M.phase === 'over') return;
        M.phase = 'over';
        if (kills) M.kills = kills;
        updateHud(true);
        state = 'dead';
        mouseHeld = false; adsHeld = false;
        document.exitPointerLock();
        $('hud').style.display = 'none';

        const title = $('mp-result-title');
        let text, sub = '';
        const won = M.ffa ? winner === M.myId : winner === M.idx;
        if (won) { text = 'VICTORY'; title.style.background = 'linear-gradient(135deg,#00ff9d,#00b8ff)'; }
        else if (winner === -1) { text = 'MATCH ENDED'; title.style.background = 'linear-gradient(135deg,#7d8da1,#4a5568)'; }
        else { text = 'DEFEAT'; title.style.background = 'linear-gradient(135deg,#ff3d57,#a30f26)'; }
        title.style.webkitBackgroundClip = 'text'; title.style.backgroundClip = 'text'; title.style.webkitTextFillColor = 'transparent';
        if (reason === 'left') sub = 'YOUR OPPONENT LEFT THE MATCH';
        else if (reason === 'timeout') sub = 'OPPONENT DID NOT GET READY';
        else if (reason === 'disconnect') sub = 'CONNECTION TO THE SERVER WAS LOST';
        else if (M.ffa) {
            const bd = (board || M.board).slice().sort((a, b) => b.k - a.k);
            const nm = (id) => id === M.myId ? 'YOU' : (M.opps.get(id) ? M.opps.get(id).name.toUpperCase() : 'PLAYER');
            sub = 'TOP: ' + bd.slice(0, 3).map((r, i) => (i + 1) + '. ' + nm(r.id) + ' ' + r.k).join('   ');
        }
        else sub = 'FIRST TO ' + M.limit + ' KILLS';
        title.textContent = text;
        $('mp-result-sub').textContent = sub;
        if (M.ffa) {
            const mine = (board || M.board).find((r) => r.id === M.myId) || { k: 0, d: 0 };
            $('mp-result-score').textContent = mine.k + ' KILLS  \u00B7  ' + mine.d + ' DEATHS';
        } else $('mp-result-score').textContent = M.kills[M.idx] + '  -  ' + M.kills[1 - M.idx];
        if (text !== 'MATCH ENDED') speak(text === 'VICTORY' ? 'Victory' : 'Defeat');
        $('pause-screen').style.display = 'none';
        resultEl.style.display = 'flex';
    }

    function cleanup(sendLeave) {
        if (sendLeave && M.ws) send({ t: 'leave' });
        closeSocket();
        M.opps.forEach((o) => { if (o.mesh) disposeBot(o.mesh); });
        M.opps.clear();
        for (const t of M.tracers) scene.remove(t.mesh);
        M.tracers.length = 0;
        M.inMatch = false; M.phase = 'idle'; M.ffa = false; M.board = [];
        M.frozen = false; M.dead = false; M.started = false;
        M.mode = 'solo'; M.pendingStart = null;
        document.body.classList.remove('mp-active', 'mp-ffa');
        resultEl.style.display = 'none';
        hideWait();
    }

    $('mp-result-btn').addEventListener('click', () => { returnToLobby(); cleanup(true); });
    $('quit-btn').addEventListener('click', () => { if (M.inMatch) cleanup(true); });

    /* ---------- wrappers that keep solo-only systems out of 1v1 ---------- */
    window.startWave = function (n) {
        if (M.inMatch) { wave = n; waveState = 'mp'; return; }
        return _startWave(n);
    };
    window.updateWaves = function (dt) { if (!M.inMatch) return _updateWaves(dt); };

    window.updatePlayer = function (dt, now) {
        if (M.inMatch && (M.frozen || M.dead)) {
            for (const k in keys) keys[k] = false;
            mouseHeld = false; adsHeld = false;
        }
        return _updatePlayer(dt, now);
    };

    window.setWeapon = function (i) { if (M.inMatch) return; return _setWeapon(i); };   // fixed loadout in 1v1

    window.pauseGame = function () {
        if (!M.inMatch) { document.querySelector('#pause-screen .title').textContent = 'PAUSED'; return _pause(); }
        if (M.phase !== 'playing') return;
        // the match keeps running while the menu is open, so the state stays 'playing'
        mouseHeld = false; adsHeld = false;
        for (const k in keys) keys[k] = false;
        document.querySelector('#pause-screen .title').textContent = 'MATCH MENU';
        $('sens').value = settings.sens;
        $('vol').value = settings.volume;
        $('pause-screen').style.display = 'flex';
    };
    document.addEventListener('pointerlockchange', () => {
        if (M.inMatch && document.pointerLockElement === $('game-canvas')) $('pause-screen').style.display = 'none';
    });

    window.drawRadar = function (now) {
        _radar(now);
        if (!M.inMatch) return;
        const s = Math.sin(player.yaw), c = Math.cos(player.yaw);
        M.opps.forEach((o) => {
            if (!o.seen || !o.alive) return;
            const dx = o.pos.x - player.pos.x, dz = o.pos.z - player.pos.z;
            let sx = RS * (c * dx - s * dz), sy = RS * (s * dx + c * dz);
            const len = Math.hypot(sx, sy), maxR = RAD - 8;
            if (len > maxR) { sx *= maxR / len; sy *= maxR / len; }
            rctx.setTransform(1, 0, 0, 1, 0, 0);
            rctx.fillStyle = Math.floor(now / 250) % 2 === 0 ? '#ff3d57' : '#ff8a99';
            rctx.strokeStyle = '#fff'; rctx.lineWidth = 1;
            rctx.beginPath(); rctx.arc(RAD + sx, RAD + sy, 4, 0, Math.PI * 2); rctx.fill(); rctx.stroke();
        });
    };

    /* ---------- HUD ---------- */
    function updateHud(force) {
        const now = performance.now();
        if (!force && now - M.lastHud < 100) return;
        M.lastHud = now;
        $('mp-limit').textContent = 'FIRST TO ' + M.limit;
        if (M.ffa) {
            const bd = M.board.slice().sort((a, b) => b.k - a.k);
            const me = bd.find((r) => r.id === M.myId);
            const rank = bd.findIndex((r) => r.id === M.myId) + 1;
            $('mp-me').textContent = me ? me.k : 0;
            $('mp-opplabel').textContent = 'RANK';
            $('mp-opp').textContent = '#' + (rank || 1);
            $('mp-oppname').textContent = (M.opps.size + 1) + ' PLAYERS';
            const nm = (id) => id === M.myId ? 'YOU' : (M.opps.get(id) ? M.opps.get(id).name : 'PLAYER');
            boardEl.innerHTML = bd.slice(0, 5).map((r) => '<div class="' + (r.id === M.myId ? 'me' : '') + '"><span>' + esc(nm(r.id).slice(0, 12)) + '</span><b>' + r.k + '</b></div>').join('');
            return;
        }
        const o = M.opps.get('o');
        $('mp-opplabel').textContent = 'OPP';
        $('mp-me').textContent = M.kills[M.idx];
        $('mp-opp').textContent = M.kills[1 - M.idx];
        $('mp-oppname').textContent = o ? o.name.toUpperCase() : 'OPPONENT';
        oppBar.firstChild.style.width = (o ? clamp(o.hp, 0, 100) : 100) + '%';
    }

    /* ---------- main per-frame work ---------- */
    let last = performance.now();
    function tick(now) {
        requestAnimationFrame(tick);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!M.inMatch) return;

        // opponent interpolation + simple walk animation
        M.opps.forEach((o) => {
        if (o.mesh) {
            o.mesh.visible = o.seen && o.alive;
            if (o.seen) {
                const k = 1 - Math.exp(-dt * 14);
                const px = o.pos.x, pz = o.pos.z;
                o.pos.x += (o.tx - o.pos.x) * k;
                o.pos.y += (o.ty - o.pos.y) * k;
                o.pos.z += (o.tz - o.pos.z) * k;
                let dy = o.tyaw - o.yaw;
                dy = Math.atan2(Math.sin(dy), Math.cos(dy));
                o.yaw += dy * k;
                o.mesh.position.copy(o.pos);
                o.mesh.rotation.y = o.yaw + Math.PI;
                const moved = Math.hypot(o.pos.x - px, o.pos.z - pz);
                const ud = o.mesh.userData;
                if (moved / Math.max(dt, 0.001) > 1) o.walk += moved * 2.4;
                const sw = moved / Math.max(dt, 0.001) > 1 ? Math.sin(o.walk) * 0.75 : 0;
                ud.legL.rotation.x = sw; ud.legR.rotation.x = -sw;
                ud.armL.rotation.x = -sw * 0.32; ud.armR.rotation.x = sw * 0.22;
            }
        }
        });

        // opponent tracers
        for (let i = M.tracers.length - 1; i >= 0; i--) {
            const t = M.tracers[i];
            t.life -= dt;
            t.mesh.position.addScaledVector(t.dir, 190 * dt);
            if (t.life <= 0 || insideSolid(t.mesh.position)) { scene.remove(t.mesh); M.tracers.splice(i, 1); }
        }

        const pnow = performance.now();
        if (M.phase === 'playing') {
            if (M.dead && pnow >= M.respawnAt) respawn();
            if (pnow - M.lastSend >= SEND_MS) {
                M.lastSend = pnow;
                send({ t: 's', x: +player.pos.x.toFixed(2), y: +player.pos.y.toFixed(2), z: +player.pos.z.toFixed(2),
                       yaw: +player.yaw.toFixed(3), pitch: +player.pitch.toFixed(3),
                       hp: Math.max(0, Math.round(player.health)), al: M.dead ? 0 : 1 });
            }
        }
        updateHud(false);
    }
    requestAnimationFrame(tick);

    /* ---------- lobby layout: more room for the weapon list, options moved aside ---------- */
    const layoutCss = document.createElement('style');
    layoutCss.textContent = `
        .sidebar > .map-picker-panel { display:none !important; }
        .sidebar > .feature-panel:not(.map-picker-panel) { position:absolute; left:calc(100vw - 262px); top:84px; width:244px; margin:0; z-index:5; background:rgba(7,10,17,.88); backdrop-filter:blur(8px); }
        .sidebar .deploy { padding:14px; margin-top:8px; }
        .sidebar .hint { margin-top:8px; font-size:11px; line-height:1.5; }
    `;
    document.head.appendChild(layoutCss);

    const opts = document.querySelector('.sidebar > .feature-panel:not(.map-picker-panel)');
    if (opts) {
        opts.querySelector('h4').textContent = 'SERVER & AI';
        const limitRow = $('player-limit') && $('player-limit').closest('.feature-row');
        if (limitRow) limitRow.innerHTML = '<label>SERVER</label><span id="mp-server-status" style="font:700 12px Orbitron,sans-serif;letter-spacing:1px;color:#7d8da1">CHECKING...</span>';
        const note = opts.querySelector('.feature-note');
        if (note) note.textContent = 'UP TO 20 PLAYERS ONLINE: 20-PLAYER FREE-FOR-ALL OR 1V1 MATCHES. SOLO MAP IS CHOSEN WHEN YOU DEPLOY.';
    }

    function pollStatus() {
        const el = $('mp-server-status');
        if (!el || state !== 'lobby') return;
        fetch('/status', { cache: 'no-store' }).then((r) => r.json()).then((s) => {
            el.textContent = '● ' + s.online + ' / ' + s.max + ' ONLINE';
            el.style.color = s.online >= s.max ? '#ff3d57' : '#00ff9d';
        }).catch(() => { el.textContent = '○ OFFLINE'; el.style.color = '#7d8da1'; });
    }
    /* ---------- announcer voice (browser speech, no audio files) ---------- */
    function speak(text) {
        try {
            const ss = window.speechSynthesis;
            if (!ss) return;
            ss.cancel();
            const u = new SpeechSynthesisUtterance(text);
            u.rate = 1.05; u.pitch = 0.75; u.volume = 1;
            ss.speak(u);
        } catch (_) {}
    }
    function killVoice() {
        const n = performance.now();
        M.streakN = n - M.streakT < 5000 ? M.streakN + 1 : 1;
        M.streakT = n;
        const L = ['', '', 'Double kill', 'Triple kill', 'Quad kill', 'Rampage', 'Unstoppable'];
        if (M.streakN >= 2) speak(L[Math.min(M.streakN, 6)]);
    }
    if (typeof sfx !== 'undefined' && sfx.achievement) {
        const _ach = sfx.achievement;
        sfx.achievement = function () {
            _ach.apply(this, arguments);
            const t = $('achievement-title') ? $('achievement-title').textContent : '';
            setTimeout(() => speak('Achievement unlocked. ' + t), 400);
        };
    }

    setInterval(pollStatus, 5000);
    setTimeout(pollStatus, 1500);
})();

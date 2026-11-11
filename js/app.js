/* Afterglow — sessions, study mode, gallery, stats, garden, share card, UI.
   No network calls. Everything is kept in localStorage on this device. */
(function () {
  'use strict';
  const AG = window.AG, S = AG.S, B = AG.B, clamp = AG.clamp, A = AG.audio, V = AG.view, reduced = AG.reduced;
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const DAY = 86400000, CHECK_EVERY = 25 * 60, GRACE = 10000;
  const fmt = (sec) => { sec = Math.max(0, Math.ceil(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };

  /* ---------- storage ---------- */
  const KEY = 'afterglow.v1'; let mem = null;
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return mem || {}; } }
  function save() { mem = db; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
  let db = Object.assign({ sessions: [], subjects: ['Maths', 'Coding', 'Reading', 'Revision'], exam: null, me: '', breakMin: 5, room: null, boards: {} }, load());
  const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  const cap = (v) => (v ? v[0].toUpperCase() + v.slice(1) : v);

  function encode(d) {
    const u = new Uint8Array(S * B + 2 * S); u.set(d.bands, 0); u.set(d.hue, S * B); u.set(d.flag, S * B + S);
    let s = ''; for (let i = 0; i < u.length; i += 4096) s += String.fromCharCode.apply(null, u.subarray(i, i + 4096));
    return btoa(s);
  }
  const cache = new Map();
  function decode(rec) {
    if (cache.has(rec.id)) return cache.get(rec.id);
    const d = AG.emptyData();
    try { const s = atob(rec.data); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
      d.bands.set(u.subarray(0, S * B)); d.hue.set(u.subarray(S * B, S * B + S)); d.flag.set(u.subarray(S * B + S, S * B + 2 * S)); } catch (e) {}
    cache.set(rec.id, d); return d;
  }

  /* ---------- examples (clearly labelled, never counted as yours) ---------- */
  function synth(seed, hues, dist) {
    const r = AG.rng(seed), d = AG.emptyData(), ph = r() * 9, ph2 = r() * 9;
    for (let s = 0; s < S; s++) {
      const hi = Math.min(hues.length - 1, Math.floor((s / S) * hues.length));
      d.hue[s] = Math.round((hues[hi] / 360) * 255);
      for (let b = 0; b < B; b++) {
        let v = 0.45 + 0.3 * Math.sin(s * 0.06 + b * 0.55 + ph) + 0.2 * Math.sin(s * 0.19 - b * 0.9 + ph2) + 0.12 * (r() - 0.5);
        v *= 1 - b / 40;
        d.bands[s * B + b] = clamp(v, 0.05, 1) * 255;
      }
    }
    dist.forEach((t) => { const s = Math.floor(t * S); d.flag[s] = 255; if (s + 1 < S) d.flag[s + 1] = 255; });
    return d;
  }
  const now0 = Date.now();
  const EXAMPLES = [
    { id: 'ex1', ts: now0 - DAY * 1 - 3600e3, planned: 3000, focused: 2790, away: 210, score: 88, subject: 'Maths', dist: [0.62], tracks: { 'Night Desk': 1700, 'Rain on Glass': 1300 }, hues: [226, 190], seed: 11 },
    { id: 'ex2', ts: now0 - DAY * 2 - 7200e3, planned: 1500, focused: 1500, away: 0, score: 100, subject: 'Coding', dist: [], tracks: { 'Slow Tide': 1500 }, hues: [163], seed: 23 },
    { id: 'ex3', ts: now0 - DAY * 4 - 5000e3, planned: 5400, focused: 4380, away: 1020, score: 71, subject: 'Reading', dist: [0.3, 0.55, 0.8], tracks: { 'Paper Lanterns': 2400, 'Deep Field': 1800, 'Night Desk': 1200 }, hues: [30, 268, 226], seed: 37 },
  ].map((e) => { e.example = true; cache.set(e.id, synth(e.seed, e.hues, e.dist)); return e; });
  const records = () => (db.sessions.length ? db.sessions : EXAMPLES);

  /* ---------- toast ---------- */
  let toastT;
  function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms || 4200); }

  /* ---------- sculpture source: rolling preview / live session / saved view ---------- */
  let mode = 'roll', viewRec = null, hueNow = 215, rollK = 0, rollAcc = 0;
  const roll = AG.emptyData();
  function hueTarget() { return A.current ? A.current.hue : 212 + 22 * Math.sin(rollK * 0.012); }
  function stepHue(rate) { let d = ((hueTarget() - hueNow + 540) % 360) - 180; hueNow = (hueNow + d * rate + 360) % 360; }
  function synBand(b, k) {
    let v = 0.42 + 0.3 * Math.sin(k * 0.045 + b * 0.55) + 0.18 * Math.sin(k * 0.11 - b * 0.9) + 0.1 * Math.sin(k * 0.23 + b * 2.1);
    return clamp(v * (0.78 + 0.22 * Math.sin(k * 0.013)) * (1 - b / 44), 0.05, 1);
  }
  function rollStep() {
    rollK++; stepHue(0.08);
    roll.bands.copyWithin(0, B); roll.hue.copyWithin(0, 1);
    const o = (S - 1) * B, live = A.playing;
    for (let b = 0; b < B; b++) roll.bands[o + b] = roll.bands[o + b] * 0.5 + (live ? clamp(0.06 + A.bands[b] * 0.98, 0, 1) : synBand(b, rollK)) * 127.5;
    roll.hue[S - 1] = Math.round((hueNow / 360) * 255);
  }
  for (let i = 0; i < S; i++) rollStep();
  AG.updateSculpt(roll);

  function restore() {   // show whatever the sculpture should currently be
    if (sess && sess.status !== 'done') { mode = 'session'; AG.updateSculpt(sess.data); }
    else if (viewRec) { mode = 'view'; AG.updateSculpt(decode(viewRec)); V.grow = viewRec.grown || 1; }
    else { mode = 'roll'; V.grow = 1; AG.updateSculpt(roll); }
  }

  /* ---------- session ---------- */
  let sess = null, pip = null, idleAbort = null, breakEndsAt = 0;
  const cfg = { minutes: 25, subject: db.subjects[0], mode: 'here', idleMin: 5 };
  let room = null, breathT0 = 0;

  /* a running session is written to its own key every few seconds, so a reload or crash doesn't lose it */
  const LIVE = 'afterglow.live'; let liveN = 0, wake = null, lastFocus = null;
  function saveLive() {
    if (!sess || sess.status === 'done') return;
    try { localStorage.setItem(LIVE, JSON.stringify({ planned: sess.planned, elapsed: sess.elapsed, away: sess.away, dist: sess.dist, subject: sess.subject, mode: sess.mode, idleMs: sess.idleMs, team: sess.team,
      teamEnd: sess.teamEnd, tracks: sess.tracks, startedAt: sess.startedAt, lastSi: sess.lastSi, lastCheck: sess.lastCheck, savedAt: Date.now(), data: encode(sess.data) })); } catch (e) {}
  }
  function clearLive() { try { localStorage.removeItem(LIVE); } catch (e) {} }
  function resumeLive() {
    let L = null; try { L = JSON.parse(localStorage.getItem(LIVE)); } catch (e) {}
    if (!L || !L.planned || !L.data) return false;
    const t = Date.now();
    if (t - L.savedAt > 12 * 3600e3 || (L.teamEnd && t > L.teamEnd + 60000)) { clearLive(); return false; }
    sess = { status: 'paused', planned: L.planned, elapsed: L.elapsed, away: L.away || 0, dist: L.dist || [], subject: L.subject, mode: L.mode || 'here', idleMs: L.idleMs || 300000, team: L.team || null, teamEnd: L.teamEnd || 0,
      data: decode({ id: 'live' + t, data: L.data }), lastSi: L.lastSi, cnt: 0, tracks: L.tracks || {}, last: t, startedAt: L.startedAt, hiddenAt: 0, lastInput: t, ep: null, lastCheck: L.lastCheck || 0, check: null, sysIdle: false, sysIdleOn: false };
    if (sess.teamEnd) { sess.elapsed = clamp(sess.planned - (sess.teamEnd - t) / 1000, sess.elapsed, sess.planned); sess.status = 'running'; }   // a team clock doesn't wait
    viewRec = null; mode = 'session'; AG.updateSculpt(sess.data); showState('running'); renderHud();
    setTimeout(() => toast(sess && sess.teamEnd ? 'Back in your team session. Tap a track to bring the sound back.' : 'Picked up your session where it stopped. Tap Resume, then a track.', 7000), 600);
    return true;
  }
  async function wakeOn() { if (!$('#wakeChk').checked || !('wakeLock' in navigator) || document.hidden) return; try { wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
  function wakeOff() { try { if (wake) wake.release(); } catch (e) {} wake = null; }
  function score() {
    if (!sess) return 100;
    const frac = 1 - sess.away / Math.max(sess.elapsed, 1);
    return clamp(Math.round(100 * frac - 5 * sess.dist.length), 0, 100);
  }
  function startSession(rm) {
    const t = Date.now();
    const planned = rm ? Math.max(30, Math.round((rm.start + rm.minutes * 60000 - t) / 1000)) : cfg.minutes * 60;
    sess = { status: 'running', planned, elapsed: 0, away: 0, dist: [], subject: rm ? rm.subject : cfg.subject, mode: cfg.mode, idleMs: cfg.idleMin * 60000, team: rm ? { id: rm.id, room: rm.name } : null,
      data: AG.emptyData(), lastSi: -1, cnt: 0, tracks: {}, last: t, startedAt: t, hiddenAt: document.hidden ? t : 0, lastInput: t, ep: null, lastCheck: 0, check: null, sysIdle: false, sysIdleOn: false };
    sess.teamEnd = rm ? rm.start + rm.minutes * 60000 : 0;
    viewRec = null; mode = 'session'; V.grow = 0; AG.updateSculpt(sess.data); saveLive(); wakeOn();
    if (cfg.mode === 'elsewhere') startIdleDetector();
    showState('running'); renderHud();
    if (!A.playing) toast('No sound is playing, so this one will grow thin. Tap a track any time.');
    else A.chime(true);
  }
  async function startIdleDetector() {
    if (!('IdleDetector' in window)) return;
    try {
      if ((await window.IdleDetector.requestPermission()) !== 'granted') return;
      const d = new window.IdleDetector(); idleAbort = new AbortController();
      d.addEventListener('change', () => { if (sess) sess.sysIdle = d.userState === 'idle' || d.screenState === 'locked'; });
      await d.start({ threshold: Math.max(60000, cfg.idleMin * 60000), signal: idleAbort.signal });
      if (sess) { sess.sysIdleOn = true; renderHud(); }
    } catch (e) {}
  }
  function distraction() {
    const si = Math.min(S - 1, Math.floor((sess.elapsed / sess.planned) * S));
    sess.dist.push(sess.elapsed / sess.planned);
    sess.data.flag[si] = 255; if (si + 1 < S) sess.data.flag[si + 1] = 255;
    V.shock = 1;
  }
  function tick() {
    if (room && (!sess || sess.status === 'done')) return lobbyTick();
    if (!sess || sess.status === 'done') return;
    const now = Date.now(), dt = Math.max(0, (now - sess.last) / 1000); sess.last = now;
    if (sess.status === 'break') { if (now >= breakEndsAt) endBreak(); else $('#breakClock').textContent = fmt((breakEndsAt - now) / 1000); return; }
    if (sess.status !== 'running') { renderHud(); return; }
    sess.elapsed = Math.min(sess.planned, sess.elapsed + dt);
    let away = false;
    if (sess.mode === 'here') {
      if (sess.hiddenAt && now - sess.hiddenAt > GRACE) away = true;
      else if (now - sess.lastInput > sess.idleMs) away = true;
    } else if (sess.sysIdle) away = true;
    if (away) { if (!sess.ep) { sess.ep = true; distraction(); } sess.away += dt; } else sess.ep = null;

    // sound -> slices
    const bands = A.sample(); stepHue(0.3);
    const si = Math.min(S - 1, Math.floor((sess.elapsed / sess.planned) * S)), d = sess.data, hb = Math.round((hueNow / 360) * 255);
    for (let s = Math.max(0, sess.lastSi + 1); s <= si; s++) {
      sess.cnt = 0; d.hue[s] = hb; if (sess.ep) d.flag[s] = 255;
      for (let b = 0; b < B; b++) d.bands[s * B + b] = (A.playing ? clamp(0.06 + bands[b], 0, 1) : 0.07) * 255;
    }
    sess.cnt++;
    for (let b = 0; b < B; b++) { const i = si * B + b, v = (A.playing ? clamp(0.06 + bands[b], 0, 1) : 0.07) * 255; d.bands[i] += (v - d.bands[i]) / sess.cnt; }
    sess.lastSi = si;
    if (A.current) sess.tracks[A.current.name] = (sess.tracks[A.current.name] || 0) + dt;

    // check-ins
    if (!sess.check && sess.elapsed - sess.lastCheck >= CHECK_EVERY && sess.planned - sess.elapsed > 60) openCheckin();
    if (sess.check && now - sess.check > 120000) closeCheckin('missed');

    if (sess.elapsed >= sess.planned) return finish();
    if (++liveN % 10 === 0) saveLive();
    if (!document.hidden && mode === 'session') AG.updateSculpt(d);
    renderHud();
  }
  setInterval(tick, 500);

  function pauseToggle() {
    if (!sess) return;
    if (sess.status === 'running') sess.status = 'paused';
    else if (sess.status === 'paused') { wakeOn(); sess.status = 'running'; sess.last = sess.lastInput = Date.now(); sess.hiddenAt = document.hidden ? Date.now() : 0; }
    renderHud();
  }
  function startBreak() {
    if (!sess || sess.status === 'done') return;
    sess.status = 'break'; breakEndsAt = Date.now() + db.breakMin * 60000; V.dimTarget = 0.3; breathT0 = performance.now();
    $('#break').hidden = false; $('#breakClock').textContent = fmt(db.breakMin * 60); $('#breakEnd').focus();
  }
  function endBreak() {
    $('#break').hidden = true; V.dimTarget = 1;
    if (sess && sess.status === 'break') { sess.status = 'running'; sess.last = sess.lastInput = Date.now(); sess.hiddenAt = 0; A.chime(true); }
    renderHud();
  }
  function extend(min) {   // add time mid-session: squeeze what has grown so far into the lower part of a longer form
    if (!sess || sess.status === 'done' || sess.team) return;
    const np = sess.planned + min * 60, k = sess.planned / np, d = sess.data, o = AG.emptyData(), top = Math.floor((sess.lastSi + 1) * k);
    for (let s = 0; s < top; s++) {
      const src = Math.min(sess.lastSi, Math.floor(s / k));
      o.hue[s] = d.hue[src]; o.flag[s] = d.flag[src];
      for (let b = 0; b < B; b++) o.bands[s * B + b] = d.bands[src * B + b];
    }
    sess.data = o; sess.lastSi = top - 1; sess.planned = np; sess.dist = sess.dist.map((t) => t * k);
    AG.updateSculpt(o); renderHud(); toast('Added ' + min + ' minutes.');
  }
  function finish(early) {
    if (!sess) return;
    closeCheckin(); $('#break').hidden = true; V.dimTarget = 1; clearLive(); wakeOff();
    if (idleAbort) { try { idleAbort.abort(); } catch (e) {} idleAbort = null; }
    if (pip && !pip.closed) { try { pip.close(); } catch (e) {} } pip = null;
    const frac = sess.elapsed / sess.planned;
    if (early && sess.elapsed < 20) { sess = null; restore(); showState('setup'); renderHud(); toast('Under 20 seconds, so nothing was saved.'); return; }
    const data = sess.data;   // an unfinished session keeps its unfinished form
    const rec = { id: 's' + sess.startedAt, ts: sess.startedAt, planned: sess.planned, focused: Math.round(sess.elapsed - sess.away), away: Math.round(sess.away), score: score(),
      subject: sess.subject, mode: sess.mode, dist: sess.dist.map((t) => +t.toFixed(3)), tracks: sess.tracks, data: encode(data), grown: frac >= 0.995 ? 1 : +frac.toFixed(3) };
    if (sess.team) { rec.team = sess.team; addToBoard(sess.team, { name: db.me || 'Me', score: rec.score, min: Math.max(1, Math.round(rec.focused / 60)), dist: rec.dist.length, me: true }); room = null; db.room = null; }
    Object.keys(rec.tracks).forEach((k) => (rec.tracks[k] = Math.round(rec.tracks[k])));
    cache.set(rec.id, data);
    db.sessions.unshift(rec); if (db.sessions.length > 80) db.sessions.length = 80; save();
    sess.status = 'done'; viewRec = rec; restore();
    $('#doneScore').textContent = rec.score; $('#doneMin').textContent = Math.max(1, Math.round(rec.focused / 60)) + 'm'; $('#doneDist').textContent = rec.dist.length;
    $('#doneTitle').textContent = rec.grown < 1 ? 'Stopped at ' + Math.round(rec.grown * 100) + '%.' : rec.score >= 90 ? 'Clean session.' : rec.score >= 70 ? 'One more for the shelf.' : 'It still counts.';
    $('#doneNote').textContent = rec.grown < 1 ? 'Saved to your gallery as it stands, unfinished.' : 'Saved to your gallery in this browser.';
    renderBoard(rec);
    showState('done'); renderHud(); renderGallery(); renderStats();
    A.chime(true); notify('Session complete', rec.subject + ' · focus ' + rec.score);
  }

  /* check-ins */
  function openCheckin() {
    sess.check = Date.now(); sess.lastCheck = sess.elapsed;
    $('#checkTitle').textContent = Math.round(sess.elapsed / 60) + ' minutes in.';
    $('#checkin').hidden = false; A.chime(false);
    notify('Still with it?', Math.round(sess.elapsed / 60) + ' minutes in. Open Afterglow to check in.');
  }
  function closeCheckin(result) {
    $('#checkin').hidden = true; if (!sess) return; sess.check = null;
    if (result === 'drifted' || (result === 'missed' && sess.mode === 'elsewhere')) { distraction(); sess.away += result === 'missed' ? 120 : 60; }
    if (result) sess.lastInput = Date.now();
  }
  function notify(title, body) {
    try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Afterglow · ' + title, { body }); } catch (e) {}
  }

  /* activity + visibility */
  ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((ev) => addEventListener(ev, () => { if (sess) sess.lastInput = Date.now(); }, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => {
    if (!sess || sess.status === 'done') return;
    tick(); if (document.hidden) saveLive(); else wakeOn();
    sess.hiddenAt = document.hidden ? Date.now() : 0;
    if (!document.hidden) { sess.lastInput = Date.now(); AG.updateSculpt(sess.data); }
  });

  /* ---------- HUD ---------- */
  const baseTitle = document.title;
  function renderHud() {
    const active = sess && sess.status !== 'done';
    const clock = $('#clock'), status = $('#status'), label = $('#hudLabel');
    if (!active) {
      clock.textContent = viewRec ? Math.max(1, Math.round(viewRec.focused / 60)) + ' min' : cfg.minutes + ':00';
      label.textContent = viewRec ? viewRec.subject + ' · focus ' + viewRec.score : 'Live preview · follows whatever is playing';
      status.textContent = viewRec ? 'Saved' : 'Drag to turn it'; status.classList.remove('warn');
      document.title = baseTitle; $('#dock').hidden = true; return;
    }
    const left = sess.planned - sess.elapsed, sc = score();
    let st = 'Growing', warn = false;
    if (sess.status === 'paused') st = 'Paused';
    else if (sess.status === 'break') st = 'On a break';
    else if (sess.ep) { st = 'Drifted. Move or come back to pick it up.'; warn = true; }
    clock.textContent = fmt(left); label.textContent = sess.subject + ' · ' + Math.round(sess.planned / 60) + ' min ' + (sess.team ? 'team session · ' + sess.team.room : 'session');
    status.textContent = st; status.classList.toggle('warn', warn);
    $('#scoreNum').textContent = sc; $('#distNum').textContent = sess.dist.length;
    $('#runSubj').textContent = sess.subject;
    $('#growBar').style.transform = 'scaleX(' + (sess.elapsed / sess.planned).toFixed(4) + ')';
    $('#runMeta').textContent = Math.round((sess.elapsed / sess.planned) * 100) + '% grown · ' + (A.current ? A.current.name : 'no sound');
    $('#pauseBtn').textContent = sess.status === 'paused' ? 'Resume' : 'Pause'; $('#extendBtn').hidden = !!sess.team;
    $('#runNote').textContent = sess.mode === 'here'
      ? 'Counting a distraction when you leave this tab for more than 10 seconds, or go ' + cfg.idleMin + ' minutes without moving in it. It can\'t see what you do in other tabs or apps.'
      : (sess.sysIdleOn ? 'Tab switches are ignored. Your browser reports when the whole computer goes idle or locks, and that counts.' : 'Tab switches are ignored. This browser can\'t report system idle, so only check-ins every 25 minutes count. Answer honestly.');
    document.title = (sess.status === 'paused' ? 'Paused · ' : '') + fmt(left) + ' · Afterglow';
    $('#dockClock').textContent = fmt(left); $('#dockScore').textContent = 'Focus ' + sc;
    $('#dock').hidden = playInView && !docked;
    if (pip && !pip.closed) pipRender(left, sc, st);
  }
  function showState(name) { ['setup', 'lobby', 'running', 'done'].forEach((n) => ($('#' + n).hidden = n !== name)); AG.measure(); }

  /* ---------- floating mini window: Document PiP -> popup -> docked bar ---------- */
  let docked = false, playInView = false, pipN = 0;
  async function openFloat() {
    if (pip && !pip.closed) { try { pip.focus(); } catch (e) {} return; }
    let w = null;
    if ('documentPictureInPicture' in window) { try { w = await window.documentPictureInPicture.requestWindow({ width: 250, height: 310 }); } catch (e) {} }
    if (!w) { try { w = window.open('', 'afterglow-mini', 'width=250,height=330,popup=yes'); } catch (e) {} }
    if (!w || !w.document) { docked = true; renderHud(); toast('A floating window isn\'t available here, so the timer is docked in the corner and shown in the tab title.'); return; }
    const d = w.document; d.title = 'Afterglow';
    d.body.innerHTML = '<style>html,body{margin:0;height:100%;background:#04050b;color:#eef1fb;font-family:system-ui,sans-serif;overflow:hidden}body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}canvas{width:120px;height:150px}b{font-size:44px;font-weight:200;letter-spacing:-.04em;font-variant-numeric:tabular-nums;line-height:1}p{margin:0;font:11px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#8e96b8}#s{color:#93ffdc}button{margin-top:6px;font:inherit;font-size:13px;color:#eef1fb;background:rgba(255,255,255,.06);border:1px solid rgba(190,210,255,.2);border-radius:99px;padding:7px 16px;cursor:pointer}</style><canvas id="c" width="240" height="300"></canvas><b id="t"></b><p id="s"></p><p id="f"></p><button id="p">Pause</button>';
    d.getElementById('p').addEventListener('click', pauseToggle);
    ['pointermove', 'pointerdown', 'keydown'].forEach((ev) => w.addEventListener(ev, () => { if (sess) sess.lastInput = Date.now(); }));
    w.addEventListener('pagehide', () => { pip = null; });
    pip = w; renderHud();
  }
  function pipRender(left, sc, st) {
    try {
      const d = pip.document; d.getElementById('t').textContent = fmt(left); d.getElementById('s').textContent = st.split('.')[0];
      d.getElementById('f').textContent = 'Focus ' + sc; d.getElementById('p').textContent = sess.status === 'paused' ? 'Resume' : 'Pause';
      if (pipN++ % 4 === 0) { const c = d.getElementById('c'), x = c.getContext('2d'); x.clearRect(0, 0, 240, 300); AG.draw2D(x, 240, 300, sess.data, { n: 2600, grow: sess.elapsed / sess.planned, rot: pipN * 0.05, px: 1.6 }); }
    } catch (e) {}
  }

  /* ---------- team rooms ----------
     No server. A room code carries the start time, length, room and subject, so everyone who opens it
     runs the same timer against the same clock. Results are swapped afterwards as short codes. */
  const inFrame = (() => { try { return window.top !== window; } catch (e) { return true; } })();
  const words = (v, max) => String(v || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, max || 4).map((w) => w.slice(0, 14));
  function roomCode(r) {   // ag-<start>-<minutes>-<subject word count>-<subject words>-<room words>; hyphens stand in for spaces
    const sj = words(r.subject, 3), nm = words(r.name, 4); if (!sj.length) sj.push('Study'); if (!nm.length) nm.push('Room');
    return 'ag-' + Math.round(r.start / 1000).toString(36) + '-' + r.minutes + '-' + sj.length + '-' + sj.join('-') + '-' + nm.join('-');
  }
  function parseRoom(text) {
    const m = /ag-([0-9a-z]{5,8})-(\d{1,3})-([1-3])-([A-Za-z0-9-]+)/.exec(String(text || ''));
    if (!m) return null;
    const w = m[4].split('-').filter(Boolean), n = +m[3]; if (w.length <= n) return null;
    return { id: m[1], start: parseInt(m[1], 36) * 1000, minutes: clamp(+m[2], 1, 240), subject: w.slice(0, n).join(' '), name: w.slice(n).join(' '), code: m[0] };
  }
  function enterRoom(r, quiet) {
    const now = Date.now(), end = r.start + r.minutes * 60000;
    if (end - now < 60000) { if (!quiet) toast('That session has already ended.'); db.room = null; save(); return false; }
    if (sess && sess.status !== 'done') { if (!quiet) toast('Finish or end your current session first.'); return false; }
    room = r; db.room = r.code; save();
    $('#lobbyName').textContent = r.name; $('#lobbyLen').textContent = r.minutes + 'm'; $('#lobbyCode').textContent = r.code;
    $('#lobbyCopyLink').hidden = inFrame;
    if (now >= r.start) { startSession(r); toast('Joined ' + r.name + ' late. You finish with everyone else.'); return true; }
    sess = null; viewRec = null; restore(); showState('lobby'); lobbyTick(); if (!quiet) $('#playground').scrollIntoView(); return true;
  }
  function lobbyTick() {
    if (!room) return;
    const left = (room.start - Date.now()) / 1000;
    if (left <= 0) { const r = room; startSession(r); return; }
    $('#lobbyClock').textContent = fmt(left);
    document.title = 'Starts in ' + fmt(left) + ' · Afterglow';
  }
  function leaveRoom() { room = null; db.room = null; save(); showState('setup'); renderHud(); }
  async function copyText(t, okMsg) {
    try { await navigator.clipboard.writeText(t); toast(okMsg); }
    catch (e) { toast('Copying is blocked here. Select the code and copy it by hand.'); }
  }
  function resultCode(team, e) { return 'agr-' + team.id + '-' + e.score + '-' + e.min + '-' + e.dist + '-' + (words(e.name, 3).join('-') || 'Me'); }
  function addToBoard(team, e) {
    const b = (db.boards[team.id] = db.boards[team.id] || { room: team.room, entries: [] });
    b.entries = b.entries.filter((x) => slug(x.name) !== slug(e.name)); b.entries.push(e);
    const ks = Object.keys(db.boards); if (ks.length > 20) delete db.boards[ks[0]];
    save();
  }
  function renderBoard(rec) {
    const b = rec && rec.team && db.boards[rec.team.id]; $('#board').hidden = !b; if (!b) return;
    const rk = b.entries.slice().sort((x, y) => y.score - x.score), avg = Math.round(rk.reduce((a, x) => a + x.score, 0) / rk.length);
    $('#boardTitle').textContent = 'Team board · ' + b.room + ' · average ' + avg;
    $('#boardList').innerHTML = rk.map((x, i) => '<li><span>' + (i + 1) + '</span><span style="font:inherit;color:inherit;letter-spacing:0">' + esc(x.name) + (x.me ? ' (you)' : '') + '</span><span>' + x.min + ' min · ' + x.dist + (x.dist === 1 ? ' slip' : ' slips') + '</span><b>' + x.score + '</b></li>').join('');
    const mine = b.entries.find((x) => x.me); $('#myResult').textContent = mine ? resultCode(rec.team, mine) : '';
  }
  function addMate() {
    if (!viewRec || !viewRec.team) return;
    const m = /agr-([0-9a-z]{5,8})-(\d{1,3})-(\d{1,3})-(\d{1,3})-([A-Za-z0-9-]+)/.exec($('#mateCode').value);
    if (!m) return toast('That doesn\'t look like a result code. It starts with agr-.');
    if (m[1] !== viewRec.team.id) return toast('That code is from a different session.');
    addToBoard(viewRec.team, { name: m[5].split('-').filter(Boolean).join(' '), score: clamp(+m[2], 0, 100), min: +m[3], dist: +m[4] });
    $('#mateCode').value = ''; renderBoard(viewRec);
  }

  /* ---------- break: a bloom that opens as you breathe in and folds as you breathe out ---------- */
  const IN = 4, OUT = 6;
  function drawBreath(now) {
    const cv = $('#breathCv'), x = cv.getContext('2d'), W = cv.width, c = W / 2, t = ((now - breathT0) / 1000) % (IN + OUT);
    const inhale = t < IN, ph = inhale ? t / IN : (t - IN) / OUT;
    const e = ph * ph * (3 - 2 * ph), k = reduced ? 0.8 : inhale ? e : 1 - e;
    $('#breathTxt').textContent = inhale ? 'Breathe in' : 'Breathe out';
    $('#breathBar').style.transform = 'scaleX(' + (inhale ? ph : 1 - ph).toFixed(3) + ')';
    x.clearRect(0, 0, W, W); x.globalCompositeOperation = 'lighter';
    const R = W * 0.33, rot = k * 1.4 + (reduced ? 0 : now * 0.00004);
    const rings = [[12, 0.78, 0.42, '61,102,255'], [9, 0.5, 0.42, '116,228,255'], [6, 0.25, 0.42, '147,255,220']];
    rings.forEach(([n, dist, size, rgb], ri) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.2832 + rot * (ri % 2 ? -1 : 1) + ri * 0.4, d = R * dist * k * 1.25, r = R * size * (0.42 + 0.58 * k);
        const px = c + Math.cos(a) * d, py = c + Math.sin(a) * d, g = x.createRadialGradient(px, py, 0, px, py, r);
        g.addColorStop(0, 'rgba(' + rgb + ',' + (0.3 + 0.2 * (1 - k)).toFixed(3) + ')'); g.addColorStop(0.8, 'rgba(' + rgb + ',0.16)'); g.addColorStop(1, 'rgba(' + rgb + ',0)');
        x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, 6.2832); x.fill();
      }
    });
    x.globalCompositeOperation = 'source-over';
  }

  /* ---------- viewer + 10 s replay ---------- */
  let replayT0 = 0, viewerRec = null;
  function openViewer(rec, replay) {
    if ($('#viewer').hidden) lastFocus = document.activeElement;
    viewerRec = rec; const mob = innerWidth < 860;
    V.override = { shape: 'sculpt', fx: mob ? 0 : -0.3, fy: mob ? 0.3 : 0, s: mob ? 0.62 : 1.15, tilt: 0, repel: 0.5, spin: 1 };
    mode = 'view'; AG.updateSculpt(decode(rec)); V.grow = rec.grown || 1; V.dim = 0;
    document.body.classList.add('stage-open'); $('#viewer').hidden = false;
    const dt = new Date(rec.ts);
    $('#vDate').textContent = (rec.example ? 'Example · ' : '') + dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    $('#vSubj').textContent = rec.subject + (rec.grown < 1 ? ' · stopped at ' + Math.round(rec.grown * 100) + '%' : '');
    const bd = rec.team && db.boards[rec.team.id]; $('#vTeam').hidden = !bd;
    if (bd) { const rk = bd.entries.slice().sort((a, b) => b.score - a.score); $('#vTeam').textContent = 'Team session in ' + rec.team.room + '. You placed ' + (rk.findIndex((e) => e.me) + 1) + ' of ' + rk.length + ' on the board.'; } $('#vScore').textContent = rec.score; $('#vMin').textContent = Math.max(1, Math.round(rec.focused / 60)) + 'm'; $('#vDist').textContent = rec.dist.length;
    $('#vTracks').textContent = Object.keys(rec.tracks || {}).join(' → ') || 'No sound';
    $('#vDelete').hidden = !!rec.example; $('#vDelete').textContent = 'Delete';
    $('#vClose').focus();
    if (replay) startReplay();
  }
  function startReplay() { V.grow = 0; replayT0 = performance.now(); }
  function closeViewer() {
    $('#viewer').hidden = true; document.body.classList.remove('stage-open'); V.override = null; replayT0 = 0; V.spinBoost = 0; V.dim = 0; viewerRec = null; restore(); backFocus();
  }
  function backFocus() { try { if (lastFocus && document.contains(lastFocus)) lastFocus.focus(); } catch (e) {} }

  /* ---------- share card ---------- */
  let cardBlob = null, cardUrl = null;
  const logoImg = new Image(); logoImg.src = 'data:image/png;base64,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';   // inlined so the share card can be saved from any origin
  function makeCard(rec) {
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1350; const x = c.getContext('2d');
    x.fillStyle = '#04050b'; x.fillRect(0, 0, 1080, 1350);
    let g = x.createRadialGradient(0, 0, 0, 0, 0, 900); g.addColorStop(0, 'rgba(80,220,255,.22)'); g.addColorStop(1, 'rgba(80,220,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 1080, 1350);
    g = x.createRadialGradient(1080, 1350, 0, 1080, 1350, 1000); g.addColorStop(0, 'rgba(50,80,255,.3)'); g.addColorStop(1, 'rgba(50,80,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 1080, 1350);
    AG.draw2D(x, 1080, 1350, decode(rec), { n: 30000, px: 2.4, scale: 0.3, cy: 0.42, rot: 0.7, grow: rec.grown || 1 });
    const F = '"Bricolage Grotesque", "Helvetica Neue", Arial, sans-serif', Mo = '"DM Mono", ui-monospace, monospace';
    x.fillStyle = '#eef1fb'; x.textBaseline = 'alphabetic';
    if (logoImg.complete && logoImg.naturalWidth) x.drawImage(logoImg, 52, 42, 84, 84);
    x.font = '400 26px ' + F; let lx = 150; for (const ch of 'afterglow') { x.fillText(ch, lx, 94); lx += x.measureText(ch).width + 9; }
    x.lineWidth = 1;
    x.fillStyle = '#8e96b8'; x.font = '400 22px ' + Mo; x.textAlign = 'right';
    x.fillText(new Date(rec.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase(), 1012, 98);
    x.textAlign = 'left'; x.fillStyle = '#eef1fb'; x.font = '200 120px ' + F;
    let subj = rec.subject; while (x.measureText(subj).width > 900 && subj.length > 3) subj = subj.slice(0, -2) + '…';
    x.fillText(subj, 64, 1120);
    x.strokeStyle = 'rgba(190,210,255,.2)'; x.beginPath(); x.moveTo(68, 1160); x.lineTo(1012, 1160); x.stroke();
    const cols = [['FOCUS SCORE', String(rec.score)], ['FOCUSED', Math.max(1, Math.round(rec.focused / 60)) + ' min'], ['DISTRACTIONS', String(rec.dist.length)]];
    cols.forEach((col, i) => { const X = 68 + i * 320; x.fillStyle = '#8e96b8'; x.font = '400 20px ' + Mo; x.fillText(col[0], X, 1206); x.fillStyle = '#eef1fb'; x.font = '250 64px ' + F; x.fillText(col[1], X, 1280); });
    x.fillStyle = '#8e96b8'; x.font = '400 20px ' + Mo; x.textAlign = 'right'; x.fillText('YOUR FOCUS, MADE VISIBLE.', 1012, 1322);
    return c;
  }
  function openCard(rec) {
    toast('Making your card…', 1600);
    const c = makeCard(rec);
    c.toBlob((b) => {
      cardBlob = b; if (cardUrl) URL.revokeObjectURL(cardUrl); cardUrl = URL.createObjectURL(b);
      lastFocus = document.activeElement; $('#cardImg').src = cardUrl; $('#cardModal').hidden = false; $('#cardSave').focus();
      let can = false; try { can = !!(navigator.canShare && navigator.canShare({ files: [new File([b], 'afterglow.png', { type: 'image/png' })] })); } catch (e) {}
      $('#cardShare').hidden = !can;
    }, 'image/png');
  }
  async function saveFile(blob, name) {
    try {
      const d = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
      if (d) { await d.save({ filename: name, data: blob }); return true; }
    } catch (e) { if (e && e.code === 'declined') return false; }
    try { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); return true; } catch (e) { return false; }
  }
  async function saveCard() { if (cardBlob && !(await saveFile(cardBlob, 'afterglow-' + dayKey(Date.now()) + '.png'))) toast('Press and hold the image to save it.'); }
  function backup() { saveFile(new Blob([JSON.stringify({ app: 'afterglow', v: 1, saved: new Date().toISOString(), db })], { type: 'application/json' }), 'afterglow-backup-' + dayKey(Date.now()) + '.json'); }
  function restoreFrom(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const j = JSON.parse(r.result); if (j.app !== 'afterglow' || !j.db || !Array.isArray(j.db.sessions)) throw 0;
        const have = new Set(db.sessions.map((x) => x.id)), add = j.db.sessions.filter((x) => x && x.id && x.data && !have.has(x.id));
        db.sessions = db.sessions.concat(add).sort((a, b) => b.ts - a.ts).slice(0, 80);
        (j.db.subjects || []).forEach((x) => { if (typeof x === 'string' && !db.subjects.includes(x) && db.subjects.length < 12) db.subjects.push(x.slice(0, 18)); });
        if (!db.exam && j.db.exam) db.exam = j.db.exam; Object.assign(db.boards, j.db.boards || {}, db.boards); if (!db.me && j.db.me) db.me = j.db.me;
        save(); renderSubjects(); renderGallery(); renderStats(); toast(add.length ? 'Restored ' + add.length + ' session' + (add.length > 1 ? 's' : '') + '.' : 'Nothing new in that backup.');
      } catch (e) { toast('That file isn\'t an Afterglow backup.'); }
    };
    r.readAsText(file);
  }

  /* ---------- gallery ---------- */
  function renderGallery() {
    const grid = $('#galGrid'); grid.textContent = '';
    $('#heroStart').textContent = db.sessions.length ? 'Start a session' : 'Try a 1-minute session';
    const list = db.sessions.concat(db.sessions.length < 3 ? EXAMPLES : []);
    list.forEach((rec, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'card rv in';
      const d = new Date(rec.ts);
      b.innerHTML = (rec.example ? '<span class="tag">Example</span>' : rec.grown < 1 ? '<span class="tag">Unfinished · ' + Math.round(rec.grown * 100) + '%</span>' : rec.team ? '<span class="tag">Team</span>' : '') + '<canvas width="320" height="400"></canvas><span class="meta"><span><b>' + esc(rec.subject) + '</b><span class="mono">' +
        d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' · ' + Math.max(1, Math.round(rec.focused / 60)) + ' min</span></span><span class="sc">' + rec.score + '</span></span>';
      b.setAttribute('aria-label', rec.subject + ', focus score ' + rec.score + (rec.example ? ', example' : '') + '. Open.');
      b.addEventListener('click', () => openViewer(rec));
      grid.appendChild(b);
      setTimeout(() => { const c = b.querySelector('canvas'); AG.draw2D(c.getContext('2d'), 320, 400, decode(rec), { n: 3400, px: 1.5, scale: 0.37, rot: 0.5 + i, grow: rec.grown || 1 }); }, 30 + i * 25);
    });
    AG.measure();
  }

  /* ---------- stats + garden ---------- */
  let gardenPts = [];
  function renderStats() {
    const recs = records(), sample = !db.sessions.length;
    $('#sampleNote').hidden = !sample;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = []; for (let i = 6; i >= 0; i--) days.push({ t: today.getTime() - i * DAY, min: 0, recs: [] });
    recs.forEach((r) => { const k = dayKey(r.ts); const d = days.find((x) => dayKey(x.t) === k); if (d) { d.min += r.focused / 60; d.recs.push(r); } });
    const mx = Math.max(30, ...days.map((d) => d.min));
    $('#dayBars').innerHTML = days.map((d, i) => '<div class="' + (i === 6 ? 'today' : '') + '"><span>' + (d.min ? Math.round(d.min) : '') + '</span><i style="height:' + ((d.min / mx) * 78).toFixed(1) + '%"></i><span>' +
      new Date(d.t).toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3) + '</span></div>').join('');
    const week = days.flatMap((d) => d.recs), nd = week.reduce((a, r) => a + r.dist.length, 0), hrs = week.reduce((a, r) => a + r.focused, 0) / 3600;
    $('#stDist').textContent = nd; $('#stDistSub').textContent = week.length ? (hrs > 0.05 ? (nd / hrs).toFixed(1) + ' per focused hour · ' : '') + week.length + ' session' + (week.length > 1 ? 's' : '') + ' this week' : 'No sessions in the last 7 days';
    // best track: the dominant track of each session, averaged by focus score
    const tr = {};
    recs.forEach((r) => { const top = Object.entries(r.tracks || {}).sort((a, b) => b[1] - a[1])[0]; if (top) { (tr[top[0]] = tr[top[0]] || []).push(r.score); } });
    const best = Object.entries(tr).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length, v.length]).sort((a, b) => b[1] - a[1])[0];
    $('#stTrack').textContent = best ? best[0] : 'No sound yet'; $('#stTrackSub').textContent = best ? 'Average focus ' + Math.round(best[1]) + ' over ' + best[2] + ' session' + (best[2] > 1 ? 's' : '') : 'Play a track during a session';
    const sj = {}; recs.forEach((r) => (sj[r.subject] = sj[r.subject] || []).push(r.score));
    $('#subjBars').innerHTML = Object.entries(sj).map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length)]).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => '<span>' + esc(k) + '</span><span class="bar"><i style="width:' + v + '%"></i></span><em>' + v + '</em>').join('') || '<span class="note">No sessions yet.</span>';
    // garden
    const items = []; gardenPts = [];
    days.forEach((d, i) => {
      const x = (i - 3) * 0.88, z = -0.16 * Math.abs(i - 3);
      const lab = new Date(d.t).toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3);
      gardenPts.push({ x, z, lab, min: Math.round(d.min) });
      if (d.recs.length) { const r = d.recs.slice().sort((a, b) => b.focused - a.focused)[0]; items.push({ data: decode(r), x, z, scale: 0.27 + 0.17 * Math.min(1, d.min / 90), grow: r.grown || 1 }); }
    });
    AG.setGarden(items);
    $('#glabels').innerHTML = gardenPts.map((p) => '<span><b>' + p.lab + '</b>' + (p.min ? p.min + ' min' : '·') + '</span>').join('');
    renderExam();
  }
  function renderExam() {
    const e = db.exam; let line = '';
    if (e && e.date) {
      const t = new Date(e.date + 'T00:00:00').getTime(), today = new Date(); today.setHours(0, 0, 0, 0);
      const n = Math.round((t - today.getTime()) / DAY);
      $('#examBig').textContent = n > 1 ? n + ' days' : n === 1 ? 'Tomorrow' : n === 0 ? 'Today' : 'Done';
      $('#examSub').textContent = (e.name || 'Exam') + ' · ' + new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
      if (n >= 0) line = (n > 1 ? n + ' days to ' : n === 1 ? 'Tomorrow: ' : 'Today: ') + (e.name || 'your exam') + '.';
      $('#examName').value = e.name || ''; $('#examDate').value = e.date;
    } else { $('#examBig').textContent = '–'; $('#examSub').textContent = 'Set a date and it shows up here and before each session.'; }
    $('#examLine').textContent = line;
  }

  /* ---------- setup UI ---------- */
  function renderSubjects() {
    const el = $('#subjChips'); el.textContent = '';
    db.subjects.forEach((s) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (s === cfg.subject ? ' on' : ''); b.textContent = s;
      b.addEventListener('click', () => { cfg.subject = s; renderSubjects(); }); el.appendChild(b); });
    const l = document.createElement('label'); l.className = 'chip in add'; l.innerHTML = '<input type="text" maxlength="18" placeholder="+ Add" aria-label="Add a subject" id="subjAdd">';
    l.firstChild.addEventListener('keydown', (e) => { if (e.key !== 'Enter') return; const v = e.target.value.trim(); if (!v) return;
      if (!db.subjects.includes(v)) { db.subjects.push(v); if (db.subjects.length > 12) db.subjects.shift(); save(); } cfg.subject = v; renderSubjects(); });
    el.appendChild(l);
  }
  function modeNote() {
    $('#modeNote').textContent = cfg.mode === 'here'
      ? 'A distraction is leaving this tab for more than 10 seconds, or going idle in it. Afterglow can\'t see other tabs, apps or your phone.'
      : 'For paper, books or another app. Tab switches are ignored. Only idle time and check-ins count, so the score leans on your honesty.';
  }
  function setLen(v) { cfg.minutes = clamp(Math.round(v) || 1, 1, 240); $('#lenMin').value = cfg.minutes; $$('#lenChips .chip').forEach((x) => x.classList.toggle('on', +x.dataset.min === cfg.minutes)); renderHud(); }
  function bindSetup() {
    const lenIn = $('#lenMin'), brkIn = $('#brkMin');
    function setBrk(v) { db.breakMin = clamp(Math.round(v) || 1, 1, 60); brkIn.value = db.breakMin; save(); }
    $$('#lenChips .chip').forEach((c) => c.addEventListener('click', () => setLen(+c.dataset.min)));
    $$('[data-len]').forEach((b) => b.addEventListener('click', () => setLen(cfg.minutes + +b.dataset.len)));
    lenIn.addEventListener('change', () => setLen(+lenIn.value));
    $$('[data-brk]').forEach((b) => b.addEventListener('click', () => setBrk(db.breakMin + +b.dataset.brk)));
    brkIn.addEventListener('change', () => setBrk(+brkIn.value)); setBrk(db.breakMin);
    $$('[data-badd]').forEach((b) => b.addEventListener('click', () => { breakEndsAt = Math.max(Date.now() + 15000, breakEndsAt + +b.dataset.badd * 60000); tick(); }));
    $$('[data-bset]').forEach((b) => b.addEventListener('click', () => { breakEndsAt = Date.now() + +b.dataset.bset * 60000; tick(); }));
    $('#extendBtn').addEventListener('click', () => extend(5));
    const me = $('#myName'); me.value = db.me || ''; me.addEventListener('change', () => { db.me = me.value.trim().slice(0, 16); save(); });
    $('#roomCreate').addEventListener('click', () => {
      db.me = me.value.trim().slice(0, 16);
      const start = Math.ceil((Date.now() + +$('#roomDelay').value * 60000) / 1000) * 1000;
      const r = parseRoom(roomCode({ start, minutes: cfg.minutes, name: $('#roomName').value || 'room', subject: cfg.subject }));
      if (r && enterRoom(r)) toast('Room made. Send the ' + (inFrame ? 'code' : 'link') + ' to your group.');
    });
    $('#roomJoin').addEventListener('click', () => { db.me = me.value.trim().slice(0, 16); const r = parseRoom($('#roomCode').value); if (!r) return toast('That doesn\'t look like a room code. It starts with ag-.'); enterRoom(r); });
    $('#lobbyCopyCode').addEventListener('click', () => room && copyText(room.code, 'Code copied.'));
    $('#lobbyCopyLink').addEventListener('click', () => room && copyText(location.origin + location.pathname + '#' + room.code, 'Invite link copied.'));
    $('#lobbyLeave').addEventListener('click', leaveRoom);
    $('#copyResult').addEventListener('click', () => copyText($('#myResult').textContent, 'Result code copied.'));
    $('#mateAdd').addEventListener('click', addMate);
    $$('#modeSeg button').forEach((b) => b.addEventListener('click', () => {
      $$('#modeSeg button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }); cfg.mode = b.dataset.mode; modeNote();
    }));
    $('#idleSel').addEventListener('change', (e) => (cfg.idleMin = +e.target.value));
    $('#notifyChk').addEventListener('change', async (e) => {
      if (!e.target.checked) return;
      let ok = false; try { ok = 'Notification' in window && (await Notification.requestPermission()) === 'granted'; } catch (err) {}
      if (!ok) { e.target.checked = false; toast('Notifications are blocked here. They work on the deployed site once you allow them.'); }
    });
    $('#twist').addEventListener('input', (e) => (V.twist = +e.target.value));
    $('#psize').addEventListener('input', (e) => (V.size = +e.target.value));
    $('#startBtn').addEventListener('click', () => startSession());
    $('#pauseBtn').addEventListener('click', pauseToggle); $('#dockPause').addEventListener('click', pauseToggle);
    $('#breakBtn').addEventListener('click', startBreak); $('#breakEnd').addEventListener('click', endBreak);
    $('#floatBtn').addEventListener('click', openFloat);
    let endArm = 0;
    $('#endBtn').addEventListener('click', (e) => { if (Date.now() - endArm < 4000) { endArm = 0; e.target.textContent = 'End session'; finish(true); } else { endArm = Date.now(); e.target.textContent = 'Tap again to end'; setTimeout(() => { if (endArm) { endArm = 0; e.target.textContent = 'End session'; } }, 4000); } });
    $('#replayBtn').addEventListener('click', () => viewRec && openViewer(viewRec, true));
    $('#shareBtn').addEventListener('click', () => viewRec && openCard(viewRec));
    $('#againBtn').addEventListener('click', () => { sess = null; viewRec = null; restore(); showState('setup'); renderHud(); });
    $('#checkYes').addEventListener('click', () => closeCheckin('ok')); $('#checkNo').addEventListener('click', () => closeCheckin('drifted'));
    $('#vClose').addEventListener('click', closeViewer); $('#vReplay').addEventListener('click', startReplay);
    $('#vShare').addEventListener('click', () => viewerRec && openCard(viewerRec));
    $('#vDelete').addEventListener('click', (e) => {
      if (!viewerRec || viewerRec.example) return;
      if (e.target.textContent !== 'Tap again to delete') { e.target.textContent = 'Tap again to delete'; return; }
      db.sessions = db.sessions.filter((r) => r.id !== viewerRec.id); save(); if (viewRec && viewRec.id === viewerRec.id) { viewRec = null; if (sess && sess.status === 'done') { sess = null; showState('setup'); } }
      closeViewer(); renderGallery(); renderStats(); renderHud();
    });
    $('#cardClose').addEventListener('click', () => { $('#cardModal').hidden = true; backFocus(); }); $('#cardSave').addEventListener('click', saveCard);
    $('#cardShare').addEventListener('click', async () => { try { await navigator.share({ files: [new File([cardBlob], 'afterglow.png', { type: 'image/png' })], title: 'Afterglow' }); } catch (e) {} });
    $('#cardModal').addEventListener('click', (e) => { if (e.target.id === 'cardModal') e.target.hidden = true; });
    addEventListener('keydown', (e) => {   // keep Tab inside whichever overlay is open
      if (e.key !== 'Tab') return;
      const o = ['#cardModal', '#break', '#viewer'].map((q) => $(q)).find((el) => !el.hidden); if (!o) return;
      const f = $$('button, a[href], input, select', o).filter((x) => !x.hidden && x.offsetParent !== null); if (!f.length) return;
      const a = document.activeElement, first = f[0], last = f[f.length - 1];
      if (!o.contains(a)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    });
    addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (!$('#cardModal').hidden) $('#cardModal').hidden = true; else if (!$('#viewer').hidden) closeViewer(); else if (!$('#break').hidden) endBreak(); });
    $('#examForm').addEventListener('submit', (e) => { e.preventDefault(); const date = $('#examDate').value; db.exam = date ? { name: $('#examName').value.trim(), date } : null; save(); renderExam(); toast(date ? 'Countdown saved.' : 'Countdown cleared.'); });
    $('#clearBtn').addEventListener('click', (e) => {
      if (e.target.textContent !== 'Tap again to erase everything') { e.target.textContent = 'Tap again to erase everything'; setTimeout(() => (e.target.textContent = 'Clear local data'), 4000); return; }
      try { localStorage.removeItem(KEY); } catch (err) {}
      db = { sessions: [], subjects: ['Maths', 'Coding', 'Reading', 'Revision'], exam: null, me: '', breakMin: 5, room: null, boards: {} }; mem = db; room = null; cfg.subject = db.subjects[0]; viewRec = null; if (sess && sess.status === 'done') { sess = null; showState('setup'); }
      e.target.textContent = 'Clear local data'; restore(); renderSubjects(); renderGallery(); renderStats(); renderHud(); toast('Local data erased.');
    });
    $('#heroStart').addEventListener('click', (e) => {   // first visit: one tap plays a track and grows a 1-minute sculpture
      if (db.sessions.length || sess || room) return;
      e.preventDefault(); e.stopImmediatePropagation(); if (!A.playing) A.playTrack(0); setLen(1); startSession(); $('#playground').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
    });
    document.addEventListener('click', (e) => {   // in-page links scroll by script, so they also work inside an embedded preview
      const a = e.target.closest('a[href^="#"]'); if (!a) return; const t = document.getElementById(a.getAttribute('href').slice(1)); if (!t) return;
      e.preventDefault(); t.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
    });
    $('#backupBtn').addEventListener('click', backup);
    $('#restoreIn').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) restoreFrom(f); e.target.value = ''; });
    $('#restoreLbl').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#restoreIn').click(); } });
    const coarse = matchMedia('(pointer: coarse)').matches;
    $('#phoneNote').hidden = !coarse; $('#wakeChk').checked = coarse; $('#wakeTog').hidden = !('wakeLock' in navigator);
    $('#heroListen').addEventListener('click', useMic);
    $('#heroPlay').addEventListener('click', () => { A.playTrack(A.lastTrack); });
  }

  /* ---------- sound UI ---------- */
  function micError(e) {
    const n = e && e.name;
    toast(n === 'NotAllowedError' || n === 'SecurityError' ? 'The mic is blocked here. Claude\'s preview always blocks it. On the deployed site, allow it when the browser asks.'
      : n === 'NotFoundError' ? 'No microphone was found on this device.' : 'The mic isn\'t available in this browser.', 6500);
  }
  function useTab() {
    A.tab().then(() => toast('Following that tab. It keeps playing as normal and nothing is recorded.')).catch((e) => {
      const n = e && e.name;
      toast(n === 'NoAudio' ? 'No sound came with it. Pick a Chrome tab and tick "Also share tab audio".' : n === 'NotAllowedError' ? 'Sharing was cancelled or is blocked here. It works on the deployed site in desktop Chrome or Edge.' : 'This browser can\'t share tab audio. Use desktop Chrome or Edge.', 7000);
    });
  }
  function useMic() { A.mic().then(() => toast('Listening. Nothing is recorded or sent anywhere.')).catch(micError); }
  const ICONS = {
    desk: 'M5 20h8M9 20v-6M9 14l6-7M12.5 4.5l5 4-3 2.5-4-3.5z', rain: 'M7 4v5M12 6v6M17 4v5M9.5 14v5M14.5 15v5', tide: 'M3 9c3-3 6 3 9 0s6-3 9 0M3 15c3-3 6 3 9 0s6-3 9 0',
    lantern: 'M9 4h6M12 2v2M8 7c0-2 8-2 8 0v8c0 2-8 2-8 0zM12 17v4M10 21h4', field: 'M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6zM19 17v3M17.5 18.5h3',
    noise: 'M3 12h2l1.5-5 2 10 2-13 2 15 2-11 1.5 6 1.5-4H21', phones: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1z', pulse: 'M2 12h3l2-6 3 12 3-12 3 12 2-6h4',
  };
  function renderTracks() {
    $$('[data-tracks]').forEach((el) => {
      el.textContent = '';
      A.TRACKS.forEach((t, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'trk'; b.style.setProperty('--h', t.hue); b.dataset.i = i;
        b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICONS[t.icon] + '"/></svg><span><b>' + t.name + '</b><small>' + t.mood + '</small></span><em><i></i><i></i><i></i></em>';
        b.addEventListener('click', () => { if (A.current && A.current.kind === 'track' && A.current.idx === i) A.stop(); else A.playTrack(i); });
        el.appendChild(b);
      });
    });
  }
  function syncSound(cur) {
    $$('.trk').forEach((b) => { const on = !!(cur && cur.kind === 'track' && cur.idx === +b.dataset.i); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    $$('[data-mic]').forEach((b) => b.classList.toggle('on', !!(cur && cur.kind === 'mic')));
    $$('[data-tab]').forEach((b) => b.classList.toggle('on', !!(cur && cur.kind === 'tab')));
    const t = A.TRACKS[A.lastTrack];
    $('#pName').textContent = cur ? cur.name : t.name;
    $('#pMood').textContent = cur ? (cur.kind === 'track' ? A.TRACKS[cur.idx].mood : cur.kind === 'mic' ? 'Listening · not recorded' : cur.kind === 'tab' ? 'Read here · not recorded' : 'Your file · looping') : 'Tap to play';
    $('#pIcon').setAttribute('d', cur ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z'); $('#pToggle').setAttribute('aria-label', cur ? 'Stop' : 'Play');
  }
  function bindSound() {
    renderTracks(); A.on(syncSound); syncSound(null);
    if (!A.supported) toast('This browser has no Web Audio, so sound is off.');
    $('#pToggle').addEventListener('click', () => A.toggle()); $('#pNext').addEventListener('click', () => A.next(1));
    $('#pOpen').addEventListener('click', () => { const l = $('#plist'); l.hidden = !l.hidden; $('#pOpen').setAttribute('aria-expanded', !l.hidden); });
    $('#vol').addEventListener('input', (e) => A.setVolume(+e.target.value));
    $$('[data-mic]').forEach((b) => b.addEventListener('click', () => { if (A.current && A.current.kind === 'mic') A.stop(); else useMic(); }));
    $$('[data-tab]').forEach((b) => { b.hidden = !A.tabSupported || matchMedia('(pointer: coarse)').matches; b.addEventListener('click', () => { if (A.current && A.current.kind === 'tab') A.stop(); else useTab(); }); });
    $$('[data-upload]').forEach((inp) => inp.addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) { A.file(f); toast('Playing your file. It stays on this device.'); } e.target.value = ''; }));
  }

  /* ---------- scroll choreography + per-frame work ---------- */
  const heroInner = $('#heroInner'), howEl = $('#how'), steps = $$('#steps .step'), rail = $('#rail'), marq = $('#marq'), marqWrap = marq.parentElement, progEl = $('#prog'), nav = $('#nav');
  const bars = $('#pBars'), bx = bars.getContext('2d'), glabels = $('#glabels'), gardenEl = $('#garden');
  let lastY = -1, gardenOn = false, stepIdx = -1, annoOn = false;
  const anno = $('#anno'), annoTrack = $('#annoTrack');
  function onScroll(y) {
    const vh = innerHeight, doc = document.documentElement.scrollHeight - vh;
    progEl.style.transform = 'scaleX(' + (doc > 0 ? y / doc : 0).toFixed(4) + ')';
    nav.classList.toggle('scrolled', y > 40);
    if (!reduced && y < vh * 1.2) { const k = clamp(y / (vh * 0.7), 0, 1); heroInner.style.transform = 'translate3d(0,' + (-y * 0.22).toFixed(1) + 'px,0)'; heroInner.style.opacity = (1 - k * k).toFixed(3); }
    const hr = howEl.getBoundingClientRect(), p = clamp(-hr.top / (hr.height - vh), 0, 1), idx = Math.min(2, Math.floor(p * 3));
    rail.style.transform = 'scaleX(' + p.toFixed(4) + ')';
    if (idx !== stepIdx) { stepIdx = idx; steps.forEach((s, i) => { s.classList.toggle('on', i === idx); s.classList.toggle('past', i < idx); }); }
    if (!reduced) { const mr = marqWrap.getBoundingClientRect(); if (mr.top < vh && mr.bottom > 0) marq.style.transform = 'translate3d(' + (-(vh - mr.top) * 0.45).toFixed(1) + 'px,0,0)'; }
  }
  AG.onFrame.push((dt, time) => {
    A.sample();
    V.bass += (A.bass - V.bass) * 0.3; V.mid += (A.mid - V.mid) * 0.3; V.high += (A.high - V.high) * 0.3;
    if (mode === 'roll' && !reduced) { rollAcc += dt; if (rollAcc > 1 / 12) { rollAcc = 0; rollStep(); AG.updateSculpt(roll); } }
    if (mode === 'session' && sess) { const live = sess.status === 'running' ? (Date.now() - sess.last) / 1000 : 0; V.grow = clamp((sess.elapsed + live) / sess.planned, 0, 1); }
    if (replayT0) { const k = (performance.now() - replayT0) / 10000; V.grow = clamp(k, 0, 1) * ((viewerRec && viewerRec.grown) || 1); V.spinBoost = reduced ? 0 : 0.5 * (1 - k); if (k >= 1) { replayT0 = 0; V.spinBoost = 0; } }
    if (scrollY !== lastY) { lastY = scrollY; onScroll(lastY); }
    if (sess && sess.status === 'break') drawBreath(performance.now());
    const showAnno = !reduced && mode === 'roll' && scrollY < innerHeight * 0.35 && !V.override;
    if (showAnno !== annoOn) { annoOn = showAnno; anno.classList.toggle('on', annoOn); }
    if (annoOn) {
      const a = AG.project(0, 1.24, 0), b = AG.project(0, -1.24, 0);
      anno.children[0].style.transform = 'translate3d(' + a[0].toFixed(1) + 'px,' + a[1].toFixed(1) + 'px,0)';
      anno.children[1].style.transform = 'translate3d(' + b[0].toFixed(1) + 'px,' + b[1].toFixed(1) + 'px,0)';
      annoTrack.textContent = A.current ? A.current.name : 'Idle preview';
    }
    // player bars
    bx.clearRect(0, 0, 96, 36);
    for (let b = 0; b < B; b++) { const h = 2 + A.bands[b] * 32; bx.fillStyle = 'hsl(' + (hueNow - b * 2) + ' 90% ' + (55 + A.bands[b] * 20) + '%)'; bx.fillRect(b * 6, 36 - h, 4, h); }
    // garden labels
    if (gardenOn) {
      const kids = glabels.children;
      for (let i = 0; i < kids.length && i < gardenPts.length; i++) { const p = AG.project(gardenPts[i].x, -0.86, gardenPts[i].z); kids[i].style.transform = 'translate3d(' + p[0].toFixed(1) + 'px,' + p[1].toFixed(1) + 'px,0) translateX(-50%)'; }
    }
  });
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
    $$('.rv').forEach((el) => io.observe(el));
    new IntersectionObserver((es) => { gardenOn = es[0].intersectionRatio > 0.45; glabels.classList.toggle('on', gardenOn); }, { threshold: [0, 0.45, 0.6] }).observe(gardenEl);
    new IntersectionObserver((es) => { playInView = es[0].isIntersecting; if (sess) renderHud(); }, { threshold: 0.15 }).observe($('#playground'));
  } else $$('.rv').forEach((el) => el.classList.add('in'));

  /* ---------- boot ---------- */
  renderSubjects(); modeNote(); bindSetup(); bindSound(); renderGallery(); renderStats(); renderHud(); onScroll(scrollY);
  AG.start();
  if (!resumeLive()) {
    const fromLink = parseRoom(location.hash), invited = fromLink || parseRoom(db.room);
    if (fromLink && Date.now() < fromLink.start + fromLink.minutes * 60000 - 60000) { $('#roomCode').value = fromLink.code; setTimeout(() => { $('#playground').scrollIntoView(); toast('Invite to ' + fromLink.name + ' found. Add your name and tap Join.'); }, 400); }
    else if (invited && db.room) enterRoom(invited, true);
  }
  addEventListener('pagehide', saveLive);
  // offline support on the deployed site (service workers are not available inside an embedded preview)
  try { if ('serviceWorker' in navigator && window.top === window && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) {}
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => AG.measure());
  AG._debug = { get sess() { return sess; }, finish, startSession, cfg, tick, enterRoom, parseRoom, roomCode };
})();

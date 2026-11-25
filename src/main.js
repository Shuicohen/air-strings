import { AudioEngine, snapPentatonic, noteName } from './audio.js';
import { HandTracker } from './hands.js';

const MAX_STRINGS = 8;
const MIN_LEN = 48;
const PLUCK_COOLDOWN = 110; // ms per cursor+string

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const video = document.getElementById('video');
const $ = (id) => document.getElementById(id);
const ui = {
  cam: $('btn-camera'), mouse: $('btn-mouse'), snap: $('btn-snap'), clear: $('btn-clear'),
  help: $('btn-help'), helpPanel: $('help'), helpClose: $('btn-help-close'),
  status: $('status'), toast: $('toast'), hint: $('hint'),
};

const audio = new AudioEngine();
const tracker = new HandTracker(video);

const app = {
  mode: 'mouse',
  snap: true,
  strings: [],
  sparks: [],
  cursors: new Map(), // id -> cursor state
  selected: null,
  nextId: 1,
  dpr: 1, w: 0, h: 0,
  cooldown: new Map(),
};
window.airStrings = {
  get count() { return app.strings.length; },
  get mode() { return app.mode; },
  get snap() { return app.snap; },
  strings: () => app.strings.map((s) => ({ id: s.id, freq: +s.freq.toFixed(2), note: noteName(s.freq), len: Math.round(len(s)) })),
  audio: () => ({ state: audio.ctx ? audio.ctx.state : 'none', sampleRate: audio.ctx?.sampleRate, rms: audio.rms() }),
};

// ---------- geometry ----------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const len = (s) => dist(s.a, s.b);
function segIntersect(p, q, a, b) {
  const r = { x: q.x - p.x, y: q.y - p.y };
  const s = { x: b.x - a.x, y: b.y - a.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.x - p.x) * s.y - (a.y - p.y) * s.x) / den;
  const u = ((a.x - p.x) * r.y - (a.y - p.y) * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p.x + r.x * t, y: p.y + r.y * t, u };
}
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return { d: Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u)), u };
}

// ---------- pitch ----------
function lenToFreq(L) {
  const ref = Math.min(app.w, app.h) * 0.5; // a string this long ≈ C4
  let f = 262 * (ref / Math.max(L, 20));
  f = Math.max(82, Math.min(1568, f));
  return app.snap ? snapPentatonic(f) : f;
}
// each string gets its own colour from a palette; pitch nudges it slightly
const PALETTE = [190, 300, 38, 140, 265, 12, 170, 52];
const hueFor = (f, s) => (PALETTE[((s?.id ?? 1) - 1) % PALETTE.length] + Math.log2(f / 262) * 10 + 360) % 360;

// ---------- strings ----------
function addString(a, b) {
  if (app.strings.length >= MAX_STRINGS) {
    const old = app.strings.find((s) => !s.dying);
    if (old) removeString(old, false);
    toast(`Up to ${MAX_STRINGS} strings: removed the oldest`);
  }
  const s = { id: app.nextId++, a: { ...a }, b: { ...b }, amp: 0, pluckT: 0, pluckU: 0.5, born: now(), dying: 0, voice: null };
  s.freq = lenToFreq(len(s));
  s.hue = hueFor(s.freq, s);
  s.voice = audio.createVoice(s.freq);
  app.strings.push(s);
  app.selected = s;
  updatePan(s);
  pluck(s, 0.45, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 0.5);
  refreshHint();
  return s;
}
function removeString(s, sparks = true) {
  if (s.dying) return;
  s.dying = now();
  if (sparks) {
    for (let i = 0; i <= 10; i++) {
      const u = i / 10;
      burst({ x: s.a.x + (s.b.x - s.a.x) * u, y: s.a.y + (s.b.y - s.a.y) * u }, s.hue, 3, 0.6);
    }
  }
  s.voice?.dispose();
  for (const c of app.cursors.values()) if (c.target?.s === s) c.target = null;
  if (app.selected === s) app.selected = null;
  setTimeout(() => { app.strings = app.strings.filter((x) => x !== s); refreshHint(); }, 450);
}
function clearAll() {
  app.strings.filter((s) => !s.dying).forEach((s) => removeString(s));
}
function retune(s) {
  const f = lenToFreq(len(s));
  if (Math.abs(f - s.freq) / s.freq > 0.001) {
    s.freq = f;
    s.hue = hueFor(f, s);
    s.voice?.setFreq(f);
  }
  updatePan(s);
}
function updatePan(s) {
  s.voice?.setPan((((s.a.x + s.b.x) / 2) / app.w) * 1.4 - 0.7);
}
function pluck(s, velocity, at, u) {
  if (s.dying) return;
  const v = Math.max(0.12, Math.min(1, velocity));
  if (!s.voice) { s.voice = audio.createVoice(s.freq); updatePan(s); }
  s.voice?.pluck(v);
  s.amp = Math.min(1.4, s.amp * 0.4 + v);
  s.pluckT = now();
  s.pluckU = u;
  app.selected = s;
  burst(at, s.hue, 6 + Math.round(v * 16), v);
}

// ---------- sparks ----------
function burst(p, hue, n, v) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (60 + Math.random() * 380) * (0.5 + v);
    app.sparks.push({ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 0, max: 0.35 + Math.random() * 0.5, hue: hue + (Math.random() * 40 - 20), size: 1.4 + Math.random() * 2.8 });
  }
  if (app.sparks.length > 900) app.sparks.splice(0, app.sparks.length - 900);
}

// ---------- unified cursor handling (mouse/touch/hands) ----------
// cursor: { id, kind, pos, prev, vel, down, mode, target, start, pluckPos, pluckPrev }
function cursorFor(id, kind) {
  let c = app.cursors.get(id);
  if (!c) {
    c = { id, kind, pos: null, prev: null, vel: { x: 0, y: 0 }, down: false, mode: null, target: null, start: null, pluckPos: null, pluckPrev: null, t: now() };
    app.cursors.set(id, c);
  }
  return c;
}
function grabRadius(c) { return c.kind === 'hand' ? 56 : 26; }

function hitEndpoint(p, r) {
  let best = null, bd = r;
  for (const s of app.strings) {
    if (s.dying) continue;
    for (const end of ['a', 'b']) {
      const d = dist(p, s[end]);
      if (d < bd) { bd = d; best = { s, end }; }
    }
  }
  return best;
}
function hitBody(p, r) {
  let best = null, bd = r;
  for (const s of app.strings) {
    if (s.dying) continue;
    const h = distToSeg(p, s.a, s.b);
    if (h.d < bd && h.u > 0.12 && h.u < 0.88) { bd = h.d; best = { s, u: h.u }; }
  }
  return best;
}

function moveCursor(c, pos, pluckPos) {
  const t = now();
  const dt = Math.max(1, t - c.t) / 1000;
  c.prev = c.pos;
  c.pos = { ...pos };
  if (c.prev) {
    const k = 0.5;
    c.vel = { x: c.vel.x * (1 - k) + ((pos.x - c.prev.x) / dt) * k, y: c.vel.y * (1 - k) + ((pos.y - c.prev.y) / dt) * k };
  }
  c.pluckPrev = c.pluckPos;
  c.pluckPos = pluckPos ? { ...pluckPos } : { ...pos };
  c.t = t;
  c.dt = dt;
}

function cursorDown(c) {
  c.down = true;
  c.start = { ...c.pos };
  const ep = hitEndpoint(c.pos, grabRadius(c));
  if (ep) { c.mode = 'stretch'; c.target = ep; app.selected = ep.s; return; }
  const body = hitBody(c.pos, c.kind === 'hand' ? 40 : 16);
  if (body) {
    if (c.kind === 'hand') { c.mode = 'hold'; c.target = { s: body.s }; app.selected = body.s; return; }
    c.mode = 'strum';
    pluck(body.s, 0.55, c.pos, body.u);
    app.cooldown.set(`${c.id}:${body.s.id}`, now());
    return;
  }
  c.mode = 'free';
}

function cursorUp(c) {
  if (!c.down) return;
  c.down = false;
  if (c.mode === 'free' && c.kind !== 'hand') {
    if (dist(c.start, c.pos) >= MIN_LEN) addString(c.start, c.pos);
  } else if (c.mode === 'free' && c.kind === 'hand') {
    const other = [...app.cursors.values()].find((o) => o !== c && o.kind === 'hand' && o.down && o.mode === 'free');
    if (other && dist(c.pos, other.pos) >= MIN_LEN) {
      addString(c.pos, other.pos);
      other.mode = 'spent'; // the other hand has to release before it can start something new
    }
  } else if (c.mode === 'hold' && c.target) {
    if (Math.hypot(c.vel.x, c.vel.y) > 1600) removeString(c.target.s);
  }
  c.mode = null;
  c.target = null;
}

function cursorDrag(c) {
  if (!c.prev) return;
  const dx = c.pos.x - c.prev.x, dy = c.pos.y - c.prev.y;
  if (c.mode === 'stretch' && c.target) {
    const s = c.target.s;
    s[c.target.end] = { ...c.pos };
    retune(s);
  } else if (c.mode === 'hold' && c.target) {
    const s = c.target.s;
    s.a.x += dx; s.a.y += dy; s.b.x += dx; s.b.y += dy;
    updatePan(s);
    if (Math.hypot(c.vel.x, c.vel.y) > 2600) { removeString(s); c.target = null; c.mode = 'spent'; }
  } else if (c.mode === 'strum') {
    tryPluck(c, c.prev, c.pos);
  }
}

function tryPluck(c, p, q) {
  if (!p || !q || (p.x === q.x && p.y === q.y)) return;
  const speed = dist(p, q) / (c.dt || 0.016);
  for (const s of app.strings) {
    if (s.dying) continue;
    if (c.target?.s === s) continue;
    const hit = segIntersect(p, q, s.a, s.b);
    if (!hit) continue;
    const key = `${c.id}:${s.id}`;
    if (now() - (app.cooldown.get(key) || 0) < PLUCK_COOLDOWN) continue;
    app.cooldown.set(key, now());
    pluck(s, speed / 2400, hit, hit.u);
  }
}

// Called every frame for idle (not pressed) cursors: fingertip / hover sweeps pluck.
function cursorIdle(c) {
  tryPluck(c, c.pluckPrev, c.pluckPos);
}

// ---------- pointer input ----------
canvas.addEventListener('pointerdown', async (e) => {
  if (e.button === 2) return;
  ensureAudio();
  canvas.setPointerCapture(e.pointerId);
  const c = cursorFor(`p${e.pointerId}`, e.pointerType === 'touch' ? 'touch' : 'mouse');
  moveCursor(c, pt(e));
  cursorDown(c);
});
canvas.addEventListener('pointermove', (e) => {
  const c = cursorFor(`p${e.pointerId}`, e.pointerType === 'touch' ? 'touch' : 'mouse');
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs.length ? evs : [e]) {
    moveCursor(c, pt(ev));
    if (c.down) cursorDrag(c);
    else if (c.kind === 'mouse') cursorIdle(c);
  }
});
const endPointer = (e) => {
  const c = app.cursors.get(`p${e.pointerId}`);
  if (!c) return;
  moveCursor(c, pt(e));
  cursorUp(c);
  if (c.kind === 'touch') app.cursors.delete(c.id);
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => {
  const c = app.cursors.get(`p${e.pointerId}`);
  if (c && !c.down) { c.pos = null; c.prev = null; c.pluckPos = null; c.pluckPrev = null; }
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const b = hitBody(pt(e), 18) || hitEndpoint(pt(e), 26);
  if (b) removeString(b.s);
});
canvas.addEventListener('dblclick', (e) => {
  const b = hitBody(pt(e), 14);
  if (b) removeString(b.s);
});
function pt(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
  const k = e.key.toLowerCase();
  if (k === 'c') { clearAll(); }
  else if (k === 'delete' || k === 'backspace' || k === 'x') {
    const s = app.selected && !app.selected.dying ? app.selected : [...app.strings].reverse().find((x) => !x.dying);
    if (s) removeString(s);
  } else if (k === 's') { setSnap(!app.snap); }
  else if (k === 'h' || k === '?') { toggleHelp(); }
  else if (k === 'escape') { toggleHelp(false); }
  else return;
  ensureAudio();
});

// ---------- hands ----------
function videoMapper() {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const scale = Math.max(app.w / vw, app.h / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (app.w - dw) / 2, oy = (app.h - dh) / 2;
  return { ox, oy, dw, dh, map: (nx, ny) => ({ x: ox + (1 - nx) * dw, y: oy + ny * dh }) };
}

function updateHands() {
  if (!tracker.active) return;
  let hands = [];
  try { hands = tracker.update(videoMapper().map); } catch (err) { console.warn('hand tracking frame skipped', err); return; }
  const live = new Set();
  for (const h of hands) {
    const id = `hand-${h.id}`;
    live.add(id);
    const c = cursorFor(id, 'hand');
    c.hand = h;
    moveCursor(c, h.pinchPt, h.tip);
    if (h.pinch && !c.down) cursorDown(c);
    else if (!h.pinch && c.down) cursorUp(c);
    else if (c.down) cursorDrag(c);
    if (!c.down) cursorIdle(c);
  }
  for (const [id, c] of app.cursors) {
    if (c.kind === 'hand' && !live.has(id)) { if (c.down) { c.mode = null; c.down = false; } app.cursors.delete(id); }
  }
  ui.status.textContent = hands.length ? `${hands.length} hand${hands.length > 1 ? 's' : ''} tracked` : 'Show your hands to the camera';
}

// ---------- UI ----------
async function ensureAudio() {
  try { await audio.start(); } catch (err) { console.warn('Audio could not start', err); }
}
function setSnap(on) {
  app.snap = on;
  ui.snap.setAttribute('aria-pressed', String(on));
  ui.snap.querySelector('.state').textContent = on ? 'on' : 'off';
  app.strings.forEach(retune);
  toast(on ? 'Pentatonic snap on' : 'Free tuning (snap off)');
}
async function setMode(mode) {
  if (mode === app.mode) return;
  ensureAudio();
  if (mode === 'camera') {
    ui.cam.disabled = true;
    try {
      await tracker.start((m) => { ui.status.textContent = m; });
      app.mode = 'camera';
      document.body.classList.add('camera-on');
      toast('Camera on: frames stay on this device');
    } catch (err) {
      tracker.stop();
      app.mode = 'mouse';
      ui.status.textContent = '';
      toast(err && err.name === 'NotAllowedError' ? 'Camera permission was blocked' : `Camera unavailable: ${err?.message || err}`);
    } finally { ui.cam.disabled = false; }
  } else {
    tracker.stop();
    for (const [id, c] of app.cursors) if (c.kind === 'hand') app.cursors.delete(id);
    app.mode = 'mouse';
    document.body.classList.remove('camera-on');
    ui.status.textContent = '';
  }
  ui.cam.setAttribute('aria-pressed', String(app.mode === 'camera'));
  ui.mouse.setAttribute('aria-pressed', String(app.mode === 'mouse'));
  refreshHint();
}
function toggleHelp(force) {
  const open = force ?? ui.helpPanel.hidden;
  ui.helpPanel.hidden = !open;
  ui.help.setAttribute('aria-expanded', String(open));
}
let toastTimer;
function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2200);
}
function refreshHint() {
  const empty = app.strings.filter((s) => !s.dying).length === 0;
  ui.hint.hidden = !empty;
  ui.hint.textContent = app.mode === 'camera'
    ? 'Pinch with both hands, pull apart, and let go to make a string'
    : 'Click and drag to draw a string';
}
ui.cam.addEventListener('click', () => setMode('camera'));
ui.mouse.addEventListener('click', () => setMode('mouse'));
ui.snap.addEventListener('click', () => { ensureAudio(); setSnap(!app.snap); });
ui.clear.addEventListener('click', () => { ensureAudio(); clearAll(); });
ui.help.addEventListener('click', () => toggleHelp());
ui.helpClose.addEventListener('click', () => toggleHelp(false));

// ---------- render ----------
const now = () => performance.now();
function resize() {
  const ow = app.w, oh = app.h;
  app.dpr = Math.min(window.devicePixelRatio || 1, 2);
  app.w = window.innerWidth; app.h = window.innerHeight;
  canvas.width = Math.round(app.w * app.dpr);
  canvas.height = Math.round(app.h * app.dpr);
  canvas.style.width = `${app.w}px`; canvas.style.height = `${app.h}px`;
  if (ow && oh) {
    const sx = app.w / ow, sy = app.h / oh;
    for (const s of app.strings) { s.a.x *= sx; s.a.y *= sy; s.b.x *= sx; s.b.y *= sy; retune(s); }
  }
}
window.addEventListener('resize', resize);

function drawBackground() {
  if (tracker.active && video.readyState >= 2) {
    const { ox, oy, dw, dh } = videoMapper();
    ctx.save();
    ctx.translate(app.w, 0); ctx.scale(-1, 1); // mirror
    ctx.drawImage(video, app.w - ox - dw, oy, dw, dh);
    ctx.restore();
    ctx.fillStyle = 'rgba(4, 6, 14, 0.62)';
    ctx.fillRect(0, 0, app.w, app.h);
  } else {
    const g = ctx.createRadialGradient(app.w * 0.5, app.h * 0.45, 0, app.w * 0.5, app.h * 0.5, Math.max(app.w, app.h) * 0.75);
    g.addColorStop(0, '#0d1424');
    g.addColorStop(1, '#03050a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, app.w, app.h);
  }
}

function stringPoints(s, t) {
  const N = 48;
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  const age = (t - s.pluckT) / 1000;
  const env = s.amp * Math.exp(-age * 2.2);
  const visF = 7 + Math.log2(s.freq / 65) * 2.2;
  const A = Math.min(26, L * 0.06) * env;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const shape = Math.sin(Math.PI * u) * Math.cos(2 * Math.PI * visF * age)
      + 0.35 * Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * 2 * s.pluckU) * Math.cos(4 * Math.PI * visF * age + 1);
    const o = A * shape;
    pts.push({ x: s.a.x + dx * u + nx * o, y: s.a.y + dy * u + ny * o });
  }
  return { pts, env, nx, ny };
}

function strokePath(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function drawStrings(t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of app.strings) {
    const fade = s.dying ? Math.max(0, 1 - (t - s.dying) / 420) : Math.min(1, (t - s.born) / 250);
    if (fade <= 0) continue;
    const { pts, env, nx, ny } = stringPoints(s, t);
    const glow = 0.55 + Math.min(1, env) * 0.6;
    const sel = app.selected === s;
    ctx.globalAlpha = fade;
    ctx.shadowColor = `hsla(${s.hue}, 100%, 60%, 1)`;
    ctx.shadowBlur = 26 * glow;
    ctx.strokeStyle = `hsla(${s.hue}, 100%, 60%, ${0.22 * glow})`;
    ctx.lineWidth = 12;
    strokePath(pts);
    ctx.shadowBlur = 10;
    ctx.strokeStyle = `hsla(${s.hue}, 100%, 66%, ${0.75})`;
    ctx.lineWidth = 3.2;
    strokePath(pts);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `hsla(${s.hue}, 100%, 92%, ${0.9})`;
    ctx.lineWidth = 1.2;
    strokePath(pts);
    // endpoints
    for (const end of [s.a, s.b]) {
      const grabbed = [...app.cursors.values()].some((c) => c.target?.s === s && s[c.target.end] === end);
      const r = grabbed ? 9 : 5.5;
      ctx.shadowBlur = 18;
      ctx.fillStyle = `hsla(${s.hue}, 100%, ${grabbed ? 85 : 70}%, 0.95)`;
      ctx.beginPath(); ctx.arc(end.x, end.y, r, 0, Math.PI * 2); ctx.fill();
      if (sel || grabbed) {
        ctx.shadowBlur = 0;
        ctx.strokeStyle = `hsla(${s.hue}, 100%, 80%, 0.5)`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(end.x, end.y, r + 6, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // note label
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
    const mx = (s.a.x + s.b.x) / 2, my = (s.a.y + s.b.y) / 2;
    const off = 22 * (ny > 0 ? -1 : 1);
    ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `hsla(${s.hue}, 90%, 82%, ${sel ? 0.95 : 0.6})`;
    const stretching = [...app.cursors.values()].some((c) => c.mode === 'stretch' && c.target?.s === s);
    ctx.fillText(stretching ? `${noteName(s.freq)} · ${Math.round(s.freq)} Hz` : noteName(s.freq), mx + nx * off, my + ny * off);
    ctx.globalCompositeOperation = 'lighter';
  }
  ctx.restore();
}

function drawPreview() {
  const segs = [];
  for (const c of app.cursors.values()) {
    if (c.kind !== 'hand' && c.down && c.mode === 'free' && c.start && c.pos) segs.push([c.start, c.pos]);
  }
  const hs = [...app.cursors.values()].filter((c) => c.kind === 'hand' && c.down && c.mode === 'free');
  if (hs.length >= 2) segs.push([hs[0].pos, hs[1].pos]);
  for (const [a, b] of segs) {
    const L = dist(a, b);
    const ok = L >= MIN_LEN;
    const f = lenToFreq(L);
    const hue = hueFor(f, { id: app.nextId });
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.setLineDash([6, 8]);
    ctx.lineDashOffset = -now() / 30;
    ctx.strokeStyle = `hsla(${hue}, 100%, 70%, ${ok ? 0.8 : 0.3})`;
    ctx.shadowColor = `hsla(${hue}, 100%, 60%, 1)`;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    if (ok) {
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = `hsla(${hue}, 90%, 82%, 0.85)`;
      ctx.textAlign = 'center';
      ctx.fillText(noteName(f), (a.x + b.x) / 2, (a.y + b.y) / 2 - 16);
    }
    ctx.restore();
  }
}

function drawSparks(dt) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const keep = [];
  for (const p of app.sparks) {
    p.life += dt;
    if (p.life >= p.max) continue;
    p.vx *= 0.92; p.vy = p.vy * 0.92 + 420 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    const k = 1 - p.life / p.max;
    ctx.fillStyle = `hsla(${p.hue}, 100%, ${65 + 25 * k}%, ${k})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.6 + k), 0, Math.PI * 2); ctx.fill();
    keep.push(p);
  }
  app.sparks = keep;
  ctx.restore();
}

function drawCursors() {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const c of app.cursors.values()) {
    if (!c.pos) continue;
    if (c.kind === 'hand' && c.hand) {
      const h = c.hand;
      // faint skeleton
      ctx.strokeStyle = 'rgba(160, 200, 255, 0.18)';
      ctx.lineWidth = 1.5;
      for (const [i, j] of HAND_EDGES) { ctx.beginPath(); ctx.moveTo(h.pts[i].x, h.pts[i].y); ctx.lineTo(h.pts[j].x, h.pts[j].y); ctx.stroke(); }
      ctx.fillStyle = 'rgba(200, 230, 255, 0.85)';
      for (const p of [h.tip, h.thumb]) { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = c.down ? 'rgba(255, 220, 140, 0.95)' : 'rgba(200, 230, 255, 0.35)';
      ctx.lineWidth = c.down ? 2.5 : 1.2;
      ctx.beginPath(); ctx.arc(h.pinchPt.x, h.pinchPt.y, c.down ? 14 : 10, 0, Math.PI * 2); ctx.stroke();
    } else if (c.kind === 'mouse') {
      ctx.fillStyle = c.down ? 'rgba(255, 220, 140, 0.9)' : 'rgba(200, 230, 255, 0.55)';
      ctx.shadowColor = 'rgba(160, 210, 255, 1)';
      ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(c.pos.x, c.pos.y, c.down ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}
const HAND_EDGES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

let last = now();
function frame() {
  const t = now();
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  updateHands();
  ctx.setTransform(app.dpr, 0, 0, app.dpr, 0, 0);
  drawBackground();
  drawStrings(t);
  drawPreview();
  drawSparks(dt);
  drawCursors();
  requestAnimationFrame(frame);
}

resize();
refreshHint();
requestAnimationFrame(frame);

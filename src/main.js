import { AudioEngine, noteName, freqForLength } from './audio.js';
import { HandTracker } from './hands.js';
import { createGestures, dist } from './gestures.js';

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
  errPanel: $('cam-error'), errStep: $('cam-error-step'), errMsg: $('cam-error-msg'), errExtra: $('cam-error-extra'),
  errHint: $('cam-error-hint'), errRetry: $('btn-retry'), errMouse: $('btn-use-mouse'),
  camSelect: $('cam-select'), camSelectWrap: $('cam-select-wrap'), errSelect: $('cam-error-select'), errSelectWrap: $('cam-error-select-wrap'),
  errAttempts: $('cam-error-attempts'),
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
  get camera() { return { device: tracker.device?.label || null, devices: (tracker.devices || []).map((d) => d.label), attempts: (tracker.attempts || []).slice(), delegate: tracker.delegate, width: video.videoWidth, height: video.videoHeight, active: tracker.active, notes: tracker.notes.slice() }; },
  strings: () => app.strings.map((s) => ({ id: s.id, freq: +s.freq.toFixed(2), note: noteName(s.freq), len: Math.round(len(s)) })),
  audio: () => ({ state: audio.ctx ? audio.ctx.state : 'none', sampleRate: audio.ctx?.sampleRate, rms: audio.rms() }),
};

// ---------- geometry ----------
const len = (s) => dist(s.a, s.b);

// ---------- pitch ----------
function lenToFreq(L) {
  return freqForLength(L, Math.min(app.w, app.h) * 0.5, app.snap);
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
  gestures.forget(s);
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
  if (s.voice) s.voice.pluck(v);
  else if (audio.ready) {
    // first gesture: the worklet is still loading, so play this pluck as soon as it is ready
    audio.ready.then(() => {
      if (s.dying) return;
      if (!s.voice) { s.voice = audio.createVoice(s.freq); updatePan(s); }
      s.voice?.pluck(v);
    }).catch(() => {});
  }
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

// ---------- gestures (see gestures.js for the rules) ----------
const gestures = createGestures({
  now: () => now(),
  minLen: MIN_LEN,
  cooldown: PLUCK_COOLDOWN,
  getStrings: () => app.strings,
  onCreate: (a, b) => addString(a, b),
  onPluck: (s, v, at, u) => pluck(s, v, at, u),
  onChange: (s) => retune(s),
  onDelete: (s) => removeString(s),
  onSelect: (s) => { app.selected = s; },
});
app.cursors = gestures.cursors;

// ---------- pointer input ----------
const kindOf = (e) => (e.pointerType === 'touch' ? 'touch' : 'mouse');
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return;
  ensureAudio();
  canvas.setPointerCapture(e.pointerId);
  gestures.pointerDown(`p${e.pointerId}`, kindOf(e), pt(e), now());
});
canvas.addEventListener('pointermove', (e) => {
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of evs.length ? evs : [e]) gestures.pointerMove(`p${e.pointerId}`, kindOf(e), pt(ev), ev.timeStamp || now());
});
const endPointer = (e) => gestures.pointerUp(`p${e.pointerId}`, pt(e), now());
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => gestures.pointerLeave(`p${e.pointerId}`));
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const b = gestures.hitBody(pt(e), 18) || gestures.hitEndpoint(pt(e), 26);
  if (b) removeString(b.s);
});
canvas.addEventListener('dblclick', (e) => {
  const b = gestures.hitBody(pt(e), 14);
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
  try { hands = tracker.update(videoMapper().map); } catch (err) { return; }
  gestures.handsFrame(hands, now());
  const v = video;
  const info = `${tracker.device?.label || 'Camera'} · ${tracker.delegate || '?'} · ${v.videoWidth}×${v.videoHeight}`;
  ui.status.textContent = `${info} · ${hands.length ? `${hands.length} hand${hands.length > 1 ? 's' : ''} tracked` : 'show your hands'}`;
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
// Must run synchronously inside a click/change handler: getUserMedia is called before any await.
// opts.deviceId switches to (only) that camera.
function startCamera(opts = {}) {
  if (app.camStarting) return;
  app.camStarting = true;
  hideCamError();
  if (opts.deviceId) tracker.stopStream(); // release the current camera before opening another
  const streamPromise = tracker.requestCamera(opts); // user gesture still active here
  ensureAudio(); // creates/resumes the AudioContext in the same gesture
  ui.cam.disabled = true;
  ui.cam.setAttribute('aria-pressed', 'true');
  ui.mouse.setAttribute('aria-pressed', 'false');
  tracker.start(streamPromise, (m) => { ui.status.textContent = m; })
    .then((info) => {
      app.mode = 'camera';
      app.camInfo = info;
      document.body.classList.add('camera-on');
      renderDeviceSelects();
      const tried = info.attempts.length > 1 ? ` after ${info.attempts.length - 1} failed attempt${info.attempts.length > 2 ? 's' : ''}` : '';
      toast(`Camera on: ${info.device?.label || 'camera'}${tried}`);
      if (info.attempts.length > 1) console.info('[air-strings] camera attempts:', info.attempts.map((a) => `${a.label} @ ${a.res}: ${a.error || 'ok'}`).join(' | '));
      if (info.notes.length) console.info('[air-strings]', info.notes.join(' '));
    })
    .catch((err) => {
      tracker.stop();
      app.mode = 'mouse';
      app.camInfo = null;
      document.body.classList.remove('camera-on');
      ui.status.textContent = '';
      showCamError(err);
    })
    .finally(() => {
      app.camStarting = false;
      ui.cam.disabled = false;
      ui.cam.setAttribute('aria-pressed', String(app.mode === 'camera'));
      ui.mouse.setAttribute('aria-pressed', String(app.mode === 'mouse'));
      refreshHint();
    });
}
function renderDeviceSelects() {
  const devs = (tracker.devices || []).filter((d) => d.deviceId);
  const active = tracker.device?.deviceId || '';
  for (const sel of [ui.camSelect, ui.errSelect]) {
    sel.replaceChildren(...devs.map((d) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label;
      o.selected = d.deviceId === active;
      return o;
    }));
  }
  // the panel picker starts on a placeholder so choosing any camera fires 'change'
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = 'Choose a camera…'; ph.disabled = true; ph.selected = true;
  ui.errSelect.prepend(ph);
  ui.camSelectWrap.hidden = !devs.length;
  ui.errSelectWrap.hidden = !devs.length;
}
tracker.onDevices = () => renderDeviceSelects();
function onSelectDevice(e) {
  const id = e.target.value;
  if (!id) return;
  const d = tracker.devices.find((x) => x.deviceId === id);
  startCamera({ deviceId: id, label: d?.label || '' });
}
function useMouse() {
  hideCamError();
  tracker.stop();
  gestures.clearHands();
  app.mode = 'mouse';
  app.camInfo = null;
  document.body.classList.remove('camera-on');
  ui.status.textContent = '';
  ui.cam.setAttribute('aria-pressed', 'false');
  ui.mouse.setAttribute('aria-pressed', 'true');
  refreshHint();
}
tracker.onFatal = (err) => { useMouse(); showCamError(err); };
tracker.onDelegateChange = (d) => { if (app.camInfo) app.camInfo.delegate = d; toast(`Hand tracking switched to ${d}`); };

const ERROR_HINTS = {
  NotAllowedError: 'Camera access is blocked for this site. Click the camera icon in the address bar (or Site settings), set Camera to Allow, then press Retry. Also check the OS: Windows Settings › Privacy › Camera, or macOS System Settings › Privacy & Security › Camera.',
  SecurityError: 'The browser refused camera access for this page. It needs HTTPS and must not be inside a frame that blocks the camera.',
  NotFoundError: 'No camera was found. Plug one in or enable it, then press Retry.',
  NotReadableError: 'The camera is busy or blocked by the system. Close other apps that use it (Zoom, Teams, Meet, the Camera app), check Windows Settings › Privacy › Camera, then press Retry.',
  OverconstrainedError: 'The camera did not accept the requested settings, even with the plain fallback.',
  NotSupportedError: 'This browser does not support camera access. Try a current Chrome, Edge, Firefox or Safari.',
  TimeoutError: 'The camera opened but no frames arrived. Another app may be holding it, or a privacy shutter is closed.',
  AbortError: 'The camera failed to start. Press Retry, or restart the browser.',
};
function hintFor(err) {
  if (err.step?.startsWith('tracker')) return 'The hand tracker could not load or start. It downloads from cdn.jsdelivr.net and storage.googleapis.com, so check that an ad blocker or network filter is not blocking them, then press Retry.';
  if (err.step === 'tracking') return 'The hand tracker stopped working while running. Press Retry; if it keeps happening, your graphics driver may be the cause.';
  return ERROR_HINTS[err.errName] || 'Press Retry, or use the mouse instead.';
}
function showCamError(err) {
  const name = err?.errName || err?.name || 'Error';
  const msg = err?.message || String(err);
  const step = err?.step || 'camera';
  ui.errStep.textContent = step;
  ui.errMsg.textContent = `${name}: ${msg}`;
  const extra = [err?.firstError && `First attempt: ${err.firstError}`, err?.gpuError && `GPU attempt: ${err.gpuError}`].filter(Boolean).join(' · ');
  ui.errExtra.textContent = extra;
  ui.errExtra.hidden = !extra;
  const attempts = err?.attempts || [];
  const groups = [];
  for (const a of attempts) {
    let g = groups.find((x) => x.label === a.label && x.deviceId === a.deviceId);
    if (!g) groups.push((g = { label: a.label, deviceId: a.deviceId, tries: [] }));
    g.tries.push(a);
  }
  ui.errAttempts.replaceChildren(...groups.map((g) => {
    const li = document.createElement('li');
    const b = document.createElement('b'); b.textContent = g.label;
    li.append(b);
    for (const t of g.tries) {
      const d = document.createElement('div');
      d.textContent = `${t.res}: ${t.error || 'ok'}`;
      li.append(d);
    }
    return li;
  }));
  ui.errAttempts.hidden = !groups.length;
  let hint = hintFor({ ...err, errName: name, step });
  if (attempts.length && attempts.every((a) => (a.error || '').startsWith('NotReadableError'))) {
    hint = 'Another app or browser tab may be using the camera (Teams, Zoom, Camera app, Windows Hello). Close it and press Retry.';
  }
  ui.errHint.textContent = hint;
  renderDeviceSelects();
  ui.errPanel.hidden = false;
  console.info('[air-strings] camera start failed at step', step, `${name}: ${msg}`);
}
function hideCamError() { ui.errPanel.hidden = true; }
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
    ? 'Pinch with both hands in empty air, pull apart, and let go to make a string'
    : 'Click and drag to draw a string';
}
ui.cam.addEventListener('click', () => { if (app.mode !== 'camera') startCamera(); });
ui.mouse.addEventListener('click', () => { ensureAudio(); useMouse(); });
ui.errRetry.addEventListener('click', () => startCamera());
ui.errMouse.addEventListener('click', () => useMouse());
ui.camSelect.addEventListener('change', onSelectDevice);
ui.errSelect.addEventListener('change', onSelectDevice);
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
      const es = gestures.endState(s, end === s.a ? 'a' : 'b');
      const grabbed = es === 'move';
      const waiting = es === 'wait';
      const r = grabbed ? 9 : waiting ? 7.5 : 5.5;
      ctx.shadowBlur = 18;
      ctx.fillStyle = `hsla(${s.hue}, 100%, ${grabbed ? 85 : 70}%, 0.95)`;
      ctx.beginPath(); ctx.arc(end.x, end.y, r, 0, Math.PI * 2); ctx.fill();
      if (sel || grabbed || waiting) {
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
    const stretching = gestures.isMoving(s);
    ctx.fillText(stretching ? `${noteName(s.freq)} · ${Math.round(s.freq)} Hz` : noteName(s.freq), mx + nx * off, my + ny * off);
    ctx.globalCompositeOperation = 'lighter';
  }
  ctx.restore();
}

function drawPreview() {
  const segs = gestures.previews();
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

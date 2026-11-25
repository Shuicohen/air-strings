import { handFromLandmarks } from './gestures.js';

// Camera + MediaPipe HandLandmarker (both hands). Everything runs locally in the
// browser; frames never leave the device.

const TASKS_VERSION = '1.2.3';
const TASKS_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// MediaPipe's WASM prints this informational line through console.error when the CPU
// (XNNPACK) delegate starts. Re-route only that exact line to console.info.
{
  const origError = console.error.bind(console);
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('INFO: Created TensorFlow Lite XNNPACK delegate for CPU')) return console.info(...args);
    return origError(...args);
  };
}

const HI = { name: '1280×720', c: { width: { ideal: 1280 }, height: { ideal: 720 } } };
const LO = { name: '640×480', c: { width: { ideal: 640 }, height: { ideal: 480 } } };
const ANY = { name: 'any', c: {} };
const IR_RE = /\b(IR|infrared|hello)\b/i;
const STORE_KEY = 'airStrings.camera';
const deviceConstraints = (id, r) => ({ video: { deviceId: { exact: id }, ...r.c }, audio: false });
function loadRemembered() {
  try { const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); return v && v.deviceId ? v : null; } catch { return null; }
}
function saveRemembered(d) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ deviceId: d.deviceId, label: d.label })); } catch {}
}
export function rememberDevice(d) { saveRemembered(d); }

// Errors where retrying with plain {video:true} can help.
const FALLBACK_NAMES = new Set(['OverconstrainedError', 'ConstraintNotSatisfiedError', 'NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'TrackStartError', 'AbortError', 'TypeError']);

// An error tagged with the step that failed, shown in the on-screen panel.
export class CameraStepError extends Error {
  constructor(step, cause, extra = {}) {
    super(cause?.message || String(cause));
    this.step = step;
    this.errName = cause?.name || 'Error';
    this.cause = cause;
    Object.assign(this, extra);
  }
}

const timeout = (ms, label) => new Promise((_, rej) => setTimeout(() => {
  const e = new Error(`${label} timed out after ${ms / 1000}s`); e.name = 'TimeoutError'; rej(e);
}, ms));

export class HandTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.delegate = null;
    this.vision = null;
    this.stream = null;
    this.lastVideoTime = -1;
    this.lastTs = 0;
    this.hands = [];
    this.state = new Map();
    this.frameErrors = 0;
    this.notes = []; // non-fatal events, e.g. "GPU failed, using CPU"
    this.devices = [];
    this.device = null;
    this.attempts = [];
    this.onFatal = null;
  }

  // Step 1. Must be called synchronously from a click/change handler so the browser
  // still sees the user gesture (the first getUserMedia call happens before any await).
  // opts.deviceId: only try that device (dropdown switch). Resolves to the stream; the
  // chosen device and every attempt are kept on this.device / this.attempts.
  requestCamera(opts = {}) {
    this.attempts = [];
    this.device = null;
    const md = navigator.mediaDevices;
    if (!window.isSecureContext) {
      const e = new Error('This page is not on HTTPS (or localhost), so the browser hides the camera.'); e.name = 'SecurityError';
      return Promise.reject(new CameraStepError('camera', e));
    }
    if (!md || typeof md.getUserMedia !== 'function') {
      const e = new Error('navigator.mediaDevices.getUserMedia is not available in this browser.'); e.name = 'NotSupportedError';
      return Promise.reject(new CameraStepError('camera', e));
    }
    const remembered = loadRemembered();
    const only = opts.deviceId ? { deviceId: opts.deviceId, label: opts.label || '' } : null;
    const first = only || remembered;
    const firstPlan = first
      ? { device: first, res: HI, constraints: deviceConstraints(first.deviceId, HI) }
      : { device: { deviceId: '', label: 'Default camera (front-facing)' }, res: HI, constraints: { video: { facingMode: 'user', ...HI.c }, audio: false } };
    const firstTry = this.tryOne(firstPlan); // getUserMedia called synchronously in here
    return firstTry.catch(async (err) => {
      if (!FALLBACK_NAMES.has(err?.name)) throw this.fail(err);
      await this.refreshDevices();
      const plan = this.buildPlan(firstPlan, only, remembered);
      let lastErr = err;
      for (const step of plan) {
        try { return await this.tryOne(step); } catch (e) {
          lastErr = e;
          if (!FALLBACK_NAMES.has(e?.name)) throw this.fail(e);
        }
      }
      throw this.fail(lastErr);
    }).then(async (stream) => {
      await this.refreshDevices();
      const track = stream.getVideoTracks()[0];
      const sid = track?.getSettings?.().deviceId;
      const asked = this.device;
      // Prefer the device we explicitly asked for; otherwise identify it from the track.
      const match = (asked?.deviceId && this.devices.find((d) => d.deviceId === asked.deviceId))
        || (sid && this.devices.find((d) => d.deviceId === sid));
      this.device = match ? { deviceId: match.deviceId, label: match.label } : { deviceId: sid || '', label: track?.label || asked?.label || 'Camera' };
      if (this.device.deviceId) saveRemembered(this.device);
      return stream;
    });
  }

  // One getUserMedia attempt; records the outcome and stops any stream that came back unusable.
  tryOne(step) {
    const rec = { label: step.device.label || 'Camera', deviceId: step.device.deviceId, res: step.res.name, error: null };
    this.attempts.push(rec);
    let pr;
    try { pr = navigator.mediaDevices.getUserMedia(step.constraints); } catch (e) { pr = Promise.reject(e); }
    return pr.then((stream) => {
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') {
        stream.getTracks().forEach((t) => t.stop());
        const e = new Error('The camera returned no live video track'); e.name = 'NotReadableError';
        throw e;
      }
      rec.ok = true;
      this.device = step.device;
      return stream;
    }, (e) => { throw e; }).catch((e) => {
      if (!rec.ok) rec.error = `${e?.name || 'Error'}: ${e?.message || e}`;
      throw e;
    });
  }

  buildPlan(firstPlan, only, remembered) {
    const plan = [];
    const tried = (d, r) => firstPlan.device.deviceId === d.deviceId && firstPlan.res === r && !!d.deviceId;
    const add = (d) => { for (const r of [HI, LO]) if (!tried(d, r)) plan.push({ device: d, res: r, constraints: deviceConstraints(d.deviceId, r) }); };
    const withIds = this.devices.filter((d) => d.deviceId);
    if (only) {
      add(withIds.find((d) => d.deviceId === only.deviceId) || only);
      return plan;
    }
    const rem = remembered && (withIds.find((d) => d.deviceId === remembered.deviceId)
      || (remembered.label && withIds.find((d) => d.label === remembered.label)));
    const rest = withIds.filter((d) => d !== rem);
    const normal = rest.filter((d) => !IR_RE.test(d.label));
    const ir = rest.filter((d) => IR_RE.test(d.label));
    for (const d of [rem, ...normal].filter(Boolean)) add(d);
    for (const d of ir) add(d); // IR / Windows Hello cameras only once everything else failed
    if (!withIds.length) plan.push({ device: { deviceId: '', label: 'Any camera' }, res: ANY, constraints: { video: true, audio: false } });
    return plan;
  }

  async refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      let n = 0;
      this.devices = all.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label || `Camera ${++n}`, rawLabel: d.label }));
      n = 0;
      for (const d of this.devices) { n++; if (!d.rawLabel) d.label = `Camera ${n}`; }
    } catch {
      this.devices = this.devices || [];
    }
    this.onDevices?.(this.devices, this.device);
    return this.devices;
  }

  fail(err) {
    return new CameraStepError('camera', err, { attempts: this.attempts.slice(), devices: (this.devices || []).slice() });
  }

  stopStream() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.lastVideoTime = -1;
  }

  // Steps 2–4, after the stream promise from requestCamera().
  async start(streamPromise, onStatus) {
    this.notes = [];
    onStatus('Asking for camera…');
    const stream = await streamPromise;
    if (this.stream && this.stream !== stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;

    // Step 2: video playback
    onStatus('Starting video…');
    const v = this.video;
    try {
      v.muted = true; v.playsInline = true; v.autoplay = true;
      v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.setAttribute('autoplay', '');
      v.srcObject = this.stream;
      const ready = new Promise((res) => {
        if (v.readyState >= 2 && v.videoWidth > 0) return res();
        const check = () => { if (v.videoWidth > 0) { cleanup(); res(); } };
        const cleanup = () => { v.removeEventListener('loadeddata', check); v.removeEventListener('resize', check); clearInterval(iv); };
        v.addEventListener('loadeddata', check); v.addEventListener('resize', check);
        const iv = setInterval(check, 100);
      });
      await Promise.race([v.play(), timeout(10000, 'video.play()')]);
      await Promise.race([ready, timeout(10000, 'Waiting for the first camera frame')]);
    } catch (err) {
      throw new CameraStepError('video play', err);
    }

    // Steps 3/4: tracker, GPU first then CPU
    if (!this.landmarker) {
      onStatus('Loading hand tracker…');
      let FilesetResolver, HandLandmarker;
      try {
        ({ FilesetResolver, HandLandmarker } = await import(`${TASKS_URL}/vision_bundle.mjs`));
        this.vision = this.vision || await FilesetResolver.forVisionTasks(`${TASKS_URL}/wasm`);
      } catch (err) {
        throw new CameraStepError('tracker load', err);
      }
      this.HandLandmarker = HandLandmarker;
      const forceGpuFail = new URLSearchParams(location.search).get('gpu') === 'fail';
      try {
        if (forceGpuFail) { const e = new Error('GPU delegate disabled by ?gpu=fail (test switch)'); e.name = 'ForcedGpuFailure'; throw e; }
        await this.createLandmarker('GPU');
        this.warmup();
      } catch (gpuErr) {
        this.closeLandmarker();
        this.notes.push(`GPU tracker failed (${gpuErr?.name || 'Error'}: ${gpuErr?.message || gpuErr}); using CPU.`);
        console.info('[air-strings] GPU delegate unavailable, falling back to CPU:', gpuErr?.name, gpuErr?.message);
        try {
          onStatus('Loading hand tracker (CPU)…');
          await this.createLandmarker('CPU');
          this.warmup();
        } catch (cpuErr) {
          this.closeLandmarker();
          throw new CameraStepError('tracker load CPU', cpuErr, { gpuError: `${gpuErr?.name || 'Error'}: ${gpuErr?.message || gpuErr}` });
        }
      }
    }
    onStatus('');
    return { delegate: this.delegate, width: v.videoWidth, height: v.videoHeight, notes: this.notes, device: this.device, attempts: this.attempts };
  }

  async createLandmarker(delegate) {
    this.landmarker = await this.HandLandmarker.createFromOptions(this.vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    this.delegate = delegate;
  }

  // Run one real detection so a delegate that loads but cannot run fails here, not silently later.
  warmup() {
    this.landmarker.detectForVideo(this.video, this.nextTs());
  }

  closeLandmarker() {
    try { this.landmarker?.close(); } catch {}
    this.landmarker = null;
    this.delegate = null;
  }

  nextTs() {
    // detectForVideo needs strictly increasing timestamps (ms)
    const t = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = t;
    return t;
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.hands = [];
    this.state.clear();
    this.lastVideoTime = -1;
  }

  get active() { return !!this.stream && !!this.landmarker; }

  // map: (nx, ny) normalized video coords -> canvas px (already mirrored)
  update(map) {
    const v = this.video;
    if (!this.active || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return this.hands;
    if (v.currentTime === this.lastVideoTime) return this.hands;
    this.lastVideoTime = v.currentTime;
    let res;
    try {
      res = this.landmarker.detectForVideo(v, this.nextTs());
      this.frameErrors = 0;
    } catch (err) {
      this.frameErrors++;
      if (this.frameErrors === 5) this.recover(err);
      return this.hands;
    }
    const seen = new Set();
    const hands = [];
    (res.landmarks || []).forEach((lm, i) => {
      let id = res.handedness?.[i]?.[0]?.categoryName || `h${i}`;
      if (seen.has(id)) id = `${id}${i}`;
      seen.add(id);
      const h = handFromLandmarks(id, lm, map, this.state.get(id));
      this.state.set(id, h);
      hands.push(h);
    });
    for (const k of [...this.state.keys()]) if (!seen.has(k)) this.state.delete(k);
    this.hands = hands;
    return hands;
  }

  // Detection keeps throwing: switch GPU -> CPU once, otherwise report it.
  async recover(err) {
    if (this.delegate === 'GPU') {
      this.closeLandmarker();
      this.notes.push(`GPU tracking failed while running (${err?.name}: ${err?.message}); switched to CPU.`);
      try {
        await this.createLandmarker('CPU');
        this.frameErrors = 0;
        this.onDelegateChange?.(this.delegate);
        return;
      } catch (cpuErr) {
        err = cpuErr;
      }
    }
    this.onFatal?.(new CameraStepError('tracking', err));
  }
}

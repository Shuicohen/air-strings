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
    this.onFatal = null;
  }

  // Step 1. Must be called synchronously from the click handler so the browser
  // still sees the user gesture. Returns a promise for the stream.
  requestCamera() {
    const md = navigator.mediaDevices;
    if (!window.isSecureContext) {
      const e = new Error('This page is not on HTTPS (or localhost), so the browser hides the camera.'); e.name = 'SecurityError';
      return Promise.reject(new CameraStepError('camera', e));
    }
    if (!md || typeof md.getUserMedia !== 'function') {
      const e = new Error('navigator.mediaDevices.getUserMedia is not available in this browser.'); e.name = 'NotSupportedError';
      return Promise.reject(new CameraStepError('camera', e));
    }
    const preferred = { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    let first;
    try { first = md.getUserMedia(preferred); } catch (e) { first = Promise.reject(e); }
    return first.catch((err) => {
      if (!FALLBACK_NAMES.has(err?.name)) throw new CameraStepError('camera', err);
      this.notes.push(`Preferred camera settings failed (${err.name}); retried with any camera.`);
      return md.getUserMedia({ video: true, audio: false }).catch((err2) => {
        throw new CameraStepError('camera', err2, { firstError: `${err.name}: ${err.message}` });
      });
    });
  }

  // Steps 2–4, after the stream promise from requestCamera().
  async start(streamPromise, onStatus) {
    this.notes = [];
    onStatus('Asking for camera…');
    this.stream = await streamPromise;

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
    return { delegate: this.delegate, width: v.videoWidth, height: v.videoHeight, notes: this.notes };
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
      const pts = lm.map((p) => map(p.x, p.y));
      const prev = this.state.get(id);
      const smooth = (a, b, k) => (b ? { x: b.x + (a.x - b.x) * k, y: b.y + (a.y - b.y) * k } : a);
      const tip = smooth(pts[8], prev?.tip, 0.65);
      const thumb = smooth(pts[4], prev?.thumb, 0.65);
      const scale = Math.hypot(pts[0].x - pts[5].x, pts[0].y - pts[5].y) || 1;
      const ratio = Math.hypot(tip.x - thumb.x, tip.y - thumb.y) / scale;
      const wasPinch = prev?.pinch || false;
      const pinch = wasPinch ? ratio < 0.5 : ratio < 0.32; // hysteresis
      const h = { id, tip, thumb, pinch, pinchPt: { x: (tip.x + thumb.x) / 2, y: (tip.y + thumb.y) / 2 }, pts };
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

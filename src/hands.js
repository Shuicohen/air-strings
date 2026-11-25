// Camera + MediaPipe HandLandmarker (both hands). Everything runs locally in the
// browser; frames never leave the device.

const TASKS_VERSION = '1.2.3';
const TASKS_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class HandTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.stream = null;
    this.lastTime = -1;
    this.hands = []; // [{ id, tip, thumb, pinch, pinchPt, pts }]
    this.state = new Map();
  }

  async start(onStatus) {
    onStatus('Asking for camera…');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    if (!this.landmarker) {
      onStatus('Loading hand tracker…');
      const { FilesetResolver, HandLandmarker } = await import(`${TASKS_URL}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${TASKS_URL}/wasm`);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'));
      } catch {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
      }
    }
    onStatus('');
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.hands = [];
    this.state.clear();
  }

  get active() { return !!this.stream && !!this.landmarker; }

  // map: (nx, ny) normalized video coords -> canvas px (already mirrored)
  update(map) {
    const v = this.video;
    if (!this.active || v.readyState < 2) return this.hands;
    if (v.currentTime === this.lastTime) return this.hands;
    this.lastTime = v.currentTime;
    const res = this.landmarker.detectForVideo(v, performance.now());
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
}

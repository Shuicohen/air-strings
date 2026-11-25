// Web Audio engine. Preferred: one Karplus-Strong voice per string in an AudioWorklet
// (src/ks-worklet.js) so pitch glides while a string rings. Fallback (no AudioWorklet,
// addModule failure, or ?audio=fallback): each pluck renders a Karplus-Strong buffer in JS
// and plays it with an AudioBufferSourceNode; retuning bends playbackRate live.
//
// iOS/WebKit rules handled here:
//  - the context is created/resumed synchronously inside a tap handler (unlock()),
//  - a 1-sample silent buffer is played in that same handler,
//  - resume() is retried on later taps and when the page becomes visible ('suspended'
//    and iOS's 'interrupted' states),
//  - navigator.audioSession.type = 'playback' so the ring/silent switch doesn't mute it.

const WORKLET_URL = new URL('./ks-worklet.js', import.meta.url);
const FORCE_FALLBACK = typeof location !== 'undefined' && new URLSearchParams(location.search).get('audio') === 'fallback';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = null;
    this.analyser = null;
    this.engine = null; // 'worklet' | 'fallback'
    this.engineNote = '';
    this.onState = null;
  }

  // Call synchronously from a user-gesture handler (click, touchend, pointerup, keydown).
  unlock() {
    if (typeof window === 'undefined') return;
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
    } catch {}
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.ctx.onstatechange = () => this.onState?.(this.ctx.state);
      this.ready = this.setup().catch((err) => { this.engineNote = `audio setup failed: ${err?.name}: ${err?.message}`; });
    }
    const ctx = this.ctx;
    // 1-sample silent buffer, started inside the gesture, unlocks output on iOS
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = b; src.connect(ctx.destination); src.start(0);
    } catch {}
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    this.onState?.(ctx.state);
  }

  // Backwards-compatible: unlock + wait until the graph is built.
  async start() {
    this.unlock();
    if (this.ready) await this.ready;
  }

  async setup() {
    const ctx = this.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.25;
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx, 2.4);
    const wet = ctx.createGain(); wet.gain.value = 0.28;
    const dry = ctx.createGain(); dry.gain.value = 0.9;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.bus.connect(dry).connect(comp);
    this.bus.connect(verb).connect(wet).connect(comp);
    comp.connect(this.analyser).connect(ctx.destination);

    if (FORCE_FALLBACK) {
      this.engine = 'fallback'; this.engineNote = 'forced by ?audio=fallback';
    } else if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      this.engine = 'fallback'; this.engineNote = 'AudioWorklet not available';
    } else {
      try {
        await ctx.audioWorklet.addModule(WORKLET_URL.href);
        this.engine = 'worklet';
      } catch (err) {
        this.engine = 'fallback';
        this.engineNote = `worklet failed to load (${err?.name}: ${err?.message})`;
        console.info('[air-strings] AudioWorklet unavailable, using fallback engine:', this.engineNote);
      }
    }
    this.ok = true;
    this.onState?.(ctx.state);
  }

  // Retry after the first unlock: cheap, safe to call on every tap.
  poke() {
    if (!this.ctx) return this.unlock();
    if (this.ctx.state !== 'running') { this.ctx.resume().catch(() => {}); }
  }

  get state() { return this.ctx ? this.ctx.state : 'none'; }
  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  createVoice(freq) {
    if (!this.ctx || !this.ok) return null;
    return this.engine === 'worklet' ? this.workletVoice(freq) : this.bufferVoice(freq);
  }

  workletVoice(freq) {
    const node = new AudioWorkletNode(this.ctx, 'ks-string', { numberOfInputs: 0, outputChannelCount: [1] });
    const pan = this.ctx.createStereoPanner();
    const gain = this.ctx.createGain();
    gain.gain.value = 0.55;
    node.connect(gain).connect(pan).connect(this.bus);
    node.port.postMessage({ type: 'freq', value: freq, jump: true });
    return {
      setFreq(f) { node.port.postMessage({ type: 'freq', value: f }); },
      setPan(p) { pan.pan.value = Math.max(-1, Math.min(1, p)); },
      pluck(velocity) { node.port.postMessage({ type: 'pluck', velocity }); },
      dispose() {
        node.port.postMessage({ type: 'mute' });
        setTimeout(() => { try { node.disconnect(); gain.disconnect(); pan.disconnect(); } catch {} }, 60);
      },
    };
  }

  // Non-worklet Karplus-Strong: render each pluck into a buffer, bend pitch with playbackRate.
  bufferVoice(freq) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.55;
    let pan = null;
    if (ctx.createStereoPanner) { pan = ctx.createStereoPanner(); out.connect(pan).connect(this.bus); } else out.connect(this.bus);
    let cur = null; // { src, g, f0 }
    let target = freq;
    const v = {
      setFreq(f) {
        target = f;
        if (cur) cur.src.playbackRate.setTargetAtTime(f / cur.f0, ctx.currentTime, 0.03);
      },
      setPan(p) { if (pan) pan.pan.value = Math.max(-1, Math.min(1, p)); },
      pluck(velocity) {
        const now = ctx.currentTime;
        if (cur) { cur.g.gain.setTargetAtTime(0, now, 0.015); const old = cur.src; setTimeout(() => { try { old.stop(); } catch {} }, 150); }
        const buf = renderKS(ctx, target, velocity);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        src.connect(g).connect(out);
        src.start(now);
        cur = { src, g, f0: target };
        src.onended = () => { if (cur && cur.src === src) cur = null; };
      },
      dispose() {
        if (cur) { try { cur.g.gain.setTargetAtTime(0, ctx.currentTime, 0.02); cur.src.stop(ctx.currentTime + 0.1); } catch {} }
        setTimeout(() => { try { out.disconnect(); pan?.disconnect(); } catch {} }, 200);
      },
    };
    return v;
  }

  // Root-mean-square of the current output, used by the in-page audio check.
  rms() {
    if (!this.analyser) return 0;
    const a = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(a);
    let s = 0;
    for (const v of a) s += v * v;
    return Math.sqrt(s / a.length);
  }
}

// Same algorithm as ks-worklet.js, rendered offline for one pluck (about 3 s).
function renderKS(ctx, freq, velocity, seconds = 3) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);
  const N = Math.max(2, sr / freq - 0.5);
  const size = Math.ceil(N) + 4;
  const line = new Float32Array(size);
  const g = Math.pow(0.001, 1 / (freq * 4.5));
  const bright = 0.25 + 0.7 * velocity;
  let w = 0, lpEx = 0, lp = 0, excite = Math.max(8, Math.round(sr / freq));
  const read = (d) => {
    let p = w - d; while (p < 0) p += size;
    const i = Math.floor(p), f = p - i;
    const a = line[i % size], b = line[(i + 1) % size];
    return a + (b - a) * f;
  };
  for (let k = 0; k < n; k++) {
    let v = 0.5 * (read(N) + read(N + 1)) * g;
    if (excite > 0) { lpEx += ((Math.random() * 2 - 1) - lpEx) * bright; v += lpEx * velocity; excite--; }
    line[w] = v; w = (w + 1) % size;
    lp += (v - lp) * 0.9;
    out[k] = lp;
  }
  return buf;
}

function makeImpulse(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < 200 ? i / 200 : 1);
    }
  }
  return buf;
}

// ---- pitch helpers ----
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PENTA = [0, 2, 4, 7, 9]; // C major / A minor pentatonic pitch classes

export function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
export function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
export function snapPentatonic(f) {
  const m = freqToMidi(f);
  const base = Math.floor(m);
  let best = base, bestD = Infinity;
  for (let k = base - 3; k <= base + 3; k++) {
    if (!PENTA.includes(((k % 12) + 12) % 12)) continue;
    const d = Math.abs(k - m);
    if (d < bestD) { bestD = d; best = k; }
  }
  return midiToFreq(best);
}
export function noteName(f) {
  const m = Math.round(freqToMidi(f));
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

// Pitch for a string of length L px. ref = length that plays C4; shorter = higher.
export function freqForLength(L, ref, snap) {
  let f = 262 * (ref / Math.max(L, 20));
  f = Math.max(82, Math.min(1568, f));
  return snap ? snapPentatonic(f) : f;
}

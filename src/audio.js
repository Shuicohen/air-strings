// Web Audio engine: one Karplus-Strong voice per string, running in an AudioWorklet
// so the delay length (pitch) can glide while the string is still ringing.

const WORKLET_SRC = `
class KSString extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 8192;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.freq = 220;
    this.target = 220;
    this.exciteLeft = 0;
    this.exciteAmp = 0;
    this.exciteLp = 0;
    this.exciteBright = 0.5;
    this.lp = 0;
    this.energy = 0;
    this.t60 = 4.5;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'freq') { this.target = m.value; if (m.jump) this.freq = m.value; }
      else if (m.type === 'pluck') {
        const period = sampleRate / this.freq;
        this.exciteLeft = Math.max(8, Math.round(period));
        this.exciteAmp = m.velocity;
        this.exciteBright = 0.25 + 0.7 * m.velocity;
        this.energy = 1;
      } else if (m.type === 'mute') {
        this.buf.fill(0); this.energy = 0; this.exciteLeft = 0;
      }
    };
  }
  read(d) {
    let p = this.w - d;
    while (p < 0) p += this.size;
    const i = Math.floor(p);
    const f = p - i;
    const a = this.buf[i % this.size];
    const b = this.buf[(i + 1) % this.size];
    return a + (b - a) * f;
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (this.energy <= 0 && this.exciteLeft <= 0) { out.fill(0); return true; }
    const glide = 1 - Math.exp(-1 / (sampleRate * 0.03));
    let peak = 0;
    for (let n = 0; n < out.length; n++) {
      this.freq += (this.target - this.freq) * glide;
      const d = Math.min(this.size - 4, Math.max(2, sampleRate / this.freq - 0.5));
      const g = Math.pow(0.001, 1 / (this.freq * this.t60));
      const y0 = this.read(d);
      const y1 = this.read(d + 1);
      let v = 0.5 * (y0 + y1) * g;
      if (this.exciteLeft > 0) {
        const noise = Math.random() * 2 - 1;
        this.exciteLp += (noise - this.exciteLp) * this.exciteBright;
        v += this.exciteLp * this.exciteAmp;
        this.exciteLeft--;
      }
      this.buf[this.w] = v;
      this.w = (this.w + 1) % this.size;
      // gentle DC block / tone
      this.lp += (v - this.lp) * 0.9;
      out[n] = this.lp;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    if (peak < 1e-5 && this.exciteLeft <= 0) { this.energy = 0; this.buf.fill(0); }
    return true;
  }
}
registerProcessor('ks-string', KSString);
`;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = null;
    this.analyser = null;
  }

  // Must be called from a user gesture.
  async start() {
    if (this.ready) { await this.ready; if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    this.ready = (async () => {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.ctx = ctx;
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.ok = true;

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
      if (ctx.state !== 'running') await ctx.resume();
    })();
    await this.ready;
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  createVoice(freq) {
    if (!this.ctx || !this.ok) return null;
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

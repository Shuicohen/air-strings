// Karplus-Strong string voice (AudioWorklet). Loaded from its own file so Safari/iOS can
// fetch it as a normal same-origin module (served as JavaScript by GitHub Pages).
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

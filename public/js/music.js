// Soft generative background music made in the browser (Web Audio), so there is
// no audio file to host and no copyright to clear. Slow warm chords plus a few
// gentle bell notes from a pentatonic scale.

const CHORDS = [
  [48, 55, 59, 64], // Cmaj7
  [45, 52, 55, 60], // Am7
  [41, 48, 52, 57], // Fmaj7
  [43, 50, 55, 59], // G
];
const BELLS = [72, 74, 76, 79, 81, 84];
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class AmbientMusic {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.timer = null;
    this.step = 0;
  }

  // Call from a click/tap: browsers only allow audio after a user gesture.
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0;
        const lp = this.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 1800;
        this.verb = this.ctx.createConvolver();
        this.verb.buffer = this.impulse(3.2);
        const wet = this.ctx.createGain();
        wet.gain.value = 0.45;
        this.bus = this.ctx.createGain();
        this.bus.connect(lp);
        this.bus.connect(this.verb);
        this.verb.connect(wet);
        wet.connect(lp);
        lp.connect(this.master);
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return true;
    } catch {
      return false;
    }
  }

  get ready() {
    return !!this.ctx && this.ctx.state === "running";
  }

  impulse(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    return buf;
  }

  tone(freq, start, dur, gain, type = "sine", attack = 1.5) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gain, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g);
    g.connect(this.bus);
    o.start(start);
    o.stop(start + dur + 0.1);
  }

  bar() {
    const t = this.ctx.currentTime + 0.05;
    const chord = CHORDS[this.step % CHORDS.length];
    this.step++;
    chord.forEach((m, i) => {
      this.tone(hz(m), t + i * 0.05, 8.5, 0.05, "sine", 2.2);
      this.tone(hz(m) * 1.003, t + i * 0.05, 8.5, 0.025, "triangle", 2.6);
    });
    for (let k = 0; k < 3; k++) {
      if (Math.random() < 0.55) {
        const m = BELLS[Math.floor(Math.random() * BELLS.length)];
        this.tone(hz(m), t + 1 + k * 2 + Math.random() * 0.8, 3.2, 0.03, "sine", 0.02);
      }
    }
  }

  play() {
    if (!this.ctx || this.playing) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.playing = true;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0.9, now + 2);
    this.bar();
    this.timer = setInterval(() => this.bar(), 7000);
  }

  stop() {
    if (!this.ctx || !this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + 1.8);
  }
}

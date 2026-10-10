/**
 * Arena sound for the live rink, synthesized with the Web Audio API (no audio
 * files): goal horn, referee whistle, period buzzer, crowd that swells and
 * groans, body checks, shots, saves and the faceoff drop. Everything runs
 * through a short arena reverb.
 *
 * Browsers only allow sound after the user interacts with the page, so the
 * audio context is created (or resumed) on the first call after a click.
 */

const KEY = 'hgm.sound';

interface SoundPrefs {
  on: boolean;
  volume: number;
}

function loadPrefs(): SoundPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { on: true, volume: 0.6, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { on: true, volume: 0.6 };
}

class ArenaSound {
  prefs: SoundPrefs = loadPrefs();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private crowdGain: GainNode | null = null;
  private crowdSrc: AudioBufferSourceNode | null = null;
  private listeners = new Set<() => void>();

  /** Subscribe to preference changes (for the mute button). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(prefs: Partial<SoundPrefs>): void {
    this.prefs = { ...this.prefs, ...prefs };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.prefs));
    } catch {
      /* storage unavailable */
    }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.prefs.on ? this.prefs.volume : 0, this.ctx.currentTime, 0.05);
    if (!this.prefs.on) this.stopCrowd();
    this.listeners.forEach((f) => f());
  }

  /** Create or resume the audio graph (call from a user gesture or after one). */
  private ready(): AudioContext | null {
    if (!this.prefs.on || typeof window === 'undefined') return null;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AC();
      } catch {
        return null;
      }
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.prefs.volume;
      // A gentle limiter so the horn, the crowd and the reverb never clip together.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.knee.value = 8;
      comp.ratio.value = 6;
      this.master.connect(comp).connect(ctx.destination);
      this.dry = ctx.createGain();
      this.dry.connect(this.master);
      // Arena reverb: a decaying noise impulse.
      const conv = ctx.createConvolver();
      const len = Math.floor(ctx.sampleRate * 2.2);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
      conv.buffer = ir;
      this.wet = ctx.createGain();
      this.wet.gain.value = 0.28;
      conv.connect(this.wet);
      this.wet.connect(this.master);
      this.dry.connect(conv);
      // A couple of seconds of noise, reused for every noisy sound.
      const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const nd = nb.getChannelData(0);
      let b = 0;
      for (let i = 0; i < nd.length; i++) {
        // Slightly pink: smoother than white noise, more like a crowd.
        const w = Math.random() * 2 - 1;
        b = 0.97 * b + 0.03 * w;
        nd[i] = w * 0.5 + b * 3;
      }
      this.noise = nb;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Unlock audio from a click (browsers require a gesture). */
  unlock(): void {
    this.ready();
  }

  private noiseSource(ctx: AudioContext, loop = false): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = loop;
    src.loopStart = Math.random();
    return src;
  }

  private env(g: GainNode, t: number, peak: number, attack: number, hold: number, release: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.setValueAtTime(Math.max(0.0002, peak), t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  }

  // ── Crowd bed ──────────────────────────────────────────────────────────

  /** Start the low murmur of a full building (idempotent). */
  startCrowd(): void {
    const ctx = this.ready();
    if (!ctx || this.crowdSrc) return;
    const src = this.noiseSource(ctx, true);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 0.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.035;
    src.connect(bp).connect(lp).connect(this.crowdGain).connect(this.dry!);
    src.start();
    this.crowdSrc = src;
  }

  stopCrowd(): void {
    try {
      this.crowdSrc?.stop();
    } catch {
      /* already stopped */
    }
    this.crowdSrc = null;
    this.crowdGain = null;
  }

  /** The crowd gets louder for a moment (a big chance, a hit, a goal). */
  private swell(level: number, rise: number, decay: number, freq = 700): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = this.noiseSource(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(freq * 0.8, t);
    bp.frequency.linearRampToValueAtTime(freq, t + rise);
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    this.env(g, t, level, rise, decay * 0.25, decay);
    src.connect(bp).connect(g).connect(this.dry!);
    src.start(t);
    src.stop(t + rise + decay * 1.3 + 0.1);
  }

  // ── Events ─────────────────────────────────────────────────────────────

  /** The home goal horn, with the building erupting. */
  goalHorn(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    this.env(out, t, 0.32, 0.06, 2.6, 0.9);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.Q.value = 1.2;
    // A grinding low chord, like a ship's horn.
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    for (const f of [77.5, 155, 185, 232.5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 0.97, t);
      o.frequency.linearRampToValueAtTime(f, t + 0.15);
      const vib = ctx.createOscillator();
      vib.frequency.value = 5.5;
      const vg = ctx.createGain();
      vg.gain.value = f * 0.004;
      vib.connect(vg).connect(o.frequency);
      const og = ctx.createGain();
      og.gain.value = f < 100 ? 0.5 : 0.28;
      o.connect(og).connect(shaper);
      o.start(t);
      vib.start(t);
      o.stop(t + 3.8);
      vib.stop(t + 3.8);
    }
    shaper.connect(lp).connect(out).connect(this.dry!);
    this.swell(0.55, 0.25, 4.5, 800);
  }

  /** The visitors score: a groan through the building. */
  groan(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = this.noiseSource(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(520, t);
    bp.frequency.exponentialRampToValueAtTime(240, t + 1.4);
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    this.env(g, t, 0.32, 0.12, 0.3, 1.3);
    src.connect(bp).connect(g).connect(this.dry!);
    src.start(t);
    src.stop(t + 2);
  }

  /** The referee's pea whistle: a high trill. */
  whistle(long = false): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 3150;
    // The pea rattling inside: fast pitch and volume flutter.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 38;
    const fm = ctx.createGain();
    fm.gain.value = 120;
    lfo.connect(fm).connect(o.frequency);
    const am = ctx.createGain();
    am.gain.value = 0.35;
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.25;
    lfo.connect(amDepth).connect(am.gain);
    const g = ctx.createGain();
    const len = long ? 0.85 : 0.5;
    this.env(g, t, 0.16, 0.02, len, 0.12);
    o.connect(am).connect(g).connect(this.dry!);
    o.start(t);
    lfo.start(t);
    o.stop(t + len + 0.3);
    lfo.stop(t + len + 0.3);
  }

  /** The period-ending buzzer. */
  buzzer(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    this.env(g, t, 0.18, 0.01, 1.5, 0.15);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    for (const f of [196, 247]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(lp);
      o.start(t);
      o.stop(t + 1.8);
    }
    lp.connect(g).connect(this.dry!);
    this.swell(0.22, 0.3, 2, 600);
  }

  /** A body check into the boards: a low thud, the crowd reacting. */
  hit(big = false): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    const g = ctx.createGain();
    this.env(g, t, big ? 0.5 : 0.32, 0.005, 0.02, 0.2);
    o.connect(g).connect(this.dry!);
    o.start(t);
    o.stop(t + 0.3);
    // Boards rattle.
    const n = this.noiseSource(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 650;
    const ng = ctx.createGain();
    this.env(ng, t, 0.22, 0.003, 0.04, 0.25);
    n.connect(lp).connect(ng).connect(this.dry!);
    n.start(t);
    n.stop(t + 0.4);
    if (big) this.swell(0.18, 0.15, 1.2, 650);
  }

  /** A shot off the stick: a sharp crack (louder for a slap shot). */
  shot(slap = false): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = this.noiseSource(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = slap ? 1800 : 2600;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    this.env(g, t, slap ? 0.38 : 0.2, 0.002, 0.01, slap ? 0.09 : 0.05);
    n.connect(bp).connect(g).connect(this.dry!);
    n.start(t);
    n.stop(t + 0.2);
  }

  /** A save: puck into the pads, and an "ooh" on a big one. */
  save(big = false): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = this.noiseSource(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = ctx.createGain();
    this.env(g, t, 0.3, 0.003, 0.02, 0.12);
    n.connect(lp).connect(g).connect(this.dry!);
    n.start(t);
    n.stop(t + 0.25);
    if (big) this.swell(0.3, 0.35, 1.4, 750);
  }

  /** The puck drops: sticks clack. */
  faceoff(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const dt of [0, 0.07]) {
      const n = this.noiseSource(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.value = 1500;
      hp.Q.value = 2;
      const g = ctx.createGain();
      this.env(g, t + dt, 0.18, 0.002, 0.005, 0.04);
      n.connect(hp).connect(g).connect(this.dry!);
      n.start(t + dt);
      n.stop(t + dt + 0.1);
    }
  }

  /** A fight: the whole building on its feet. */
  fight(): void {
    this.swell(0.45, 0.6, 3.5, 750);
  }

  /** A dangerous chance or an odd-man rush: the crowd rises. */
  rise(level = 0.18): void {
    this.swell(level, 0.4, 1.2, 680);
  }
}

export const sfx = new ArenaSound();

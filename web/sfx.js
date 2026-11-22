// Weapon sound effects (FB3-W4c R-2, ruling R29 B). Presentation only and procedural: no fetched
// assets, no libraries. Every voice is routed into the Music master gain (music.gain), so the AU-9
// level table (setLevel) and setMute apply unchanged. Like ScoreVoice, nodes are created only when
// music.ready() (context unlocked and running, not muted, not quiet); the constructor creates no
// audio resource (AU-2) and Music.beat scheduling is not touched.
//
// Driven from the tick rows app.js already holds: a shot accepted at tick t (the sim's
// [t, 3, code, shots] event) is exactly a rise of state.fire_ready from the row before tick t to
// the row after it, and its weapon code is WEAPONS[row_before.weapon].code (1 laser, 2 rocket).

export const SFX_CODES = Object.freeze({laser: 1, rocket: 2});
const LASER = {gain: 0.3, attack: 0.004, length: 0.14, from: 1800, to: 240};
const ROCKET = {gain: 0.6, attack: 0.03, length: 0.5, cutoffFrom: 260, cutoffTo: 3400, q: 1.4, thump: 70};
const NOISE_SECONDS = 0.6;

// Deterministic white noise (xorshift32), so the whoosh needs no randomness source.
function fillNoise(data) {
  let s = 0x9E3779B9;
  for (let i = 0; i < data.length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    data[i] = s / 2147483648 - 1;
  }
}

export class Sfx {
  constructor(music) {
    this.music = music;
    this.noise = null;        // AudioBuffer, built lazily on the first rocket of a live context
    this.noiseContext = null;
  }
  // Called once per processed tick with the row before (prev) and after (curr) the tick.
  // Returns the weapon code fired on this tick (0 when none) after voicing it.
  tick(prev, curr, weaponCodes) {
    if (!prev || !curr) return 0;
    const fired = curr.fire_ready > prev.fire_ready;
    if (!fired) return 0;
    const code = weaponCodes?.[prev.weapon]?.code ?? SFX_CODES[prev.weapon] ?? 0;
    this.fire(code);
    return code;
  }
  // Voice one fire event by weapon code. Returns the number of sources started (0 when gated).
  fire(code) {
    if (!this.music.ready()) return 0;
    try {
      if (code === SFX_CODES.laser) return this.laser();
      if (code === SFX_CODES.rocket) return this.rocket();
    } catch (err) {
      // A missing node type (old engine, test double) silences the effect, never the run.
      console.warn('sfx unavailable:', err?.message ?? err);
    }
    return 0;
  }
  // Short descending zap: square oscillator, exponential pitch fall, fast attack envelope.
  laser() {
    const {context, gain} = this.music;
    const now = context.currentTime, end = now + LASER.length;
    const osc = context.createOscillator(), env = context.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(LASER.from, now);
    osc.frequency.exponentialRampToValueAtTime(LASER.to, end);
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(LASER.gain, now + LASER.attack);
    env.gain.exponentialRampToValueAtTime(0.001, end);
    osc.connect(env); env.connect(gain);
    osc.start(now); osc.stop(end + 0.02);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
    return 1;
  }
  // Noise-buffer whoosh through a low-pass whose cutoff rises, plus a short low sine thump.
  rocket() {
    const {context, gain} = this.music;
    if (typeof context.createBiquadFilter !== 'function') return 0;
    const now = context.currentTime, end = now + ROCKET.length;
    if (!this.noise || this.noiseContext !== context) {
      const length = Math.max(1, Math.round(context.sampleRate * NOISE_SECONDS));
      const buffer = context.createBuffer(1, length, context.sampleRate);
      fillNoise(buffer.getChannelData(0));
      this.noise = buffer; this.noiseContext = context;
    }
    const src = context.createBufferSource(), filter = context.createBiquadFilter(), env = context.createGain();
    src.buffer = this.noise;
    filter.type = 'lowpass';
    filter.Q.value = ROCKET.q;
    filter.frequency.setValueAtTime(ROCKET.cutoffFrom, now);
    filter.frequency.exponentialRampToValueAtTime(ROCKET.cutoffTo, now + ROCKET.length * 0.7);
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(ROCKET.gain, now + ROCKET.attack);
    env.gain.exponentialRampToValueAtTime(0.001, end);
    src.connect(filter); filter.connect(env); env.connect(gain);
    src.start(now); src.stop(end + 0.02);
    src.onended = () => { src.disconnect(); filter.disconnect(); env.disconnect(); };
    const thump = context.createOscillator(), tenv = context.createGain();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(ROCKET.thump * 2, now);
    thump.frequency.exponentialRampToValueAtTime(ROCKET.thump, now + 0.12);
    tenv.gain.setValueAtTime(0, now);
    tenv.gain.linearRampToValueAtTime(ROCKET.gain * 0.8, now + 0.01);
    tenv.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    thump.connect(tenv); tenv.connect(gain);
    thump.start(now); thump.stop(now + 0.2);
    thump.onended = () => { thump.disconnect(); tenv.disconnect(); };
    return 2;
  }
}

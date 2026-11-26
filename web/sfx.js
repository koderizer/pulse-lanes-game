// Weapon sound effects (FB3-W4c R-2, ruling R29 B). Presentation only and procedural: no fetched
// assets, no libraries. Every voice is routed into the Music master gain (music.gain), so the AU-9
// level table (setLevel) and setMute apply unchanged. Like ScoreVoice, nodes are created only when
// music.ready() (context unlocked and running, not muted, not quiet); the constructor creates no
// audio resource (AU-2) and Music.beat scheduling is not touched.
//
// Driven from the tick rows app.js already holds: a shot accepted at tick t (the sim's
// [t, 3, code, shots] event) is exactly a rise of state.fire_ready from the row before tick t to
// the row after it, and its weapon code is WEAPONS[row_before.weapon].code (1 laser, 2 rocket).

//
// Spec 26.4 (FB3-WEB4): app.js also hands this module the sim's destroying events
// [t, 6, id, code, pickup_kind, amount]; destroyed(kind) voices explode plus the energy ping of
// the dropped pickup. Same gate (music.ready()) and the same per-voice teardown as laser/rocket.
//
// Spec 26.4.3 (FB3-WEB18 R54): four more voices, same discipline, each gated by music.ready()
// AND a separate per-frame budget (frame()/grantNewVoice(), NEW_VOICE_FRAME_CAP) so a laggy
// render frame that replays several sim ticks can never machine-gun these four. fire()/destroyed()
// keep their own unlimited, exactly-1-per-event behavior (frozen by song_probe S-2/S-4): the cap
// is scoped to the newly added voices only, never to the pre-existing weapon/pickup cues.
//   hop(dir):        lane change accepted, [t, 1, lane, lane+-1] (app.js: curr.lane !== prev.lane).
//   boost():         boost accepted; the sim emits no success event (only [t, 6, 1] on refusal), so
//                    the observable is state's boost_until rising (app.js already used this to
//                    count runBoosts; R54 reuses the exact same edge).
//   wallCrash():     the ship pinned against the tunnel's circular travel-radius clamp (doMove in
//                    both sim modules: vx/vy are forced to 0 when the next position would leave the
//                    travel radius). Neither sim exports that radius or a dedicated event, so the
//                    honest observable app.js reads from the state/input rows it already holds is:
//                    held lateral stick input (sx/sy != 0) while velocity reads [0, 0] this tick.
//                    Debounced by app.js to one voice per continuous contact.
//   gameOverBoom():  the terminal collision frame, voiced BEFORE music.quiet() silences the run.

export const SFX_CODES = Object.freeze({laser: 1, rocket: 2});
// R54: voices from hop/boost/wallCrash/gameOverBoom share one per-frame budget so a frame that
// replays several ticks (lag catch-up) cannot machine-gun them. app.js calls frame() once per
// rendered animation frame, before any tick runs. fire()/destroyed() are NOT metered by this.
const NEW_VOICE_FRAME_CAP = 4;
// Energy ping pitch per pickup tier (spec 26.4.1, R46 B-2): minerals rise small -> normal -> large
// as root, major third and fifth (0 / 386 / 702 cents); the gem is a distinct two-tone figure that
// starts an octave above the root (above mineral_large) and rises a fourth (2, then 2.6667).
export const ENERGY_TIERS = Object.freeze({mineral_small: 1, mineral_normal: 1.25, mineral_large: 1.5});
export const GEM_TONES = Object.freeze([2, 2.6667]);
// Pickup tier of a destroying event's numeric pickup tuple (NOTE 27: kind 1 mineral / 2 gem, plus
// an amount): 2 -> gem; 1 -> mineral_large (amount >= 50), mineral_normal (>= 25) or
// mineral_small; any other kind -> null (an unknown pickup voices the explosion only).
export function tierOf(kind, amount) {
  if (kind === 2) return 'gem';
  if (kind !== 1) return null;
  return amount >= 50 ? 'mineral_large' : amount >= 25 ? 'mineral_normal' : 'mineral_small';
}
const LASER = {gain: 0.3, attack: 0.004, length: 0.14, from: 1800, to: 240};
const ROCKET = {gain: 0.6, attack: 0.03, length: 0.5, cutoffFrom: 260, cutoffTo: 3400, q: 1.4, thump: 70};
const EXPLODE = {gain: 0.55, attack: 0.004, length: 0.42, cutoffFrom: 2400, cutoffTo: 140, q: 0.8, thump: 52};
const ENERGY = {gain: 0.2, attack: 0.003, length: 0.16, base: 1320, gap: 0.075};
// R54 B-1: a 60ms direction-pitched blip. 'left' reads as the UP tone, 'right' as the DOWN tone
// (an arbitrary, presentation-only mapping of the app's own hop direction strings; see takeHop()).
const HOP = {gain: 0.18, attack: 0.003, length: 0.06, up: 520, down: 390, glide: 1.08};
// R54 B-2 / R55.3: rising sweep (saw) plus a noise whoosh through a rising-cutoff lowpass, and a
// fading noise tail on top (see BOOST).
// R55.3 (owner feedback: "too short, needs a longer whoosh for better feel"): the sweep grew from
// 0.25s to a 0.6s gentler rise and a dedicated fading noise tail (0.3s, lowpass closing 2600->400
// Hz) layers on top, so the voice reads as a ~0.9s whoosh. Gain stays at the R54 ceiling 0.35.
export const BOOST = {gain: 0.35, attack: 0.02, length: 0.6, from: 200, to: 900, cutoffFrom: 900, cutoffTo: 3200, q: 1.1, tail: 0.3, tailGain: 0.16};
// R54 B-3: a dull 180ms thud, deliberately softer/lower than EXPLODE (cutoff ceiling 700 vs 2400,
// gain 0.4 vs 0.55) so a wall contact never reads as an asteroid kill.
const WALL = {gain: 0.4, attack: 0.006, length: 0.18, from: 90, to: 45, cutoffFrom: 700, cutoffTo: 160, q: 0.7};
// R54 B-4: the biggest sound in the game - a long (900ms) EXPLODE variant: lower sub thump
// (~70 -> 36 Hz vs EXPLODE's 104 -> 52 Hz), a longer noise tail and a higher ceiling gain (0.55,
// the EXPLODE ceiling itself) so it is clearly distinct from, and bigger than, an asteroid kill.
const GAMEOVER = {gain: 0.55, length: 0.9, cutoffFrom: 2600, cutoffTo: 90, q: 0.7, thumpFrom: 70, thumpTo: 36};
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
    this.newVoiceBudget = NEW_VOICE_FRAME_CAP; // R54: hop/boost/wallCrash/gameOverBoom only
  }
  // R54: call once per rendered animation frame, before any tick of that frame runs (app.js's
  // frame(), second statement). Refills the shared budget for the four new voices.
  frame() {
    this.newVoiceBudget = NEW_VOICE_FRAME_CAP;
  }
  // True (and consumes one slot) iff a new-voice call may proceed this frame. The 5th+ such call
  // in one frame is dropped (returns false): no node is created, nothing queued for later.
  grantNewVoice() {
    if (this.newVoiceBudget <= 0) return false;
    this.newVoiceBudget--;
    return true;
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
  // One rock destroyed (spec 26.4.1): explosion plus the energy ping of its pickup tier. Returns
  // the number of sources started (0 when gated). An unknown or missing kind voices explode only.
  destroyed(kind) {
    if (!this.music.ready()) return 0;
    let started = 0;
    try {
      const {context} = this.music;
      started += this.explode(context);
      if (kind !== undefined && kind !== null) started += this.energy(context, kind);
    } catch (err) {
      console.warn('sfx unavailable:', err?.message ?? err);
    }
    return started;
  }
  // The noise buffer, built lazily once per context (shared by the rocket whoosh and explode).
  noiseFor(context) {
    if (!this.noise || this.noiseContext !== context) {
      const length = Math.max(1, Math.round(context.sampleRate * NOISE_SECONDS));
      const buffer = context.createBuffer(1, length, context.sampleRate);
      fillNoise(buffer.getChannelData(0));
      this.noise = buffer; this.noiseContext = context;
    }
    return this.noise;
  }
  // Explosion: noise burst through a low-pass whose cutoff falls, plus a short low sine thump.
  explode(context) {
    const {gain} = this.music;
    if (typeof context.createBiquadFilter !== 'function') return 0;
    const now = context.currentTime, end = now + EXPLODE.length;
    const src = context.createBufferSource(), filter = context.createBiquadFilter(), env = context.createGain();
    src.buffer = this.noiseFor(context);
    filter.type = 'lowpass';
    filter.Q.value = EXPLODE.q;
    filter.frequency.setValueAtTime(EXPLODE.cutoffFrom, now);
    filter.frequency.exponentialRampToValueAtTime(EXPLODE.cutoffTo, end);
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(EXPLODE.gain, now + EXPLODE.attack);
    env.gain.exponentialRampToValueAtTime(0.001, end);
    src.connect(filter); filter.connect(env); env.connect(gain);
    src.start(now); src.stop(end + 0.02);
    src.onended = () => { src.disconnect(); filter.disconnect(); env.disconnect(); };
    const thump = context.createOscillator(), tenv = context.createGain();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(EXPLODE.thump * 2, now);
    thump.frequency.exponentialRampToValueAtTime(EXPLODE.thump, now + 0.16);
    tenv.gain.setValueAtTime(0, now);
    tenv.gain.linearRampToValueAtTime(EXPLODE.gain, now + 0.008);
    tenv.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    thump.connect(tenv); tenv.connect(gain);
    thump.start(now); thump.stop(now + 0.28);
    thump.onended = () => { thump.disconnect(); tenv.disconnect(); };
    return 2;
  }
  // Energy: bright short triangle ping, base pitch x ENERGY_TIERS[tier]; a gem plays two pings, an
  // octave above the root and then a rising fourth higher (GEM_TONES). Returns the number of pings started (0 for an unknown tier).
  energy(context, tier) {
    const tones = tier === 'gem' ? GEM_TONES : ENERGY_TIERS[tier] ? [ENERGY_TIERS[tier]] : [];
    const now = context.currentTime;
    tones.forEach((k, i) => this.ping(context, ENERGY.base * k, now + i * ENERGY.gap));
    return tones.length;
  }
  ping(context, frequency, at) {
    const {gain} = this.music;
    const end = at + ENERGY.length;
    const osc = context.createOscillator(), env = context.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(frequency, at);
    osc.frequency.exponentialRampToValueAtTime(frequency * 1.06, at + 0.03);
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(ENERGY.gain, at + ENERGY.attack);
    env.gain.exponentialRampToValueAtTime(0.001, end);
    osc.connect(env); env.connect(gain);
    osc.start(at); osc.stop(end + 0.02);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
  }
  // Noise-buffer whoosh through a low-pass whose cutoff rises, plus a short low sine thump.
  rocket() {
    const {context, gain} = this.music;
    if (typeof context.createBiquadFilter !== 'function') return 0;
    const now = context.currentTime, end = now + ROCKET.length;
    const src = context.createBufferSource(), filter = context.createBiquadFilter(), env = context.createGain();
    src.buffer = this.noiseFor(context);
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
  // R54 B-1: lane hop accepted (app.js: curr.lane !== prev.lane after an attempted hop). A short
  // square blip with a tiny upward glide; pitch alone carries direction (no stereo panning).
  // dir: the app's own hop direction string ('left' reads UP, 'right' reads DOWN).
  hop(dir) {
    if (!this.music.ready()) return 0;
    if (!this.grantNewVoice()) return 0;
    try {
      const {context, gain} = this.music;
      const now = context.currentTime, end = now + HOP.length;
      const base = dir === 'left' ? HOP.up : HOP.down;
      const osc = context.createOscillator(), env = context.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(base, now);
      osc.frequency.exponentialRampToValueAtTime(base * HOP.glide, end);
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(HOP.gain, now + HOP.attack);
      env.gain.exponentialRampToValueAtTime(0.001, end);
      osc.connect(env); env.connect(gain);
      osc.start(now); osc.stop(end + 0.02);
      osc.onended = () => { osc.disconnect(); env.disconnect(); };
      return 1;
    } catch (err) {
      console.warn('sfx unavailable:', err?.message ?? err);
    }
    return 0;
  }
  // R54 B-2: boost accepted (app.js: curr.boost_until > prev.boost_until, the same state-row edge
  // the run's runBoosts counter already uses). Rising sawtooth sweep plus a noise whoosh.
  boost() {
    if (!this.music.ready()) return 0;
    if (!this.grantNewVoice()) return 0;
    try {
      const {context, gain} = this.music;
      const now = context.currentTime, end = now + BOOST.length;
      const osc = context.createOscillator(), env = context.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(BOOST.from, now);
      osc.frequency.exponentialRampToValueAtTime(BOOST.to, end);
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(BOOST.gain, now + BOOST.attack);
      env.gain.exponentialRampToValueAtTime(0.001, end);
      osc.connect(env); env.connect(gain);
      osc.start(now); osc.stop(end + 0.02);
      osc.onended = () => { osc.disconnect(); env.disconnect(); };
      let started = 1;
      if (typeof context.createBiquadFilter === 'function') {
        const src = context.createBufferSource(), filter = context.createBiquadFilter(), nenv = context.createGain();
        src.buffer = this.noiseFor(context);
        filter.type = 'lowpass';
        filter.Q.value = BOOST.q;
        filter.frequency.setValueAtTime(BOOST.cutoffFrom, now);
        filter.frequency.exponentialRampToValueAtTime(BOOST.cutoffTo, end);
        nenv.gain.setValueAtTime(0, now);
        nenv.gain.linearRampToValueAtTime(BOOST.gain * 0.5, now + 0.02);
        nenv.gain.exponentialRampToValueAtTime(0.001, end);
        src.connect(filter); filter.connect(nenv); nenv.connect(gain);
        src.start(now); src.stop(end + 0.02);
        src.onended = () => { src.disconnect(); filter.disconnect(); nenv.disconnect(); };
        started++;
      }
      // R55.3: the whoosh tail - a second noise voice starting late, lowpass closing down, fading
      // out over BOOST.tail. Same discipline: routed through music.gain, self-disconnecting.
      if (typeof context.createBufferSource === 'function' && typeof context.createBiquadFilter === 'function') {
        const tailStart = end - BOOST.length * 0.2, tailEnd = end + BOOST.tail;
        const tsrc = context.createBufferSource(), tf = context.createBiquadFilter(), tenv = context.createGain();
        tsrc.buffer = this.noiseFor(context);
        tf.type = 'lowpass';
        tf.frequency.setValueAtTime(2600, tailStart);
        tf.frequency.exponentialRampToValueAtTime(400, tailEnd);
        tenv.gain.setValueAtTime(BOOST.tailGain, tailStart);
        tenv.gain.exponentialRampToValueAtTime(0.001, tailEnd);
        tsrc.connect(tf); tf.connect(tenv); tenv.connect(gain);
        tsrc.start(tailStart); tsrc.stop(tailEnd + 0.02);
        tsrc.onended = () => { tsrc.disconnect(); tf.disconnect(); tenv.disconnect(); };
        started++;
      }
      return started;
    } catch (err) {
      console.warn('sfx unavailable:', err?.message ?? err);
    }
    return 0;
  }
  // R54 B-3: the ship held against the tunnel's circular travel-radius clamp (see the module
  // header for the observable). A dull thud, deliberately softer than EXPLODE.
  wallCrash() {
    if (!this.music.ready()) return 0;
    if (!this.grantNewVoice()) return 0;
    try {
      const {context, gain} = this.music;
      const now = context.currentTime, end = now + WALL.length;
      const osc = context.createOscillator(), env = context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(WALL.from, now);
      osc.frequency.exponentialRampToValueAtTime(WALL.to, end);
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(WALL.gain, now + WALL.attack);
      env.gain.exponentialRampToValueAtTime(0.001, end);
      osc.connect(env); env.connect(gain);
      osc.start(now); osc.stop(end + 0.02);
      osc.onended = () => { osc.disconnect(); env.disconnect(); };
      let started = 1;
      if (typeof context.createBiquadFilter === 'function') {
        const src = context.createBufferSource(), filter = context.createBiquadFilter(), nenv = context.createGain();
        src.buffer = this.noiseFor(context);
        filter.type = 'lowpass';
        filter.Q.value = WALL.q;
        filter.frequency.setValueAtTime(WALL.cutoffFrom, now);
        filter.frequency.exponentialRampToValueAtTime(WALL.cutoffTo, now + WALL.length * 0.6);
        nenv.gain.setValueAtTime(0, now);
        nenv.gain.linearRampToValueAtTime(WALL.gain * 0.6, now + 0.008);
        nenv.gain.exponentialRampToValueAtTime(0.001, now + WALL.length * 0.8);
        src.connect(filter); filter.connect(nenv); nenv.connect(gain);
        src.start(now); src.stop(now + WALL.length);
        src.onended = () => { src.disconnect(); filter.disconnect(); nenv.disconnect(); };
        started++;
      }
      return started;
    } catch (err) {
      console.warn('sfx unavailable:', err?.message ?? err);
    }
    return 0;
  }
  // R54 B-4: the terminal collision frame. A long EXPLODE variant; app.js voices this BEFORE
  // stopRun()'s music.quiet() silences the run, so the gate is still open for it.
  gameOverBoom() {
    if (!this.music.ready()) return 0;
    if (!this.grantNewVoice()) return 0;
    try {
      const {context, gain} = this.music;
      const now = context.currentTime, end = now + GAMEOVER.length;
      let started = 0;
      if (typeof context.createBiquadFilter === 'function') {
        const src = context.createBufferSource(), filter = context.createBiquadFilter(), env = context.createGain();
        src.buffer = this.noiseFor(context);
        filter.type = 'lowpass';
        filter.Q.value = GAMEOVER.q;
        filter.frequency.setValueAtTime(GAMEOVER.cutoffFrom, now);
        filter.frequency.exponentialRampToValueAtTime(GAMEOVER.cutoffTo, end);
        env.gain.setValueAtTime(0, now);
        env.gain.linearRampToValueAtTime(GAMEOVER.gain, now + 0.01);
        env.gain.exponentialRampToValueAtTime(0.001, end);
        src.connect(filter); filter.connect(env); env.connect(gain);
        src.start(now); src.stop(end + 0.02);
        src.onended = () => { src.disconnect(); filter.disconnect(); env.disconnect(); };
        started++;
      }
      const thump = context.createOscillator(), tenv = context.createGain();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(GAMEOVER.thumpFrom, now);
      thump.frequency.exponentialRampToValueAtTime(GAMEOVER.thumpTo, now + 0.5);
      tenv.gain.setValueAtTime(0, now);
      tenv.gain.linearRampToValueAtTime(GAMEOVER.gain, now + 0.012);
      tenv.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
      thump.connect(tenv); tenv.connect(gain);
      thump.start(now); thump.stop(now + 0.85);
      thump.onended = () => { thump.disconnect(); tenv.disconnect(); };
      started++;
      return started;
    } catch (err) {
      console.warn('sfx unavailable:', err?.message ?? err);
    }
    return 0;
  }
}

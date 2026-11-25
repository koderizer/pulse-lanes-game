// AU-9: master gain per music level 0 .. 10; LEVEL_GAIN[10] = 0.16 keeps AU-7 intact at the default.
export const LEVEL_GAIN = Object.freeze([0, 0.016, 0.032, 0.048, 0.064, 0.08, 0.096, 0.112, 0.128, 0.144, 0.16]);

export class Music {
  constructor() {
    this.context = null;
    this.muted = false;
    this.level = 10;
    this.lastBeat = -1;
    this.latestTick = null;
    this.pendingTick = null;
    this.unlockError = null;
    this.attempt = null;
    this.unlocked = false;
    this.quietMode = false;
    this.suspensions = new Set();
    this.gestureResumeIssued = false;
  }
  gesture() {
    this.gestureResumeIssued = false;
    this.quietMode = false;
    if (!this.context) {
      const Audio = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!Audio) return;
      // Spec 26.4.2 (R38.7, FB3-REV4 B-2): a throwing AudioContext constructor is a silent
      // no-op, not a fatal error. Build fully or not at all, so a later gesture can retry.
      try {
        const ctx = new Audio();
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        this.context = ctx;
        this.gain = gain;
        this.setMute(this.muted);
        ctx.addEventListener('statechange', () => this.onStateChange());
      } catch {
        this.context = null;
        this.gain = null;
        return;
      }
    }
    if (this.attempt) {
      // AU-2 (R47): coalesce the silent-buffer source, but every gesture while not running still
      // calls resume() in the caller's stack (mobile autoplay ignores deferred resume).
      if (this.context.state !== 'running') this.syncResume();
      if (!this.attempt.fresh) this.kick(this.attempt);
      return;
    }
    if (this.unlocked && this.context.state === 'running' && !this.suspensions.size) {
      this.drain();
      return;
    }
    this.unlock();
  }
  unlock() {
    const attempt = {fresh: false, open: 0, error: null};
    this.attempt = attempt;
    this.unlocked = false;
    this.unlockError = null;
    this.kick(attempt);
  }
  // One resume plus silent buffer for `attempt`, both in the caller's stack. An attempt may hold
  // several kicks: the first kick that fulfills completes it; a failed kick completes it only
  // when no other kick of the same attempt is still open.
  syncResume() {
    this.gestureResumeIssued = true;
    try {
      Promise.resolve(this.context.resume()).then(() => this.drain(), () => this.drain());
    } catch { /* AU-3: a throw is handled on the primary kick attempt */ }
  }
  kick(attempt) {
    attempt.fresh = true;
    queueMicrotask(() => { attempt.fresh = false; });
    let resume, error = null;
    try {
      resume = this.context.resume();
      this.gestureResumeIssued = true;
    } catch (thrown) {
      error = String(thrown?.message ?? thrown);
    }
    // Both operations belong to the gesture stack, even if resume throws.
    try {
      const buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
      buffer.getChannelData(0).fill(0);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      source.onended = () => source.disconnect();
      source.start(0);
    } catch (thrown) {
      error = error ?? String(thrown?.message ?? thrown);
    }
    // R48: record the error on the attempt NOW - an AU-3 running-observation completion can land
    // before this kick's settle microtask, and must still see and expose it (never fake success).
    if (error !== null) attempt.error = error;
    attempt.open++;
    Promise.resolve(resume).then(
      () => this.settleKick(attempt, error),
      thrown => this.settleKick(attempt, error ?? String(thrown?.message ?? thrown)),
    );
  }
  settleKick(attempt, error) {
    attempt.open--;
    if (error !== null) {
      attempt.error = attempt.error ?? error;
      if (attempt.open > 0) return;
    }
    this.finishUnlock(attempt, error === null ? null : attempt.error);
  }
  finishUnlock(attempt, error) {
    // Canceled attempts cannot change the current run's success/error state.
    if (this.attempt !== attempt) return;
    this.attempt = null;
    this.unlockError = error;
    this.unlocked = error === null;
    this.drain();
  }
  onStateChange() {
    // R48.3 (AU-3 amendment, AU-11): a running observation completes the open attempt. A clean
    // attempt completes as successful (unlocked true); a recorded error is still exposed and the
    // AU-3 retry path stays available (one further gesture self-heals a running context).
    if (this.context && this.context.state === 'running' && this.attempt) {
      this.finishUnlock(this.attempt, this.attempt.error);
    }
    this.drain();
  }
  setMute(muted) {
    this.muted = muted;
    this.applyGain();
    if (muted) this.pendingTick = null;
  }
  // Presentation only. Remembered before the context exists; never creates audio nodes.
  setLevel(level) {
    if (!Number.isInteger(level) || level < 0 || level > 10) throw new RangeError('music level must be an integer 0 .. 10');
    this.level = level;
    this.applyGain();
  }
  applyGain() {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : LEVEL_GAIN[this.level];
  }
  // True when a voice may create oscillators now (same gate drain() applies to the beat).
  ready() {
    return Boolean(this.context && this.gain) && !this.muted && !this.quietMode && !this.suspensions.size &&
      !this.attempt && this.unlocked && this.context.state === 'running';
  }
  period(tick) {
    return [40,30,24][Math.min(2, Math.floor(tick / 2400))];
  }
  beat(tick) {
    this.latestTick = tick;
    if (this.pendingTick !== null && tick >= this.pendingTick + this.period(this.pendingTick)) {
      this.pendingTick = null;
    }
    if (this.muted || this.quietMode) return;
    if (tick % this.period(tick) === 0 && tick !== this.lastBeat) this.pendingTick = tick;
    this.drain();
  }
  drain() {
    if (this.pendingTick === null || this.muted || this.quietMode || this.suspensions.size ||
        this.attempt || !this.unlocked || this.context?.state !== 'running') return;
    const tick = this.pendingTick;
    if (this.latestTick < tick || this.latestTick >= tick + this.period(tick)) return;
    const index = Math.floor(tick / this.period(tick)) % 8;
    const now = this.context.currentTime;
    for (const frequency of [[220,261.63,329.63,293.66,220,329.63,392,293.66][index], 110]) {
      const oscillator = this.context.createOscillator(), envelope = this.context.createGain();
      oscillator.type = frequency === 110 ? 'sine' : 'triangle';
      oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(0.45, now + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      oscillator.connect(envelope); envelope.connect(this.gain);
      oscillator.start(now); oscillator.stop(now + 0.24);
      oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    }
    this.lastBeat = tick;
    this.pendingTick = null;
  }
  quiet() {
    this.quietMode = true;
    this.pendingTick = null;
    this.attempt = null;
    this.unlocked = false;
    if (!this.context) return;
    const suspension = {};
    this.suspensions.add(suspension);
    const settled = () => {
      this.suspensions.delete(suspension);
      if (this.quietMode || this.suspensions.size) return;
      // A recovery gesture may have resumed before suspend took effect, so a post-suspension
      // resume is always issued. It joins the live gesture attempt instead of superseding it:
      // this callback runs outside any trusted gesture, so on mobile its own resume may never
      // settle, while the gesture's resume (queued after the suspend) still reaches running.
      if (this.attempt) this.kick(this.attempt);
      else this.unlock();
    };
    try {
      Promise.resolve(this.context.suspend()).then(settled, settled);
    } catch {
      settled();
    }
  }
  reset() {
    this.quiet();
    this.latestTick = null;
    this.lastBeat = -1;
  }
  inspect() {
    return {
      contextState: this.context?.state ?? null,
      muted: this.muted,
      unlockPending: this.attempt !== null,
      pendingTick: this.pendingTick,
      lastBeat: this.lastBeat,
      unlockError: this.unlockError,
    };
  }
}

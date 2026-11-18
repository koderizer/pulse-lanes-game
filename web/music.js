export class Music {
  constructor() { this.context = null; this.muted = false; this.lastBeat = -1; }
  gesture() {
    if (!this.context) {
      const Audio = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!Audio) return;
      this.context = new Audio();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.setMute(this.muted);
    }
    this.context.resume().catch(() => {});
  }
  setMute(muted) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 0.16;
  }
  beat(tick) {
    if (!this.context || this.context.state !== 'running') return;
    const stage = Math.min(2, Math.floor(tick / 2400)), period = [40,30,24][stage];
    if (tick % period || tick === this.lastBeat) return;
    this.lastBeat = tick;
    const index = Math.floor(tick / period) % 8;
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
  }
  quiet() { if (this.context?.state === 'running') this.context.suspend().catch(() => {}); }
}

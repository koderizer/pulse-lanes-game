// Score voice (spec section 13, presentation only). Plays the notes of the ship's
// current lane as oscillators through the Music master gain. Driven by the processed
// tick exactly like Music.beat(): it never schedules ahead of the sim, never calls
// step/abandon, and creates no audio node before Music.gesture() has unlocked the context.

const TICKS_PER_SECOND = 60;
const NOTE_GAIN = 0.22;
const ATTACK_S = 0.01;

export const midiFrequency = pitch => 440 * 2 ** ((pitch - 69) / 12);

// onset tick -> [pitch, durationSeconds] for every note of one lane of one loop (spec 5.1 expansion).
export function laneNotes(loop, lane, loopStartTick) {
  const out = new Map();
  const beatTicks = 3600 / loop.bpm;
  for (let rep = 0; rep * 4 * lane.length < 4 * loop.beats; rep++) {
    for (const [pos16, value16, pitch] of lane.score) {
      const k = rep * 4 * lane.length + pos16;
      if (k >= 4 * loop.beats) continue;
      const onset = loopStartTick + Math.floor(k * beatTicks / 4);
      out.set(onset, [pitch, value16 * beatTicks / 4 / TICKS_PER_SECOND]);
    }
  }
  return out;
}

export class ScoreVoice {
  constructor(music) {
    this.music = music;
    this.map = null;
    this.table = [];   // table[loop][lane] = Map(onset -> [pitch, seconds]), built lazily
    this.starts = [];
    this.lastTick = -1;
  }
  setMap(map) {
    this.map = map;
    this.table = map.loops.map(() => []);
    this.starts = [];
    let start = 0;
    for (const loop of map.loops) {
      this.starts.push(start);
      start += Math.round(loop.beats * 3600 / loop.bpm);
    }
    this.lastTick = -1;
  }
  reset() {
    this.lastTick = -1;
  }
  loopAt(tick) {
    let i = 0;
    while (i + 1 < this.starts.length && tick >= this.starts[i + 1]) i++;
    return i;
  }
  // tick: the tick just processed. laneIndex: the ship's current lane.
  // Returns the number of oscillators created (0 when muted, locked, quiet, or no note is due).
  beat(tick, laneIndex) {
    if (!this.map || tick === this.lastTick) return 0;
    this.lastTick = tick;
    const li = this.loopAt(tick);
    const lane = this.map.loops[li].lanes[laneIndex];
    if (!lane) return 0;
    const notes = (this.table[li][laneIndex] ??= laneNotes(this.map.loops[li], lane, this.starts[li]));
    const note = notes.get(tick);
    if (!note || !this.music.ready()) return 0;
    const {context, gain} = this.music;
    const [pitch, seconds] = note;
    const now = context.currentTime;
    const oscillator = context.createOscillator(), envelope = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = midiFrequency(pitch);
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(NOTE_GAIN, now + ATTACK_S);
    envelope.gain.setValueAtTime(NOTE_GAIN, now + Math.max(ATTACK_S, seconds - 0.05));
    envelope.gain.linearRampToValueAtTime(0.0001, now + seconds);
    oscillator.connect(envelope); envelope.connect(gain);
    oscillator.start(now); oscillator.stop(now + seconds + 0.02);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    return 1;
  }
}

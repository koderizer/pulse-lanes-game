// Song player (FB3-WEB10, ruling R46.2). Presentation only: ambience from one HTMLAudioElement
// (a bundled CC0 / CC BY track from songs/manifest.js, or the player's own local file) routed
// through createMediaElementSource -> songGain -> the Music master gain. Music itself is not
// touched (AU-1 carve-out). Nothing here reads or drives the simulation: no module imports, no
// timing from the media clock, no network primitive. Importable in Node with no globals.
//
// Contract in one place:
//   * The constructor creates nothing. The element, the source node and songGain are created
//     lazily, once, inside gesture(), and only when playback is wanted (R46.2.9) and Music has
//     already built its context and master gain. SongPlayer never makes an AudioContext.
//   * play() is called ONLY from gesture() (the caller pairs it with every Music.gesture()).
//     sync() runs every frame and only ever PAUSES, so a key press during pause, a hidden tab or a
//     frame callback can never start a song.
//   * covering() is true only while the song is audible; the app then skips the synth beat pulse
//     and score voice (R46.2.7). Failure of any kind falls back to the synth with no console error.

export const SONG_GAIN = Object.freeze([0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2]);
export const SONG_LEVEL_DEFAULT = 5;
export const SONG_KEY = 'pl-song';
export const SONG_LEVEL_KEY = 'pl-song-level';
export const SONG_STALL_MS = 1500;
export const SONG_START_TIMEOUT_MS = 6000;
export const SONG_LICENSES = Object.freeze(['CC0-1.0', 'CC-BY-4.0']);
export const SONG_BUDGET = Object.freeze({trackBytes: 4194304, totalBytes: 16777216, count: 8, minSeconds: 30, maxSeconds: 300});
export const SONG_FAILED_TEXT = 'Song unavailable - playing the synth score.';

const ID_PATTERN = /^[a-z0-9-]{1,32}$/;
const FILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}\.mp3$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const LICENSE_LABEL = Object.freeze({'CC0-1.0': 'CC0 1.0', 'CC-BY-4.0': 'CC BY 4.0'});
const ACTIVE = Object.freeze(['loading', 'playing', 'stalled']);

// Lobby credit line for a bundled track: "Title by Artist (CC BY 4.0)".
export function songCredit(track) {
  return `${track.title} by ${track.artist} (${LICENSE_LABEL[track.license] ?? track.license})`;
}

// Stored value -> selection. Anything but 'synth' or a known bundled id (so never 'local') is synth.
export function songIdOrDefault(value, tracks = []) {
  if (value === 'synth') return 'synth';
  for (const track of tracks) if (track.id === value) return value;
  return 'synth';
}

// Stored value -> level: a string 1 .. 10 only; anything else is the default.
export function songLevelOrDefault(value) {
  return typeof value === 'string' && /^(10|[1-9])$/.test(value) ? Number(value) : SONG_LEVEL_DEFAULT;
}

// R46.2.3 manifest rules except file existence, size on disk and sha256 (the probe checks those
// with node:fs). Returns {ok, errors}; every violation is listed.
export function validateManifest(songs) {
  const errors = [];
  if (!Array.isArray(songs)) return {ok: false, errors: ['manifest is not an array']};
  if (songs.length > SONG_BUDGET.count) errors.push(`count ${songs.length} exceeds ${SONG_BUDGET.count}`);
  const ids = new Set(), files = new Set();
  let total = 0;
  songs.forEach((song, i) => {
    const at = `entry ${i}`;
    if (song === null || typeof song !== 'object' || Array.isArray(song)) { errors.push(`${at}: not an object`); return; }
    if (typeof song.id !== 'string' || !ID_PATTERN.test(song.id)) errors.push(`${at}: id must match ${ID_PATTERN}`);
    else if (song.id === 'synth' || song.id === 'local') errors.push(`${at}: id ${song.id} is reserved`);
    else if (ids.has(song.id)) errors.push(`${at}: duplicate id ${song.id}`);
    else ids.add(song.id);
    for (const key of ['title', 'artist']) {
      if (typeof song[key] !== 'string' || song[key].length < 1 || song[key].length > 60) errors.push(`${at}: ${key} must be 1..60 characters`);
    }
    if (!SONG_LICENSES.includes(song.license)) errors.push(`${at}: license ${String(song.license)} is not one of ${SONG_LICENSES.join(', ')}`);
    let url = null;
    try { url = new URL(song.source); } catch { /* reported below */ }
    if (typeof song.source !== 'string' || !url || url.protocol !== 'https:') errors.push(`${at}: source must be an https URL`);
    if (typeof song.file !== 'string' || !FILE_PATTERN.test(song.file)) errors.push(`${at}: file must match ${FILE_PATTERN}`);
    else if (files.has(song.file)) errors.push(`${at}: duplicate file ${song.file}`);
    else files.add(song.file);
    if (!Number.isInteger(song.bytes) || song.bytes < 1 || song.bytes > SONG_BUDGET.trackBytes) errors.push(`${at}: bytes must be an integer 1..${SONG_BUDGET.trackBytes}`);
    else total += song.bytes;
    if (!Number.isInteger(song.seconds) || song.seconds < SONG_BUDGET.minSeconds || song.seconds > SONG_BUDGET.maxSeconds) {
      errors.push(`${at}: seconds must be an integer ${SONG_BUDGET.minSeconds}..${SONG_BUDGET.maxSeconds}`);
    }
    if (typeof song.sha256 !== 'string' || !SHA_PATTERN.test(song.sha256)) errors.push(`${at}: sha256 must be 64 lowercase hex characters`);
  });
  if (total > SONG_BUDGET.totalBytes) errors.push(`total bytes ${total} exceeds ${SONG_BUDGET.totalBytes}`);
  return {ok: errors.length === 0, errors};
}

export class SongPlayer {
  constructor(music, {tracks = [], base = './songs/', createAudio, createObjectURL, revokeObjectURL} = {}) {
    this.music = music;
    this.tracks = tracks;
    this.base = base;
    // Looked up lazily, never at construction: a missing Audio or URL is a `failed` song, not a throw.
    this.createAudio = createAudio ?? (() => new globalThis.Audio());
    this.createObjectURL = createObjectURL ?? (file => globalThis.URL.createObjectURL(file));
    this.revokeObjectURL = revokeObjectURL ?? (url => globalThis.URL.revokeObjectURL(url));
    this.selection = 'synth';
    this.level = SONG_LEVEL_DEFAULT;
    this.state = 'off';          // off | idle | loading | playing | stalled | blocked | failed
    this.error = null;
    this.flags = {running: false, paused: false, hidden: false, muted: false};
    this.now = 0;                // the frame clock of the last sync()
    this.element = null;
    this.source = null;
    this.songGain = null;
    this.localFile = null;
    this.localUrl = null;
    this.loadedKey = null;       // what the element's src currently holds ('local:<url>' or a track id)
    this.loadId = 0;             // one per play request or failed attempt; guards late callbacks
    this.warnedLoad = -1;
    this.playingSeen = false;
    this.lastTime = 0;
    this.lastAdvance = 0;
    this.requestAt = 0;
  }

  // ---------------------------------------------------------------- selection and level
  select(id) {
    if (id !== 'synth' && id !== 'local' && !this.trackById(id)) return false;
    if (id === this.selection) return true;
    this.haltElement();
    this.selection = id;
    this.error = null;
    this.state = id === 'synth' ? 'off' : 'idle';
    this.restart();
    return true;
  }
  setLocalFile(file) {
    if (!file) return;
    let url;
    try { url = this.createObjectURL(file); }
    catch (err) { this.fail(`local file unavailable: ${err?.message ?? err}`); return; }
    this.haltElement();
    if (this.localUrl !== null) { try { this.revokeObjectURL(this.localUrl); } catch { /* the old URL is dropped either way */ } }
    this.localFile = file;
    this.localUrl = url;
    this.selection = 'local';
    this.error = null;
    this.state = 'idle';
    this.restart();
  }
  setLevel(level) {
    if (!Number.isInteger(level) || level < 1 || level > 10) throw new RangeError('song level must be an integer 1 .. 10');
    this.level = level;
    if (this.songGain) this.songGain.gain.value = SONG_GAIN[level];
  }
  trackById(id) {
    for (const track of this.tracks) if (track.id === id) return track;
    return null;
  }
  // A selection change starts the next song from the top.
  restart() {
    this.loadedKey = null;
    if (this.element) { try { this.element.currentTime = 0; } catch { /* a detached element has no position */ } }
  }

  // ---------------------------------------------------------------- wanted (R46.2.9)
  // selection !== synth && running && !paused && !hidden && !muted, plus a playable source. The mute
  // flag is read live from Music (the app applies it before gesture, AU-7); the others are recorded
  // by sync(), startRun(), resume() and pause().
  wanted() {
    if (this.selection === 'synth') return false;
    const f = this.flags;
    if (!f.running || f.paused || f.hidden) return false;
    if ((this.music?.muted ?? f.muted) === true) return false;
    return this.sourceUrl() !== null;
  }
  sourceUrl() {
    if (this.selection === 'local') return this.localUrl;
    const track = this.trackById(this.selection);
    return track ? `${this.base}${track.file}` : null;
  }

  // ---------------------------------------------------------------- run and pause hooks
  // A run begins: it is live and unpaused, and a `failed` song gets one retry for this run.
  startRun() {
    this.flags.running = true;
    this.flags.paused = false;
    if (this.state === 'failed') { this.error = null; this.state = this.selection === 'synth' ? 'off' : 'idle'; }
  }
  // The pause overlay was dismissed (the gesture that follows may start playback).
  resume() {
    this.flags.paused = false;
  }
  // Pairs with Music.quiet() / reset(): never starts anything, only silences.
  pause() {
    this.flags.paused = true;
    this.haltElement();
  }
  haltElement() {
    if (ACTIVE.includes(this.state) || this.state === 'blocked') this.state = this.selection === 'synth' ? 'off' : 'idle';
    if (this.element && !this.element.paused) { try { this.element.pause(); } catch { /* an unplayable element is already silent */ } }
  }

  // ---------------------------------------------------------------- the one place play() is called
  gesture() {
    if (!this.wanted() || this.state === 'failed' || ACTIVE.includes(this.state)) return;
    if (!this.music?.context || !this.music?.gain) return;
    const id = ++this.loadId;
    try {
      this.ensureGraph();
      this.prepareSource();
    } catch (err) {
      this.fail(`song unavailable: ${err?.message ?? err}`);
      return;
    }
    const element = this.element;
    this.state = 'loading';
    this.playingSeen = false;
    this.requestAt = this.now;
    this.lastAdvance = this.now;
    this.lastTime = element.currentTime;
    element.preload = 'auto';
    let pending;
    try { pending = element.play(); }
    catch (err) { this.rejected(err, id); return; }
    Promise.resolve(pending).then(undefined, err => this.rejected(err, id));
  }
  ensureGraph() {
    if (this.element) return;
    const {context, gain} = this.music;
    const element = this.createAudio();
    element.preload = 'none';
    element.loop = true;
    // Built whole or not at all, so a later run start can retry.
    const source = context.createMediaElementSource(element);
    const songGain = context.createGain();
    songGain.gain.value = SONG_GAIN[this.level];
    source.connect(songGain);
    songGain.connect(gain);
    element.addEventListener('playing', () => {
      if (this.element === element && ACTIVE.includes(this.state)) this.playingSeen = true;
    });
    element.addEventListener('error', () => {
      if (this.element === element) this.fail(`song media error ${element.error?.code ?? ''}`.trim());
    });
    this.element = element;
    this.source = source;
    this.songGain = songGain;
  }
  prepareSource() {
    const key = this.selection === 'local' ? `local:${this.localUrl}` : this.selection;
    if (this.loadedKey === key) return;
    this.element.src = this.sourceUrl();
    this.loadedKey = key;
    try { this.element.currentTime = 0; } catch { /* the position starts at 0 for a new source anyway */ }
  }
  rejected(err, id) {
    if (id !== this.loadId) return;
    const name = err?.name;
    if (name === 'AbortError') return;                 // src changed or paused mid-request: state stands
    if (name === 'NotAllowedError') { if (this.state === 'loading') this.state = 'blocked'; return; }
    this.fail(`song play refused: ${name ?? err?.message ?? err}`);
  }
  fail(message) {
    this.state = 'failed';
    this.error = String(message);
    this.loadedKey = null;        // an errored element reloads its source on the retry
    if (this.element && !this.element.paused) { try { this.element.pause(); } catch { /* already unplayable */ } }
    if (this.warnedLoad !== this.loadId) {
      this.warnedLoad = this.loadId;
      console.warn(`song: ${this.error}`);
    }
  }

  // ---------------------------------------------------------------- per frame (never plays)
  sync({now, running, paused, hidden, muted}) {
    this.now = now;
    this.flags = {running: Boolean(running), paused: Boolean(paused), hidden: Boolean(hidden), muted: Boolean(muted)};
    if (!this.wanted()) { this.haltElement(); return; }
    const element = this.element;
    if (!element || !ACTIVE.includes(this.state)) return;
    if (element.error) { this.fail(`song media error ${element.error.code ?? ''}`.trim()); return; }
    const time = element.currentTime;
    if (time !== this.lastTime) {
      this.lastTime = time;
      this.lastAdvance = now;
      if (this.state !== 'playing' && this.playingSeen && !element.paused) this.state = 'playing';
    } else if (this.state === 'playing' && now - this.lastAdvance > SONG_STALL_MS) {
      this.state = 'stalled';
    } else if (this.state === 'loading' && now - this.requestAt >= SONG_START_TIMEOUT_MS) {
      this.fail('song did not start in time');
    }
  }
  // True iff the song is audible now (the synth beat pulse and score voice then stay silent).
  covering() {
    return this.state === 'playing';
  }
  inspect() {
    return {selection: this.selection, state: this.state, level: this.level, covering: this.covering(), error: this.error};
  }
}

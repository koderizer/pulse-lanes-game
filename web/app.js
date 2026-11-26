// Client loop. The only module that calls step/abandon on the game. Renderers, HUD,
// lobby and audio receive read-only rows (map, course, state snapshots, view) from here.
// New runs play pl-v3 (spec 21, ruling R35) in the lobby mode; the pl-v2 module stays for the
// lobby backdrop, the shared tunnel geometry and a legacy (v1 challenge) pl-v2 run path.
import {createGame, TICKS_PER_SECOND, MAX_TICKS, WEAPONS} from '../src/sim/space_racer.js';
import {createGame as createGameV3, loopCourse, loopStart, BEAM_R_MAX, BEAM_TIERS, MINERAL_NORMAL, MODES, MODE_TICKS, validateInputs as validateInputsV3} from '../src/sim/space_racer_v3.js';
import {newSave, importSave, exportSave, STORAGE_KEY} from '../src/state/pilot_state.js';
import {quantizeStick, keyboardStick, MAX_RADIUS_PX, CAPTURE_RADIUS_PX} from '../src/input/controls.js';
import {digest} from './digest.js';
import {Music} from './music.js';
import {ScoreVoice} from './score_voice.js';
import {Sfx, SFX_CODES, tierOf} from './sfx.js';
import {SongPlayer, SONG_KEY, SONG_LEVEL_KEY, SONG_FAILED_TEXT, songCredit, songIdOrDefault} from './song.js';
import {SONGS} from './songs/manifest.js';
import {renderHud, buildControls, formatKm, MODE_LABELS, paintRocketLatch} from './hud.js';
import {createPause} from './pause.js';
import {applySetting, defaultSettings, lastResultText, retryEnabled, SETTING_CONTROLS, volumeOf} from './lobby_model.js';
import {shipStats, STAT_ROWS} from './ship_stats.js';
import {createRenderer, createTrack, fovyFor, beatCues, LANE_SPACING, MU} from './render.js';
import {createRenderer2d, projectCross, shipAnchor} from './render2d.js';
import {createGameOver, drawShipPlan} from './gameover.js';
import {SHIPS, SHIP_KEY, shipIdOrDefault, outlineBounds} from './ships.js';
import {applyChallenge, createScanOverlay} from './challenge.js';

const BUILD = 'pl-web-0.2.0';
// Spec section 2 SPAWN_Z (mu). The sim module keeps this constant private, so it is handed to the
// renderers as a depth floor; they also extend visible depth to the largest z seen in view rows.
const SPAWN_Z = 1080000;
const TICK_MS = 1000 / TICKS_PER_SECOND;
const MAX_FRAME_MS = 250;
const IDLE_MS = 300000;
const EMPTY_VIEW = Object.freeze({asteroids: [], rockets: []});
const $ = id => document.getElementById(id);
const now = () => new Date().toISOString();
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const notice = message => { $('notice').textContent = message; };

const music = new Music();
const voice = new ScoreVoice(music);
const sfx = new Sfx(music);
const song = new SongPlayer(music, {tracks: SONGS});
function unlockAudio() { music.gesture(); song.gesture(); }
let save = null, session = null, game = null, map = null, course = [], view = EMPTY_VIEW;
// R50.3: Quality and Calm are no longer user settings. Every save (loaded, imported or created)
// is normalized to the forced defaults on the web layer; the state schema keeps both keys so the
// frozen save/export contract is untouched.
function forceSettingsDefaults(state) {
  if (state && state.settings) state.settings = {...state.settings, quality: 'high', reduced_motion: true};
  return state;
}
let prevState = null, currState = null, hudState = null, lastRun = null, lastSeed = null, seed = randomSeed();
let running = false, recorded = false, accumulator = 0, previousFrame = null, lastActive = Date.now();
let pendingReload = false; // R49: a new service worker took over while a run was live

// Spec 27.4.1 / R41.3: fire is a LEVEL (fireHeld 0 or 1), not a tap queue. lastSent keeps the
// last entry's [sx, sy, fire level]; the level persists in the sim without entries (27.1.1).
// fireTap / fireRepress: pending edges kept for the next tick (holdFire / liftFire below).
let hops = [], fireHeld = 0, fireTap = false, fireRepress = false, firePointer = null, boosts = 0, lastSent = [0, 0, 0];
// R54 wallCrash debounce: true while the ship sits pinned against the tunnel's travel-radius
// clamp (held lateral input, velocity read as [0, 0]; see sfx.js header). Reset on every run
// start/stop so a new run never inherits a stale contact from the previous one.
let wallContactActive = false;
// pl-v3 run plumbing (spec 21). runRuleset picks the button range: bit3 boost exists only for
// pl-v3 (buttons 0..15); a pl-v2 run keeps 0..7. scoreMap is the base pl-map-1 (HUD tempo, score
// voice); `map` is what the renderer draws, for pl-v3 the base loops repeated per cycle (R35.4,
// same section 4.3 geometry). `course` grows by absolute loop as a pl-v3 run advances.
const V3_CYCLE_TICKS = loopStart(3);
const V3_TRACK_CYCLES = 12;
let runRuleset = 'pl-v3', runMode = 'death', scoreMap = null, courseLoops = 0, runBoosts = 0;
// Per-tick {p, state, view} rows already produced by step/view, newest last (presentation only).
// A frame that runs several ticks hands all of them to the renderer, so no fire or short-lived
// rocket row is lost between frames.
const TRAIL_TICKS = 24;
let trail = [];
// Spec 26.1.3 / 26.2.3 rocket latch: the single source of truth (R and the ammo badge toggle it,
// hud.js only paints it). While on, every pl-v3 input entry ORs in bit4 (16, rocket selected for
// that tick). ROCKET_BIT: the loaded pl-v3 validator admits buttons 0..31 (R38.3); against a sim
// that still refuses bit4 the latch stays a display toggle instead of failing every step().
const ROCKET_BIT = (() => { try { validateInputsV3([[0, 16, 0, 0]], 'death'); return true; } catch { return false; } })();
let rocketLatch = false;
// Index of the next pl-v3 trace event not yet voiced (spec 26.4 cue wiring).
let eventCursor = 0;
const held = {w: false, a: false, s: false, d: false};
let stickPointer = null, touchStick = [0, 0], stickOrigin = null;
// Ship model (spec 19, ruling R33): the lobby choice, and the model locked in when a run starts
// (that one goes on the card). Presentation only; the sim never sees it.
let shipId = shipIdOrDefault(null), runShip = shipId;
// FB3-QR R-3: the lobby settings a run started with, for the card's challenge code.
let runSettings = null;

// ------------------------------------------------------------------ renderer selection (spec 12)
let renderer = null, rendererKind = 'unknown';
const settingsNow = () => save?.settings ?? defaultSettings();
function showRendererKind() {
  // R50.1: the GPU row left the lobby; the writer stays null-safe (guard-pinned form).
  const kindView = $('renderer-kind');
  if (kindView) kindView.textContent = rendererKind;
}
function useFallback(reason) {
  try { renderer?.dispose?.(); } catch { /* the failed renderer is discarded either way */ }
  // A canvas that ever held a WebGL context cannot give a 2D context; swap in a fresh element.
  let canvas = $('canvas');
  if (rendererKind === 'webgl2' || reason !== 'forced') { const fresh = canvas.cloneNode(false); canvas.replaceWith(fresh); canvas = fresh; }
  renderer = createRenderer2d({canvas, settings: settingsNow(), spawnZ: SPAWN_Z});
  renderer.setShip?.(shipId);
  rendererKind = 'fallback2d';
  if (map) renderer.setCourse(map, running || game ? course : []);
  showRendererKind();
  if (reason === 'lost') notice('3D view lost its graphics context. Switched to the 2D view; the run continues.');
}
function initRenderer() {
  const forced = new URLSearchParams(location.search).get('renderer') === 'fallback2d';
  if (forced) return useFallback('forced');
  try {
    // One WebGL2 attempt only. Any failure (no context, shader or link error) selects the fallback.
    renderer = createRenderer({canvas: $('canvas'), settings: settingsNow(), spawnZ: SPAWN_Z, ship: shipId, onLost: () => useFallback('lost')});
    renderer.setShip?.(shipId);
    rendererKind = 'webgl2';
    showRendererKind();
  } catch (err) {
    console.warn('WebGL2 unavailable, using the 2D fallback:', err?.message ?? err);
    useFallback('failed');
  }
}

// ------------------------------------------------------------------ save and session (unchanged rules)
function persist() {
  if (!save) return;
  try { localStorage.setItem(STORAGE_KEY, exportSave(save)); }
  catch { notice('Storage is unavailable or full. Export your save to keep these runs.'); }
  updateLobby();
}

function beginSession() {
  if (!session) {
    session = {active_ticks: 0, started_at: now(), ended_at: null, run_ids: []};
    save.sessions.push(session);
  }
  lastActive = Date.now();
}

function recordRun() {
  if (!game || recorded || !session) return;
  if (game.state().status === 'running') game.abandon();
  if (runRuleset === 'pl-v3') {
    // PilotState v2 (src/state/pilot_state.js, frozen) admits pl-v1/pl-v2 run records only and
    // the pl-v3 game has no run record or replay bytes, so a pl-v3 run is not written into the
    // save (that would make the next boot refuse the whole save). Session ticks still count.
    const s = game.state();
    recorded = true; currState = s;
    lastRun = {ruleset_id: s.ruleset_id, mode: s.mode, seed: s.seed, terminal_reason: s.terminal_reason, distance: s.distance};
    persist();
    return;
  }
  const runNumber = save.runs.length ? BigInt(save.runs.at(-1).run_id.slice(4)) + 1n : 1n;
  if (runNumber > 9999999999999999n) {
    notice('Run ID limit reached. Export this save and start an empty save.');
    return;
  }
  const run = {...game.runRecordCore(), build_id: BUILD, run_id: `run-${runNumber}`, replay_hash: digest(game.replayBytes())};
  save.runs.push(run); session.run_ids.push(run.run_id);
  recorded = true; lastRun = run;
  currState = game.state();
  persist();
}

function stopRun() {
  recordRun();
  running = false; hops = []; releaseFire(); boosts = 0; accumulator = 0; previousFrame = null;
  wallContactActive = false;
  pause.runEnded();
  music.quiet(); song.pause();
}

function endSession() {
  if (running) stopRun();
  if (session) { session.ended_at = now(); session = null; persist(); }
}

// ------------------------------------------------------------------ lobby (spec 14)
const lobby = $('lobby');
function updateLobby() {
  $('last-result').textContent = lastRun?.ruleset_id === 'pl-v3'
    ? `${{collision: 'Collision', complete: 'Complete', abandoned: 'Abandoned'}[lastRun.terminal_reason] ?? 'Unknown'} · ${formatKm(lastRun.distance)} KM · ${MODE_LABELS[lastRun.mode] ?? lastRun.mode} · seed ${lastRun.seed}`
    : lastResultText(lastRun);
  $('seed').textContent = String(lastSeed ?? seed);
  $('retry').disabled = !retryEnabled({lastSeed});
  $('replay').disabled = !(game && typeof game.replayBytes === 'function' && game.state().status === 'ended' && recorded);
  showRendererKind();
  showSong();
  const s = settingsNow();
  const vol = volumeOf(s);
  $('set-volume').value = String(vol);
  $('set-volume-value').textContent = String(vol);
  syncVolumeDial(vol); // R53: keep the rotary dial visual in lock-step with the real input
  renderShipStats(); // R50.2: the stats grid tracks the selected ship
  if (!save) { $('history').textContent = 'Save could not be loaded. Import a valid save or choose New empty save.'; return; }
  const best = save.runs.reduce((score, run) => run.ruleset_id === 'pl-v2' && run.terminal_reason !== 'abandoned' ? Math.max(score, run.score) : score, 0);
  $('history').textContent = `${save.runs.length} recorded runs · Best: ${best} / ${MAX_TICKS} ticks`;
}
function openLobby() {
  if (pendingReload) { pendingReload = false; location.reload(); return; } // R49: adopt the new build when idle
  gameOver.hide();
  document.body.classList.remove('running');
  updateLobby();
  if (!lobby.open) { try { lobby.showModal(); } catch { lobby.setAttribute('open', ''); } }
}
function closeLobby() {
  if (lobby.open) lobby.close();
  document.body.classList.add('running');
}
lobby.addEventListener('cancel', event => event.preventDefault()); // Escape never closes the lobby without a run

// Ship picker (spec 19 SH-2, ruling R33): one button per registry model with a canvas silhouette
// drawn from its outline (gameover.js drawShipPlan, so the shapes live only in ships.js). Buttons
// only, no input or select; the DOM is built here so index.html stays unchanged. The choice
// lives in its own localStorage key (SHIP_KEY), never in the pilot save.
const shipButtons = [];
function loadShip() {
  try { return shipIdOrDefault(localStorage.getItem(SHIP_KEY)); } catch { return shipIdOrDefault(null); }
}
function showShip() { for (const b of shipButtons) b.setAttribute('aria-pressed', String(b.dataset.ship === shipId)); }
function chooseShip(id) {
  shipId = shipIdOrDefault(id);
  try { localStorage.setItem(SHIP_KEY, shipId); } catch { /* the choice still applies until the page closes */ }
  renderer?.setShip?.(shipId);
  showShip();
  renderShipStats(); // R50.2
}
function renderShipStats() {
  const s = shipStats(shipId);
  const head = $('ship-current');
  if (head) {
    const nameEl = head.querySelector('.readout-name');
    const tagEl = head.querySelector('.readout-tag');
    if (nameEl) nameEl.textContent = s.name;
    if (tagEl) tagEl.textContent = s.blurb;
  }
  for (const [, id] of STAT_ROWS) { const o = $(id); if (o) o.textContent = s.values[id]; }
}
function buildShipPicker() {
  const section = document.createElement('section');
  section.className = 'ships';
  section.setAttribute('aria-label', 'Ship');
  const dpr = Math.min(3, Math.max(1, Number(window.devicePixelRatio) || 1)), W = 64, H = 44;
  for (const m of SHIPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ship';
    b.dataset.ship = m.id;
    b.title = m.blurb;
    b.setAttribute('aria-label', `${m.name}: ${m.blurb}`);
    const art = document.createElement('canvas');
    art.width = W * dpr; art.height = H * dpr;
    art.setAttribute('aria-hidden', 'true');
    const ctx = art.getContext('2d');
    if (ctx) {
      const [x0, z0, x1, z1] = outlineBounds(m);
      ctx.scale(dpr, dpr);
      drawShipPlan(ctx, m, W / 2, H / 2, Math.min((W - 8) / (x1 - x0), (H - 6) / (z1 - z0)));
    }
    const name = document.createElement('span');
    name.textContent = m.name;
    b.append(art, name);
    b.addEventListener('click', () => chooseShip(m.id));
    shipButtons.push(b);
    section.append(b);
  }
  // R50.2 / R51: ship buttons only in the strip; the stats readout is a lobby sibling below it.
  const stats = document.createElement('div');
  stats.className = 'ship-stats';
  stats.id = 'ship-stats';
  const nm = document.createElement('h3');
  nm.className = 'readout-head';
  nm.id = 'ship-current';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'readout-name';
  const tagSpan = document.createElement('span');
  tagSpan.className = 'readout-tag';
  nm.append(nameSpan, tagSpan);
  stats.append(nm);
  for (const [label, id] of STAT_ROWS) {
    const row = document.createElement('div');
    row.className = 'stat';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    const o = document.createElement('output');
    o.className = 'val';
    o.id = id;
    row.append(k, o);
    stats.append(row);
  }
  lobby.querySelector('.launch').after(section);
  section.after(stats);
  showShip();
  renderShipStats();
}

// R50 (owner directive): lobby v2. Technical rows leave the face: the GPU row and the Seed and
// GPU data rows are removed (the seed lives on as a small serial beside PLAY, keeping its id and
// wiring), the Quality and Calm tiles are removed (forced defaults below), and the vault row
// collapses into one "Game settings" button that opens a dialog hosting the SAME controls, so
// every existing id and handler keeps working untouched. index.html stays byte-unchanged.
let settingsDialog = null;
function openSettings() {
  if (!settingsDialog || settingsDialog.open) return;
  try { settingsDialog.showModal(); } catch { settingsDialog.setAttribute('open', ''); }
}
function closeSettings() {
  if (!settingsDialog || !settingsDialog.open) return;
  try { settingsDialog.close(); } catch { settingsDialog.removeAttribute('open'); }
}
function tileOf(el) {
  let n = el;
  while (n && n !== lobby) {
    if (n.classList && n.classList.contains('tile')) return n;
    n = n.parentElement;
  }
  return el;
}
// R53: space high-techno retro radio redesign of the Music combo's inner. The real
// #set-volume range input stays the single state owner (hidden under the dial, synced both
// ways via syncVolumeDial/onVolumeInput above); #set-song stays a real, functional <select>
// restyled as a tappable station strip. Nothing here invents sim data or touches index.html -
// every node is built by JS, exactly like the existing R50/R51 lobby-v2 code.
function buildMusicCombo(volumeTile, songTileEl) {
  // ---- dial side: relocate the existing speaker svg + value output onto the face (below),
  // leave the accessible label text in place but visually hidden (clip, not display:none, so
  // the input keeps its accessible name), and build the rotary knob visual fresh.
  const volLabel = volumeTile.querySelector('label');
  const volSvg = volLabel ? volLabel.querySelector('svg') : null;
  const volOutput = $('set-volume-value');
  const volInput = $('set-volume');
  volumeTile.classList.add('dial-tile');
  const dial = document.createElement('div');
  dial.className = 'dial';
  dial.setAttribute('aria-hidden', 'true');
  dialTicks = [];
  for (let i = 0; i <= 10; i++) {
    const tick = document.createElement('i');
    tick.className = 'tick';
    tick.style.transform = `rotate(${-135 + (i / 10) * 270}deg)`;
    dial.append(tick);
    dialTicks.push(tick);
  }
  dialLed = document.createElement('i');
  dialLed.className = 'dial-led';
  dial.append(dialLed);
  dialEl = dial;
  if (volLabel) volLabel.after(dial); // sits between the (hidden) label and the real input
  else volumeTile.append(dial);
  volInput.classList.add('dial-input'); // the real input stays last: on top, catching input

  // ---- face side: a small "face-display" strip (speaker icon + marquee + magenta value),
  // inserted into the tree first (R53 harness lesson), then the pre-existing svg/output moved in.
  songTileEl.classList.add('radio-face');
  const display = document.createElement('div');
  display.className = 'face-display';
  const firstChild = songTileEl.firstElementChild;
  if (firstChild) firstChild.before(display); else songTileEl.append(display);
  const track = document.createElement('div');
  track.className = 'marquee-track';
  const text = document.createElement('span');
  text.className = 'marquee-text';
  track.append(text);
  display.append(track);
  if (volSvg) track.before(volSvg);
  display.append(volOutput);
  marqueeTrack = track; marqueeText = text;
  showSong(); // now that marqueeText exists, fill it with the current station's label
  syncVolumeDial(volumeOf(settingsNow()));
}
function buildLobbyV2() {
  const seedEl = $('seed'); // capture before the data rows go; the serial keeps this very element
  const data = lobby.querySelector('.data');
  for (const row of Array.from(data ? data.children : [])) {
    const k = row.querySelector('.k');
    if (k && (k.textContent === 'GPU' || k.textContent === 'Seed')) row.remove();
  }
  for (const id of ['set-quality', 'set-reduced-motion']) {
    const el = $(id);
    if (el) tileOf(el).remove();
  }
  // R51.4: Volume + Song become one horizontal Music combo (built after buildSongTile()).
  const volumeTile = lobby.querySelector('.tile.volume');
  const songTileEl = lobby.querySelector('.tile.song');
  if (volumeTile && songTileEl) {
    const combo = document.createElement('div');
    combo.id = 'music-control';
    combo.className = 'music-combo';
    // R53: reserved for future album-playlist/Spotify-connect source switching. Only local
    // (synth/file) playback exists today, so this names the one real source and nothing else;
    // no disabled buttons or fake chips for sources that don't exist yet.
    combo.setAttribute('data-source', 'local');
    const head = document.createElement('span');
    head.className = 'music-label';
    head.textContent = 'Music';
    combo.append(head);
    volumeTile.before(combo); // place the combo first, then move the tiles into it
    combo.append(volumeTile, songTileEl);
    // R53: a reserved, empty row for future source chips (e.g. local|radio) - intentionally
    // carries no children today; see data-source above.
    const chips = document.createElement('div');
    chips.className = 'source-chips';
    chips.setAttribute('aria-hidden', 'true');
    combo.append(chips);
    buildMusicCombo(volumeTile, songTileEl);
  }
  const vault = lobby.querySelector('.vault');
  if (vault) {
    settingsDialog = document.createElement('dialog');
    settingsDialog.id = 'settings-dialog';
    settingsDialog.setAttribute('aria-label', 'Game settings');
    const panel = document.createElement('div');
    panel.className = 'panel';
    const h = document.createElement('h2');
    h.textContent = 'Game settings';
    panel.append(h);
    if (seedEl) { // R51.4: the seed serial lives in the dialog, not on the lobby face.
      const line = document.createElement('div');
      line.className = 'serial-line';
      const cap = document.createElement('span');
      cap.textContent = 'Seed';
      seedEl.className = 'serial';
      seedEl.title = 'seed serial';
      line.append(cap, seedEl);
      panel.append(line);
    }
    for (const el of Array.from(vault.children)) {
      const row = document.createElement('div');
      row.className = 'settings-row';
      row.append(el);
      panel.append(row);
    }
    const done = document.createElement('button');
    done.type = 'button';
    done.id = 'settings-done';
    done.className = 'primary';
    done.textContent = 'Done';
    done.addEventListener('click', closeSettings);
    panel.append(done);
    settingsDialog.append(panel);
    document.body.append(settingsDialog);
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.id = 'game-settings';
    gear.className = 'icon';
    gear.setAttribute('aria-label', 'Game settings: save, load, export, import, new, replay');
    const label = document.createElement('span');
    label.textContent = 'Game settings';
    gear.append(label);
    gear.addEventListener('click', openSettings);
    vault.after(gear);
    vault.remove();
  }
  // R51: DOM order drives layout (CSS order is a no-op here). Modes above ships; stats below ships.
  const ships = lobby.querySelector('.ships');
  const modes = lobby.querySelector('.modes');
  const statsPanel = $('ship-stats');
  if (modes && ships) ships.before(modes);
  if (statsPanel && ships) {
    if (statsPanel.parentElement === ships) statsPanel.remove();
    if (statsPanel.previousElementSibling !== ships) ships.after(statsPanel);
  }
}

// Mode selector (spec 21.6, ruling R35): DEATH (default), 90S, 120S as lobby-token buttons like
// the ship picker. The choice lives in its own localStorage key pl-mode (same discipline as
// pl-ship), never in the pilot save; the next pl-v3 run is created with it.
const MODE_KEY = 'pl-mode';
const MODE_DEFAULT = 'death';
const MODE_BLURB = Object.freeze({death: 'Until hit', timed90: '90 seconds', timed120: '120 seconds'});
const modeOrDefault = m => (MODES.includes(m) ? m : MODE_DEFAULT);
let modeId = MODE_DEFAULT;
const modeButtons = [];
function loadMode() {
  try { return modeOrDefault(localStorage.getItem(MODE_KEY)); } catch { return MODE_DEFAULT; }
}
function showMode() { for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === modeId)); }
function chooseMode(m) {
  modeId = modeOrDefault(m);
  try { localStorage.setItem(MODE_KEY, modeId); } catch { /* the choice still applies until the page closes */ }
  showMode();
}
function buildModePicker() {
  const section = document.createElement('section');
  section.className = 'modes';
  section.setAttribute('aria-label', 'Mode');
  for (const m of MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mode';
    b.dataset.mode = m;
    b.setAttribute('aria-label', `${MODE_LABELS[m]}: ${MODE_BLURB[m]}`);
    const name = document.createElement('span');
    name.className = 'mode-name';
    name.textContent = MODE_LABELS[m];
    const blurb = document.createElement('span');
    blurb.className = 'mode-blurb';
    blurb.textContent = MODE_BLURB[m];
    b.append(name, blurb);
    b.addEventListener('click', () => chooseMode(m));
    modeButtons.push(b);
    section.append(b);
  }
  (lobby.querySelector('.ships') ?? lobby.querySelector('.launch')).after(section);
  // Key legend: the boost key next to the existing chips (index.html stays unchanged).
  const keys = lobby.querySelector('.keys');
  if (keys) {
    const chip = document.createElement('span'), kbd = document.createElement('kbd');
    kbd.textContent = 'B';
    chip.append(kbd, 'Boost');
    keys.append(chip);
  }
  showMode();
}

// Song picker (R46.2.11): one settings tile built here after the music tile (index.html stays
// unchanged). The choice and level live in their own localStorage keys (pl-song, pl-song-level),
// never in the pilot save, an export, the challenge preset or the replay. `local` (a file from this
// device) is never stored: a reload returns to the stored value. Presentation only.
let songTile = null;
// R53: radio-face marquee elements (built in buildMusicCombo, set once at init).
let marqueeTrack = null, marqueeText = null;
// R53: volume dial visual elements + active pointer drag (built in buildMusicCombo).
let dialEl = null, dialTicks = [], dialLed = null, dialDrag = null;
function storeSong(key, value) {
  try { localStorage.setItem(key, value); } catch { /* the choice still applies until the page closes */ }
}
function loadSongPrefs() {
  let id = 'synth';
  try { localStorage.removeItem(SONG_LEVEL_KEY); } catch { /* storage unavailable */ }
  try { id = songIdOrDefault(localStorage.getItem(SONG_KEY), SONGS); } catch { /* storage unavailable: defaults */ }
  song.select(id);
  const s = settingsNow();
  song.setLevel(s.music_level);
}
function showSong() {
  if (!songTile) return;
  const info = song.inspect();
  $('set-song').value = info.selection;
  const track = SONGS.find(t => t.id === info.selection);
  $('song-credit').textContent = track ? songCredit(track) : info.selection === 'local' ? (song.localFile?.name ?? '') : '';
  $('song-status').textContent = info.state === 'failed' ? SONG_FAILED_TEXT : '';
  // R53: the radio face marquee mirrors the full label of the currently-selected station (the
  // same text the <select> option already carries); data-song-id is a reserved hook for future
  // album-playlist/Spotify-connect work and carries no behavior today.
  const select = $('set-song');
  const opt = [...(select?.children ?? [])].find(c => c.value === select.value) ?? null;
  if (marqueeText) marqueeText.textContent = opt ? opt.textContent : '';
  if (songTile) songTile.setAttribute('data-song-id', info.selection);
  updateMarquee();
}
function updateMarquee() {
  // R53: only scroll when the full title overflows the visible track; prefers-reduced-motion and
  // the select-focused pause live in CSS (lobby.css), this just measures and flags overflow.
  if (!marqueeTrack || !marqueeText) return;
  const trackWidth = marqueeTrack.getBoundingClientRect?.().width || 0;
  const textWidth = marqueeText.getBoundingClientRect?.().width || 0;
  const overflow = Math.max(0, textWidth - trackWidth);
  marqueeText.style.setProperty('--overflow', `${overflow}px`);
  marqueeTrack.classList.toggle('scrolling', overflow > 2);
}
function buildSongTile() {
  const make = (tag, props = {}, attrs = {}) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    Object.assign(node, props);
    return node;
  };
  const tile = make('div', {className: 'tile song'});
  const label = make('label', {}, {for: 'set-song'});
  label.append(make('span', {textContent: 'Song'}));
  const select = make('select', {id: 'set-song'});
  const options = [['synth', 'Synth score'], ...SONGS.map(t => [t.id, `${t.title} - ${t.artist}`]), ['local', 'From this device...']];
  for (const [value, text] of options) select.append(make('option', {value, textContent: text}));
  const file = make('input', {id: 'set-song-file', type: 'file', hidden: true}, {accept: 'audio/*'});
  const credit = make('p', {id: 'song-credit'});
  const status = make('p', {id: 'song-status'}, {role: 'status'});
  tile.append(label, select, file, credit, status);
  lobby.querySelector('.tile.volume').after(tile);
  songTile = tile;
  select.addEventListener('change', event => {
    const id = event.target.value;
    if (id === 'local') { song.select('local'); $('set-song-file').click(); }
    else { song.select(id); storeSong(SONG_KEY, id); }
    showSong();
  });
  file.addEventListener('change', event => {
    const picked = event.target.files?.[0];
    if (picked) song.setLocalFile(picked);
    event.target.value = ''; // the same file can be picked again
    showSong();
  });
  showSong();
}

const STRIP_LICENSE = Object.freeze({'CC0-1.0': 'CC0', 'CC-BY-4.0': 'CC BY 4.0'});
function buildSongCreditsStrip() {
  const parts = SONGS.map(t => `"${t.title}" by ${t.artist} (${STRIP_LICENSE[t.license] ?? t.license})`);
  const p = document.createElement('p');
  p.id = 'song-credits';
  p.textContent = `Music: ${parts.join(', ')} - details: web/songs/ATTRIBUTION.md`;
  lobby.after(p);
}

// Challenge scan (spec 20 QR-3/QR-4, ruling R33). The Scan button, the banner and the scan
// overlay are built here and in challenge.js, never in index.html. A decoded code presets the
// lobby through the same paths as manual configuration: changeSetting (persist + music and
// renderer setters), chooseShip (pl-ship + setShip) and the seed the next Play starts. The run
// is then played and scored normally; nothing else changes. Camera frames stay in the page.
let challenge = null, challengeBanner = null, scanner = null;
function showChallenge() {
  if (!challengeBanner) return;
  challengeBanner.hidden = !challenge;
  challengeBanner.textContent = challenge?.text ?? '';
}
const lobbyPort = {
  changeSetting: (key, value) => changeSetting(key, value),
  chooseShip: id => chooseShip(id),
  setSeed: next => { seed = next >>> 0; updateLobby(); },
  setChallenge: c => { challenge = c; showChallenge(); },
  // pl-v3 hooks for the challenge apply path (R35.6): setMode presets the lobby mode exactly like a
  // mode button; a challenge object carrying ruleset 'pl-v2' (decoded legacy v1 payload) makes the
  // next run on its seed a pl-v2 timed run.
  setMode: m => chooseMode(m),
  // Spec 22 scan apply ('jump immediately'): start the preset seed now, exactly as Play would.
  play: () => { if (save) { const next = seed; seed = randomSeed(); start(next); } },
};
function onChallenge(config, result) {
  if (!save) notice('Import a valid save or choose New empty save before playing the challenge.');
  applyChallenge(config, lobbyPort);
  if (running) return; // the challenge run started directly
  challengeBanner?.scrollIntoView?.({block: 'nearest'}); // paste sheet success lands on the banner
  notice(result.warnings.length ? `Challenge loaded. ${config.ship_requested} is not in this build; flying ${config.ship.toUpperCase()}.`
    : 'Challenge loaded. Press Play to fly it.');
  $('play').focus?.();
}
function buildChallengeUi() {
  const svgNs = lobby.querySelector('svg')?.namespaceURI ?? null;
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'scan';
  b.className = 'icon scan-open';
  b.title = 'Scan challenge';
  b.setAttribute('aria-label', 'Scan challenge');
  if (svgNs) {
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    for (const d of ['M4 9V4h5', 'M15 4h5v5', 'M20 15v5h-5', 'M9 20H4v-5', 'M9 9h2v2H9z', 'M13 13h2v2h-2z', 'M13 9h2', 'M9 15h2']) {
      const p = document.createElementNS(svgNs, 'path'); p.setAttribute('d', d); svg.append(p);
    }
    b.append(svg);
  }
  const label = document.createElement('span');
  label.textContent = 'Scan';
  b.append(label);
  const launch = lobby.querySelector('.launch');
  // R51.2: the scanner is a utility, not an action button - it lives in the bottom row with
  // Game settings. Falls back to the launch row only if the bottom row does not exist.
  const gear = $('game-settings');
  const gp = gear && (gear.parentElement ?? gear.parentNode ?? gear.parent);
  if (gear && gp) {
    const row = document.createElement('div');
    row.className = 'utility-row';
    gear.after(row);
    row.append(gear, b);
  } else launch.append(b);
  challengeBanner = document.createElement('p');
  challengeBanner.className = 'challenge-banner';
  challengeBanner.setAttribute('role', 'status');
  challengeBanner.hidden = true;
  launch.before(challengeBanner);
  scanner = createScanOverlay({document, navigator, BarcodeDetector: globalThis.BarcodeDetector,
    requestFrame: cb => requestAnimationFrame(cb), cancelFrame: id => cancelAnimationFrame(id),
    onApply: onChallenge, onClose: () => b.focus?.()});
  b.addEventListener('click', () => scanner.open());
}

// Game over (spec 18 GO-1, ruling R31): a finished run shows this modal first; Back to lobby
// (or Escape) dismisses it and opens the lobby exactly as before. No run is in progress while
// it is open. Idle timeouts leave an open game over modal in place instead of yanking it.
const gameOver = createGameOver({document, onBack: () => openLobby()});
function openLobbyUnlessGameOver() { if (!gameOver.isOpen()) openLobby(); }

function applySettingsToOutputs() {
  const s = settingsNow();
  music.setMute(s.mute);
  if (!s.mute) {
    music.setLevel(s.music_level);
    song.setLevel(s.music_level);
  }
  renderer?.setSettings({quality: s.quality, reduced_motion: s.reduced_motion});
}
function changeSetting(key, raw) {
  if (!save) return;
  const result = applySetting(save.settings, key, raw);
  if (result.ok && result.persist) { save.settings = result.settings; persist(); }
  applySettingsToOutputs();
  updateLobby();
}
function onVolumeInput() { // changeSetting before unlockAudio (AU-7)
  const prev = volumeOf(settingsNow());
  changeSetting('volume', $('set-volume').value);
  applySettingsToOutputs();
  const vol = volumeOf(settingsNow());
  $('set-volume-value').textContent = String(vol);
  if (prev === 0 && vol > 0) unlockAudio();
  else if (running && !pause.isPaused() && vol > 0) unlockAudio();
}
$('set-volume').addEventListener('input', onVolumeInput);
// R53: the rotary dial drives the same real input, so every drag/wheel step calls onVolumeInput()
// directly (no synthetic DOM event construction - Node's own Event class refuses this harness's
// dispatchEvent, which sets .target on the event object) and updateLobby() keeps the knob synced.
function stepVolume(delta) {
  if (!delta) return;
  const input = $('set-volume');
  const next = Math.min(10, Math.max(0, Number(input.value) + delta));
  if (String(next) === input.value) return;
  input.value = String(next);
  onVolumeInput();
}
function syncVolumeDial(vol) {
  if (!dialEl) return;
  const v = Math.min(10, Math.max(0, Number(vol) || 0));
  dialEl.style.setProperty('--v', String(v / 10));
  const angle = -135 + (v / 10) * 270;
  if (dialLed) dialLed.style.transform = `rotate(${angle}deg) translateY(-20px)`;
  for (let i = 0; i < dialTicks.length; i++) dialTicks[i].classList.toggle('on', i <= v);
}
$('set-volume').addEventListener('pointerdown', event => {
  event.preventDefault();
  $('set-volume').focus();
  dialDrag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, value: Number($('set-volume').value)};
});
document.addEventListener('pointermove', event => {
  if (!dialDrag || event.pointerId !== dialDrag.pointerId) return;
  // ~8px per step; right or up raises the volume, left or down lowers it.
  const delta = Math.round(((event.clientX - dialDrag.x) - (event.clientY - dialDrag.y)) / 8);
  const input = $('set-volume');
  const next = Math.min(10, Math.max(0, dialDrag.value + delta));
  if (String(next) !== input.value) { input.value = String(next); onVolumeInput(); }
});
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, event => { if (dialDrag && event.pointerId === dialDrag.pointerId) dialDrag = null; });
}
$('set-volume').addEventListener('wheel', event => {
  event.preventDefault();
  stepVolume(event.deltaY < 0 ? 1 : -1);
}, {passive: false});

// ------------------------------------------------------------------ run lifecycle
function start(nextSeed) {
  if (!save) return notice('Import a valid save or choose New empty save before playing.');
  if (running) stopRun();
  // A challenge banner stays while its seed is played (Play, then Retry); any other seed ends it.
  // R35.16.7: a challenge is its seed AND its mode (R35.6); switching the lobby mode ends it too.
  if (challenge && (nextSeed !== challenge.seed || (challenge.mode != null && challenge.mode !== modeId))) { challenge = null; showChallenge(); }
  lastSeed = nextSeed;
  runRuleset = challenge?.ruleset === 'pl-v2' && challenge.seed === nextSeed ? 'pl-v2' : 'pl-v3';
  if (runRuleset === 'pl-v3') {
    runMode = modeId;
    game = createGameV3(nextSeed, runMode, shipId); // R45.2: the ship model sets the laser energy capacity
    scoreMap = createGame(nextSeed).map();
    map = {...scoreMap, loops: Array.from({length: V3_TRACK_CYCLES}, () => scoreMap.loops).flat()};
    course = []; courseLoops = 0; ensureCourse(0);
  } else {
    runMode = null;
    game = createGame(nextSeed); map = scoreMap = game.map(); course = game.course();
  }
  prevState = currState = game.state(); view = game.view();
  trail = [{p: currState.processed, state: currState, view}];
  recorded = false; running = true; hops = []; releaseFire(); boosts = 0; runBoosts = 0; lastSent = [0, 0, 0];
  accumulator = 0; previousFrame = null; eventCursor = 0; wallContactActive = false;
  setRocketLatch(false); // a run starts on the laser (ammo starts at 0)
  // R52: rewind, never reset. reset() suspends the context, and the unlockAudio() two statements
  // below resumes it in the same gesture stack; on an engine where suspend() lands on a later task
  // the suspend wins and the whole run plays silent. The previous run's quiet() already silenced.
  music.rewind(); song.pause(); voice.setMap(scoreMap);
  beginSession(); song.startRun(); unlockAudio(); persist();
  renderer.setCourse(map, course);
  if (rendererKind === 'webgl2') shipMirror.setCourse(map); // R44.2: same reset as render.js
  runShip = shipId; renderer.setShip?.(runShip);
  runSettings = {...settingsNow()};
  applySettingsToOutputs();
  pause.runStarted();
  ensurePickupLayer(); // R39.3.1: the overlay is created on the run-start path, never at import
  pickupSpeed.clear(); pickupView = null; resetBeams();
  closeLobby();
}

// pl-v3 course rows by asteroid id (the renderer indexes course[id]); view() reads loops L and L + 1,
// so rows are kept one loop ahead of the state's loop. Same array object for the whole run.
function ensureCourse(L) {
  while (courseLoops <= L + 1) {
    for (const row of loopCourse(lastSeed, courseLoops)) course[row[0]] = row;
    courseLoops++;
  }
}

function finishRun() {
  // R54 B-4: voice the game-over boom BEFORE stopRun() silences the run (its quiet() call flips
  // quietMode synchronously, so music.ready() would refuse right after). Collision only: an
  // abandoned or 'complete' ending is not a crash and stays silent here.
  if (currState && currState.status === 'ended' && currState.terminal_reason === 'collision') sfx.gameOverBoom();
  stopRun();
  const s = currState;
  if (!s || s.status !== 'ended' || s.terminal_reason === 'abandoned') return openLobby();
  document.body.classList.remove('running');
  if (s.ruleset_id === 'pl-v3') {
    // Spec 22 summary for the card (B-CARD renders it): distance plus the secondary stat row.
    let minerals = 0, gems = 0;
    for (const e of game.trace().events) if (e[1] === 5 && e.length === 5) { if (e[2] === 1) minerals++; else gems++; }
    gameOver.show({
      score: s.score, distance: s.distance, km: Math.floor(s.distance / 1000), mode: s.mode,
      ticks: s.terminal_tick, tps: TICKS_PER_SECOND, maxTicks: MODE_TICKS[s.mode] ?? s.terminal_tick,
      loops: s.loop + 1, loopCount: Math.max(3, s.loop + 1), lanes: s.lane_count, lane: s.lane, weapon: s.weapon,
      destroyed: s.destroyed, dodged: s.dodged, minerals, gems, boosts: runBoosts, ammo: s.ammo,
      seed: s.seed, ruleset: s.ruleset_id, reason: s.terminal_reason, date: now().slice(0, 10), ship: runShip,
      settings: runSettings ?? {...settingsNow()},
    });
    return;
  }
  gameOver.show({
    score: s.score, ticks: s.terminal_tick, tps: TICKS_PER_SECOND, maxTicks: MAX_TICKS,
    loops: s.loop + 1, loopCount: map?.loops?.length ?? 3, lanes: s.lane_count, lane: s.lane, weapon: s.weapon,
    seed: s.seed, ruleset: s.ruleset_id, reason: s.terminal_reason, date: now().slice(0, 10), ship: runShip,
    settings: runSettings ?? {...settingsNow()},
  });
}

const pause = createPause({
  onPause: () => { accumulator = 0; previousFrame = null; music.quiet(); song.pause(); },
  onResume: () => { accumulator = 0; previousFrame = null; lastActive = Date.now(); song.resume(); unlockAudio(); },
  onExit: () => { endSession(); openLobby(); },
});

// ------------------------------------------------------------------ input sampling (spec 6.4)
function currentStick() { return stickPointer !== null ? touchStick : keyboardStick(held); }
function press(kind) {
  unlockAudio();
  if (!running || pause.isPaused() || document.hidden) return;
  const t = game.state().processed;
  if (kind === 'fire') holdFire(); // level rises; liftFire() drops it (R41.3)
  else if (kind === 'boost') { if (runRuleset === 'pl-v3') boosts++; } // bit3 exists in pl-v3 only
  else hops.push({dir: kind, tick: t});
}
// R41.3 edge keeping: the sim only sees the level on ticks, so an edge that is undone before the
// next tick (tap inside one tick, or release and re-press inside one tick) would be lost. A press
// whose release is not sent yet re-raises after that release goes out (fireRepress); a release
// whose press is not sent yet drops after that press goes out (fireTap). tickOnce applies them.
function holdFire() {
  if (fireHeld === 0 && lastSent[2] === 1) fireRepress = true;
  else { fireHeld = 1; fireTap = false; }
}
// Soft release (Space keyup, fire pointerup / pointercancel, the a11y tap).
function liftFire() {
  firePointer = null; fireRepress = false;
  if (fireHeld === 1 && lastSent[2] === 0) fireTap = true;
  else fireHeld = 0;
}
// Hard reset (blur, run start and stop): level 0 now, no pending edges.
function releaseFire() { fireHeld = 0; fireTap = false; fireRepress = false; firePointer = null; }
function takeHop(t) {
  let best = -1;
  for (let i = 0; i < hops.length; i++) {
    if (hops[i].tick > t) continue;
    if (best < 0 || hops[i].tick < hops[best].tick || (hops[i].tick === hops[best].tick && hops[i].dir === 'left' && hops[best].dir !== 'left')) best = i;
  }
  return best < 0 ? null : hops.splice(best, 1)[0].dir;
}
function setRocketLatch(on) {
  rocketLatch = Boolean(on);
  paintRocketLatch(document, rocketLatch);
}
function toggleRocketLatch() { unlockAudio(); setRocketLatch(!rocketLatch); }
// Spec 26.4.1 cue wiring, R46 B-1 delta bridge: voice one processed tick from the state rows and
// view rows app.js already holds, with no game.trace() (its deep copy grows with run length).
//   fire:  fire_ready rose -> the weapon of the accepted shot (state().weapon, SFX_CODES).
//   kills: a pickup id in the new view that the previous view lacked is a rock destroyed this tick
//          (the pickup keeps its rock's id); its row [id, kind, lane, x, y, dt, amount] gives the tier
//          (R38.7: kind 1 mineral / 2 gem plus an amount, NOTE 27; tierOf in sfx.js).
//   hits:  an asteroid in both views whose hp (row index 4) dropped is a non-lethal hit.
// If the new-pickup count disagrees with the sim's destroyed counter, this tick is read from the
// trace instead (voiceEventsFromTrace) and the probe-visible counter is incremented. Expected 0.
const bridgeBefore = new Map();
function voiceDeltas(prev, curr, before, after) {
  const known = new Set();
  for (const row of before.pickups ?? []) known.add(row[0]);
  const born = [];
  for (const row of after.pickups ?? []) if (!known.has(row[0])) born.push(row);
  if (born.length !== curr.destroyed - prev.destroyed) {
    globalThis.__web10BridgeFallbacks = (globalThis.__web10BridgeFallbacks ?? 0) + 1;
    voiceEventsFromTrace(curr.processed - 1);
    return;
  }
  if (curr.fire_ready > prev.fire_ready) sfx.fire(SFX_CODES[curr.weapon]);
  const t = curr.processed - 1;
  const hits = [];
  for (const row of born) {
    sfx.destroyed(tierOf(row[1], row[6]));
    hits.push([t, 5, row[0], 0]);
  }
  bridgeBefore.clear();
  for (const row of before.asteroids ?? []) bridgeBefore.set(row[0], row[4]);
  for (const row of after.asteroids ?? []) {
    const hp = bridgeBefore.get(row[0]);
    if (hp !== undefined && row[4] < hp) hits.push([t, 5, row[0], row[4]]);
  }
  // Before the next draw syncs the new view, so the renderer still holds each rock's prior hp.
  if (hits.length) renderer?.noteHits?.(hits);
}
// Fallback read of the events of tick t from the trace (the pre-bridge path). The cursor moves to
// the trace length only here, so the events of earlier bridge ticks are never voiced a second time:
// the scan starts at the first event of tick t (event[0] is the tick, in nondecreasing order).
// The destroying event is [t, 6, id, code, pickup_kind, amount] (R38.4); a 4-field [t, 6, id, code]
// from a pre-26.3 sim still voices the explosion only.
function voiceEventsFromTrace(t) {
  const events = game.trace().events;
  let from = events.length;
  while (from > eventCursor && events[from - 1][0] >= t) from--;
  const hits = [];
  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (e[1] === 5 && e.length === 4) hits.push(e); // [t, 5, id, hp_left] hit (R41.4 burst strength)
    if (e[1] === 3 && e.length === 4) sfx.fire(e[2]);
    else if (e[1] === 6 && e.length >= 4) {
      const [, , , , pickupKind, amount] = e;
      sfx.destroyed(e.length === 6 && Number.isInteger(pickupKind) && Number.isInteger(amount) ? tierOf(pickupKind, amount) : null);
    }
  }
  eventCursor = events.length;
  if (hits.length) renderer?.noteHits?.(hits);
}
function tickOnce() {
  const t = game.state().processed;
  const v3 = runRuleset === 'pl-v3';
  let buttons = 0;
  const hop = takeHop(t);
  if (hop) buttons |= hop === 'left' ? 1 : 2;
  // Spec 27.1.1 / R41.3: bit2 is the fire LEVEL, carried on every entry; a held level alone sends
  // no further entries (the sim persists it), only a level change does (lastSent gate).
  if (fireHeld) buttons |= 4;
  // Spec 21.1: bit3 boost, an edge press (one per tick, extras queue). pl-v2 stays 0..7.
  if (boosts > 0) { boosts--; if (runRuleset === 'pl-v3') buttons |= 8; }
  // Spec 26.2.1: bit4 on every pl-v3 entry while the rocket latch is on (an entry every tick).
  if (rocketLatch && v3 && ROCKET_BIT) buttons |= 16;
  const stick = currentStick();
  const entries = [];
  if ((buttons & ~4) || fireHeld !== lastSent[2] || stick[0] !== lastSent[0] || stick[1] !== lastSent[1]) {
    entries.push([t, buttons, stick[0], stick[1]]);
    lastSent = [stick[0], stick[1], fireHeld];
  }
  if (fireTap) { fireTap = false; fireHeld = 0; } // the press went out; the next tick sends the release
  else if (fireRepress) { fireRepress = false; fireHeld = 1; } // the release went out; re-raise next tick
  prevState = currState;
  const viewBefore = view;
  currState = game.step(1, entries);
  if (v3) {
    ensureCourse(currState.loop);
    // R54 B-2: boost accepted. boost_until only moves on an accepted boost (the sim emits no
    // success event, only the refusal [t, 6, 1]); runBoosts already used this exact edge.
    if (currState.boost_until > prevState.boost_until) { runBoosts++; sfx.boost(); }
  }
  // R54 B-1: lane hop accepted, [t, 1, lane, lane+-1] - `hop` is the direction attempted above
  // (takeHop), and the lane only moves when the sim accepted it (a refusal leaves lane unchanged).
  if (hop && currState.lane !== prevState.lane) sfx.hop(hop);
  // R54 B-3: wall contact (see sfx.js header for the observable). Debounced to one voice per
  // continuous contact via wallContactActive; both rulesets share the same travel-radius clamp.
  const wallHit = (stick[0] !== 0 || stick[1] !== 0) &&
    currState.velocity[0] === 0 && currState.velocity[1] === 0;
  if (wallHit && !wallContactActive) sfx.wallCrash();
  wallContactActive = wallHit;
  view = game.view();
  trail.push({p: currState.processed, state: currState, view});
  if (trail.length > TRAIL_TICKS) trail.shift();
  session.active_ticks += currState.processed - t;
  lastActive = Date.now();
  // pl-v3 cycles the three base loops (R35.4): music and score voice follow the tick in the cycle.
  const beatTick = v3 ? t % V3_CYCLE_TICKS : t;
  if (!song.covering()) { music.beat(beatTick); voice.beat(beatTick, currState.lane); } // R46.2.7: an audible song replaces the synth score
  // pl-v3: shot, explosion and energy cues from the sim events (spec 26.4). pl-v2 keeps the W4c
  // R-2 path: a fire_ready rise across tick t is its [t, 3, code, shots] event (read-only rows).
  if (v3) voiceDeltas(prevState, currState, viewBefore, view);
  else sfx.tick(prevState, currState, WEAPONS);
  if (currState.status === 'ended') finishRun();
}

// ------------------------------------------------------------------ pickup overlay (spec 26.3.6, R39.3.1)
// One 2D canvas (id pickup-layer) stacked right after the game canvas, so it paints above it and
// below the HUD and touch controls; the same code path serves both renderer kinds (render.js stays
// untouched). Created on the run-start path, drawn only while a run is active, cleared every frame,
// one path fill per tier. Presentation only: it reads view/state/course rows, never inputs.
const PICKUP_SPRITES = Object.freeze({ // tier (tierOf names) -> [fill, half-size in CSS px]
  mineral_small: ['rgba(207,239,255,0.45)', 3],
  mineral_normal: ['rgba(207,239,255,0.7)', 4],
  mineral_large: ['rgba(207,239,255,1)', 5],
  gem: ['#ffd166', 4],
});
const PICKUP_TIERS = Object.keys(PICKUP_SPRITES);
// R45.4 visibility: every sprite drawn PICKUP_SCALE times its half-size, over a halo disc of
// HALO_SCALE times that size in the tier's own fill at HALO_ALPHA (so no new fill colour); a gem
// also gets a brighter rim stroke around its core.
const PICKUP_SCALE = 1.6, HALO_SCALE = 2, HALO_ALPHA = 0.3;
const GEM_RIM = '#fff4c7';
const DEFAULT_ROCK_SPEED = 3600; // mu per tick; render2d's speed for a rock it never saw in a view row
let pickupLayer = null, pickupCtx = null, pickupDirty = false, pickupWarned = false, pickupView = null;
// Rock id -> mu per tick, learned from view asteroid rows: a pickup keeps its rock's id and speed.
const pickupSpeed = new Map();

function ensurePickupLayer() {
  if (pickupLayer) return;
  const layer = document.createElement('canvas');
  layer.id = 'pickup-layer';
  layer.setAttribute('aria-hidden', 'true');
  // Same CSS box as canvas#canvas (lobby.css: fixed, full viewport); transparent and inert.
  Object.assign(layer.style, {position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
    display: 'block', background: 'transparent', pointerEvents: 'none'});
  $('canvas').after(layer); // the 2D fallback swap replaces #canvas in place; this sibling stays
  pickupLayer = layer;
  pickupCtx = layer.getContext('2d');
}

function syncPickupSpeeds(p) {
  if (view === pickupView) return;
  pickupView = view;
  const keep = new Set();
  for (const [id, , , z] of view.asteroids ?? []) {
    keep.add(id);
    const row = course[id];
    if (row && row[3] > p) pickupSpeed.set(id, z / (row[3] - p));
  }
  for (const e of view.pickups ?? []) keep.add(e?.[0]);
  for (const id of pickupSpeed.keys()) if (!keep.has(id)) pickupSpeed.delete(id);
}

// Ticks until the pickup's onset. A 7-field entry carries it (R39.3); a defensive 6-field entry
// (pre-TA-10 sim, whose sixth field is a depth) takes it from its rock's course row (same onset).
function pickupTicksLeft(e, p) {
  if (e.length >= 7) return e[5];
  const row = course[e[0]];
  return row ? row[3] - p : NaN;
}

// ------------------------------------------------------------------ WebGL ship anchor mirror (R44.2)
// render.js is frozen and publishes no ship screen point, so the overlay keeps an app-side copy of
// its ship transform (lane smoothing, chase camera, projection; render.js lines 620 to 890 read as
// the spec). frame() advances it once per renderer.draw call with the same rows (same real clock),
// and it is reset with the same setCourse. The track model, fovyFor and beatCues are render.js
// exports, so curve and cue math is shared, not copied; every duplicated constant cites its
// render.js line. docs/pm/runs/FB3-WEB8/scratch/mirror_check.mjs evaluates the block between the
// markers as is (no DOM) and checks it against render.js itself.
// SHIP-MIRROR-BEGIN
function createShipMirror() {
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x)); // render.js:58
  const lerp = (a, b, t) => a + (b - a) * t; // render.js:59
  const normalize = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; }; // render.js:226
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; // render.js:227
  let track = createTrack(null); // render.js:617
  let shipLaneF = 1, camLaneF = 1, camLaneVel = 0, shake = 0, effectTime = 0, lastNow = null; // render.js:624
  let lastView = null, lastProcessed = -1; // render.js:622
  let lastLane = null, lastFireReady = 0, lastLocked = false, endHandled = false; // render.js:625
  const cues = {surge: 0, bob: 0, fovKick: 0, pulse: 0}; // render.js:712
  const cA = [0, 0, 0], cB = [0, 0, 0], cBack = [0, 0, 0], cAhead = [0, 0, 0], cP = [0, 0, 0];
  // This frame's lookAt basis and focal terms, and the ship pose, written by advance().
  const cam = {ok: false, eye: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], fx: 1, fy: 1};
  const pose = {alive: false, laneF: 1, sShip: 0, sx: 0, sy: 0};

  // render.js:1019 setCourse: new track, resetRun (render.js:632 to 636), lanes back to 1. lastNow and
  // effectTime are not reset there either. camLaneVel is rederived every draw (render.js:793).
  function setCourse(map) {
    track = createTrack(map);
    lastView = null; lastProcessed = -1; shake = 0; // render.js:633, 634
    lastLane = null; lastFireReady = 0; lastLocked = false; endHandled = false; // render.js:635
    shipLaneF = camLaneF = 1; camLaneVel = 0; // render.js:1019
  }

  // The camera shake inputs of render.js syncView (render.js:650 to 708); the rest of it (asteroid,
  // rocket and beam bookkeeping) does not move the camera or the ship.
  function syncShake(view, p, prev, curr, trail, reduced) {
    if (!view || view === lastView) return; // render.js:651
    lastView = view; // render.js:652
    const rows = Array.isArray(trail) && trail.length ? trail : [{p, state: curr, view}]; // render.js:673
    if (!(curr && prev && curr.processed !== lastProcessed)) return; // render.js:679
    for (const entry of rows) { // render.js:682
      const s = entry?.state; // render.js:683
      if (!s || entry.p <= lastProcessed || !(s.fire_ready > lastFireReady)) continue; // render.js:684
      lastFireReady = s.fire_ready; // render.js:685
      const weapon = track.loops[track.loopAtTick(Math.max(0, entry.p - 1))]?.weapon ?? s.weapon; // render.js:686, 687
      if (!reduced) shake = Math.max(shake, weapon === 'laser' ? 0.05 : 0.12); // render.js:699
    }
    lastFireReady = Math.max(lastFireReady, curr.fire_ready); // render.js:701
    lastProcessed = curr.processed; // render.js:702
    if (lastLane !== null && curr.lane !== lastLane && !reduced) shake = Math.max(shake, 0.12); // render.js:703
    lastLane = curr.lane; // render.js:704
    const locked = curr.locked_until > curr.processed; // render.js:705
    if (locked && !lastLocked && !reduced) shake = Math.max(shake, 0.3); // render.js:706
    lastLocked = locked; // render.js:707
  }

  // One render.js draw (render.js:748 to 822) up to the camera; `aspect` is the WebGL canvas w / h.
  function advance(frame, reduced, aspect) {
    const now = Number.isFinite(frame.now) ? frame.now : performance.now(); // render.js:750
    const dtReal = lastNow === null ? 0 : clamp((now - lastNow) / 1000, 0, 0.1); // render.js:751
    lastNow = now; // render.js:752
    const dt = frame.paused ? 0 : dtReal; // render.js:753
    effectTime += dt; // render.js:754
    let T, sx = 0, sy = 0, vx = 0, lane = 1, alive = true; // render.js:760
    if (frame.curr) {
      const curr = frame.curr, prev = frame.prev ?? curr; // render.js:762
      const a = clamp(Number(frame.alpha) || 0, 0, 1); // render.js:763
      T = curr.processed - 2 + a; // render.js:764
      sx = lerp(prev.position[0], curr.position[0], a) / MU; // render.js:765
      sy = lerp(prev.position[1], curr.position[1], a) / MU; // render.js:766
      vx = lerp(prev.velocity[0], curr.velocity[0], a); // render.js:767
      lane = curr.lane; // render.js:768
      syncShake(frame.view, curr.processed, prev, curr, frame.trail, reduced); // render.js:769
      if (curr.status === 'ended' && !endHandled) { // render.js:770, 771
        endHandled = true;
        if (curr.terminal_reason === 'collision' && !reduced) shake = 1; // render.js:772, 775
      }
      if (curr.status === 'ended' && curr.terminal_reason === 'collision') alive = false; // render.js:780
    } else {
      T = (Number(frame.cruise) || 0) * 60; // render.js:782
      sx = Math.sin(T / 140) * 22; sy = Math.cos(T / 190) * 14 - 6; // render.js:784
    }
    const sShip = track.sAt(T); // render.js:786
    const kShip = 1 - Math.exp(-dtReal / 0.07), kCam = 1 - Math.exp(-dtReal / 0.15); // render.js:789
    shipLaneF += (lane - shipLaneF) * (dtReal > 0 ? kShip : 1); // render.js:790
    const before = camLaneF; // render.js:791
    camLaneF += (lane - camLaneF) * (dtReal > 0 ? kCam : 1); // render.js:792
    camLaneVel = dtReal > 0 ? (camLaneF - before) / dtReal : 0; // render.js:793
    beatCues(track.beatsAt(T), reduced, cues); // render.js:797
    const camBack = 38 - cues.surge; // render.js:798; CAM_BACK = 38 (render.js:22)
    track.centre(camLaneF, sShip - camBack, cBack); // render.js:802
    track.centre(camLaneF, sShip + 90, cAhead); // render.js:803; CAM_AHEAD = 90 (render.js:22)
    shake *= Math.exp(-dt * 4.5); // render.js:804
    const jx = reduced ? 0 : shake * 3.2 * Math.sin(effectTime * 41); // render.js:805
    const jy = reduced ? 0 : shake * 3.2 * Math.sin(effectTime * 37 + 1.3); // render.js:805
    const eye = cam.eye;
    eye[0] = cBack[0] + sx * 0.72 + jx; // render.js:806
    eye[1] = cBack[1] + sy * 0.72 + 15 + jy + cues.bob; // render.js:806, 799; CAM_UP = 15 (render.js:22)
    eye[2] = camBack; // render.js:806
    const shipY = Math.max(track.centre(shipLaneF, sShip, cA)[1], track.centre(lane, sShip, cB)[1]) + sy; // render.js:809
    eye[1] = Math.max(eye[1], shipY + 6); // render.js:810; CAM_MIN_ABOVE = 6 (render.js:26)
    const target = [cAhead[0] + sx * 0.45 + jx * 0.5, cAhead[1] + sy * 0.45 + 5 + jy * 0.5, -90]; // render.js:811
    const roll = reduced ? 0 : clamp(camLaneVel * 0.045 + vx / 3750 * 0.1, -0.3, 0.3); // render.js:812
    const [fx, fy, fz] = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]); // render.js:813
    // render.js:814 up = row 1 of axisAngle(fwd, roll) (render.js:255 to 258).
    const c = Math.cos(roll), s = Math.sin(roll), t = 1 - c;
    const up = [t * fx * fy - s * fz, t * fy * fy + c, t * fy * fz + s * fx];
    // render.js:819 lookAt basis (render.js:230, 231).
    cam.z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
    cam.x = normalize(cross(up, cam.z)); cam.y = cross(cam.z, cam.x);
    // render.js:816, 818 fovy and perspective focal terms (render.js:221, 223).
    const f = 1 / Math.tan((fovyFor(aspect) + cues.fovKick) / 2);
    cam.fx = f / aspect; cam.fy = f; cam.ok = true;
    pose.alive = alive; pose.laneF = shipLaneF; pose.sShip = sShip; pose.sx = sx; pose.sy = sy;
  }

  // World point -> overlay pixels: lookAt then perspective (render.js:220 to 236, 818 to 820) and
  // the viewport (0, 0, w, h) with y down. Null behind the eye (clip w = -view z, render.js:223).
  function project(px, py, pz, w, h) {
    const {eye, x, y, z} = cam, dx = px - eye[0], dy = py - eye[1], dz = pz - eye[2];
    const depth = -(z[0] * dx + z[1] * dy + z[2] * dz);
    if (!(depth > 1e-6)) return null;
    const nx = cam.fx * (x[0] * dx + x[1] * dy + x[2] * dz) / depth;
    const ny = cam.fy * (y[0] * dx + y[1] * dy + y[2] * dz) / depth;
    return [(nx + 1) * 0.5 * w, (1 - ny) * 0.5 * h];
  }
  // The point d world units ahead of the ship on its smoothed lane centreline at the ship's lateral
  // offset; d = 0 is shipPos (render.js:879 to 881), d > 0 the aim column as render.js:968 draws it.
  function aimPoint(d, w, h) {
    if (!cam.ok || !pose.alive) return null;
    track.centre(pose.laneF, pose.sShip + d, cP);
    return project(cP[0] + pose.sx, cP[1] + pose.sy, -d, w, h);
  }

  return {setCourse, advance, aimPoint, shipPoint: (w, h) => aimPoint(0, w, h),
    // The loop weapon a fire tick falls in (render.js:687 reads the same table from the same map);
    // null when no loop covers it, in which case render.js falls back to the row's state.weapon.
    fireWeaponAt: p => track.loops[track.loopAtTick(Math.max(0, p - 1))]?.weapon ?? null,
    lanes: () => ({shipLaneF, camLaneF, camLaneVel})};
}
// SHIP-MIRROR-END
const shipMirror = createShipMirror();

// ------------------------------------------------------------------ one laser visual under WebGL (R44.1)
// render.js (frozen) draws its own short laser stub, muzzle flash and fire shake on every fire_ready
// rise it reads in the trail rows (render.js lines 680 to 699). In a pl-v3 run the overlay ray is the
// laser, so the WebGL renderer gets a copy of the LASER trail rows whose state views pin fire_ready
// to 0: no rise, no stub. Rocket ticks stay unmasked (their beam, muzzle and shake are render.js's
// and stay), every other field and reference is the original (p, view with its asteroids and
// rockets, and every other state field), so rocket flight, hit flashes, explosions and the hop
// shake are unchanged. Trail rows are immutable, so each masked row is built once. A pl-v2 run
// keeps its rows: the stub is its only laser visual and the overlay draws no ray there.
const firelessRows = new WeakMap();
function firelessRow(row) {
  let out = firelessRows.get(row);
  if (!out) { out = {...row, state: row.state && {...row.state, fire_ready: 0}}; firelessRows.set(row, out); }
  return out;
}
function webglRows(rows) {
  if (runRuleset !== 'pl-v3' || !Array.isArray(rows.trail)) return rows;
  // Mask only the rows whose fire tick sits in a laser loop (render.js:687 weapon rule, same table
  // through the mirror). Rocket ticks keep their fire_ready rise: their orange beam, muzzle and
  // launch shake from render.js are untouched, and the rise also advances lastFireReady internally.
  return {...rows, trail: rows.trail.map(row => {
    const w = shipMirror.fireWeaponAt(row.p);
    return (w ?? row.state?.weapon) === 'laser' ? firelessRow(row) : row;
  })};
}
// The 2D fallback draws its own short stub on a fire_ready rise of its prev / curr pair and keeps it
// for a moment after a release (render2d.js:76, 239). R45.3 makes the released overlay ray fly away,
// so a laser rise is hidden from it (curr.fire_ready held at prev's); a rocket rise keeps its stub.
function fallbackRows(rows) {
  const {prev, curr} = rows;
  if (runRuleset !== 'pl-v3' || !prev || !curr || !(curr.fire_ready > prev.fire_ready) || curr.weapon !== 'laser') return rows;
  return {...rows, curr: {...curr, fire_ready: prev.fire_ready}};
}

// ------------------------------------------------------------------ laser ray (spec 27.4.2, R41.1, R43, R44, R45.3)
// Drawn on the pickup overlay before the pickups; the only laser visual of a pl-v3 run (R44.1).
// R45.3: while the sim reports an open beam the ray is ONE straight screen segment from the welded
// ship base toward the far point sampled when the beam opened, so it never bends with the track.
// When the beam closes (release or the energy law) the segment detaches and flies outward, fading.
// Every ray, held or flying, goes through strokeRay: BEAM_SEGMENTS core strokes whose alpha echoes
// the BEAM_TIERS damage decay, over one glow pass.
const BEAM_SEGMENTS = 12;
// Pinned red family (R43.2): core line + glow pass, matching the original laser stroke colour.
const BEAM_CORE = '#ff4d6a';
const BEAM_GLOW = 'rgba(255,77,106,0.35)';
// Depth alphas by BEAM_TIERS band (near full brightness; far fades like the damage does).
const BEAM_ALPHAS = Object.freeze([1, 0.7, 0.4]);
// R45.3 look: a thin translucent core over a wider glow (CSS px, times dpr when drawn).
const BEAM_CORE_ALPHA = 0.85, BEAM_CORE_W = 2, BEAM_GLOW_W = 5, BEAM_SPARK_R = 3;
// Tip spark alpha of a just-opened beam; it rises to 1 as the reach charges up to BEAM_R_MAX.
const SPARK_MIN_ALPHA = 0.3;
// R45.3 flight: a detached ray moves outward by reach / FLIGHT_STEPS per frame step (one step is
// one tick of wall time, so a 120 Hz screen flies as fast as a 60 Hz one) and its alpha falls
// linearly from 1 to 0 over FLIGHT_STEPS steps. At most FLIGHT_MAX are in the air; the oldest drop.
const FLIGHT_STEPS = 12, FLIGHT_MAX = 8;
function beamBand(z) {
  const i = BEAM_TIERS.findIndex(([dMax]) => z <= dMax);
  return Math.min(BEAM_ALPHAS.length - 1, i < 0 ? BEAM_ALPHAS.length - 1 : i);
}
// Foreshortening along the ray: the screen distance from the base at depth z (mu), as a fraction
// of the base-to-far-point vector. Rather than assuming a pinhole, the law is MEASURED from the
// renderer each frame: FOCAL_DEPTHS samples taken from the mirror (WebGL) or the cross-section
// pinhole (2D), interpolated piecewise linearly; between BEAM_R_MAX and 2 * BEAM_R_MAX the flying
// head keeps creeping outward (asymptotically, like a pinhole beyond the far point) until it fades.
// All points still lie on the frozen dir line, so the ray is straight by construction.
const BEAM_FAR = BEAM_R_MAX / MU, BEAM_MID = BEAM_TIERS[0][0] / MU;
const FOCAL_DEPTHS = Object.freeze([40000, BEAM_TIERS[0][0], BEAM_TIERS[1][0], BEAM_R_MAX, 2 * BEAM_R_MAX]);
const LAW_FAR_I = 3; // index of BEAM_R_MAX: the fraction normalizer (1 at full reach)
const depthFraction = (z, c) => (z / MU) * (c + BEAM_FAR) / ((c + z / MU) * BEAM_FAR);
// c of the cross-section pinhole (render2d FOCAL, read back through projectCross's scale).
const PINHOLE_C = (() => { const k = projectCross(1, 1, BEAM_MID, 0, 0)[2]; return k * BEAM_MID / (1 - k); })();
const pinholeLaw = () => ({rs: FOCAL_DEPTHS.map(d => depthFraction(d, PINHOLE_C))});
// Screen distances of the aim column at FOCAL_DEPTHS, relative to the base (WebGL) or to the
// cross-section near point (2D); monotone (a shake must not walk points back down the ray).
function measureLaw(w, h, base, X, Y) {
  const rs = [];
  // R45.3 (WEB9): every radius is measured from the welded base, not from the depth-0 projection.
  // rs[0] === 0 by construction, so lawFrac(law, 0) === 0 and the ray's first point IS the ship.
  // (Measuring from the depth-0 projection let a ~49 px base/projection offset leak into the first
  // point as rs[0]/far of spread: the beam visibly detached from the ship at long reach.)
  for (const d of FOCAL_DEPTHS) {
    let p = null;
    if (rendererKind === 'webgl2') p = shipMirror.aimPoint(d / MU, w, h);
    if (!p) p = projectCross(w, h, d, X, Y);
    rs.push(Math.hypot(p[0] - base[0], p[1] - base[1]));
  }
  for (let i = 1; i < rs.length; i++) if (!(rs[i] > rs[i - 1])) rs[i] = rs[i - 1];
  return rs[1] > 0 ? {rs} : pinholeLaw();
}
// Fraction of the base-to-far-point vector covered at depth z (mu); normalized at BEAM_R_MAX.
function lawFrac(law, z) {
  const rs = law.rs, far = rs[LAW_FAR_I];
  if (!(far > 0)) return 0;
  // R45.3 (WEB9): depth 0 is the welded base exactly. The interpolation grid starts at the first
  // focal depth (> 0), so without this clamp a negative extrapolation shifted the ray's first
  // point off the ship (the "beam not stucked" defect).
  if (!(z > 0)) return 0;
  const d = Math.min(Math.max(z, 0), FOCAL_DEPTHS[FOCAL_DEPTHS.length - 1]);
  let hi = 1; while (FOCAL_DEPTHS[hi] < d) hi++;
  const lo = hi - 1, t = (d - FOCAL_DEPTHS[lo]) / (FOCAL_DEPTHS[hi] - FOCAL_DEPTHS[lo]);
  return (rs[lo] + (rs[hi] - rs[lo]) * t) / far;
}

// The open beam ({aim: {dir, law}, reach}) and the detached flying segments ({base, dir, law, tail,
// head, speed, age}); base and dir are fractions of the overlay size so a resize keeps them in place.
let liveRay = null, flights = [], beamSeenP = -1, flightClock = null;
function resetBeams() { liveRay = null; flights = []; beamSeenP = -1; flightClock = null; }

// The ray base in overlay pixels (R44.2 anchor contract): the renderer's own ship position.
function beamBase(w, h, X, Y) {
  if (rendererKind === 'fallback2d' && shipAnchor[2] === 1) return [shipAnchor[0], shipAnchor[1]];
  if (rendererKind === 'webgl2') { const p = shipMirror.shipPoint(w, h); if (p) return p; }
  const [x, y] = projectCross(w, h, 0, X, Y);
  return [x, y];
}
// The ray's aim, sampled once per beam: the direction from the base toward where the aim column is
// at full reach right now, and the foreshortening c along it. Under WebGL the far point is the
// mirrored render.js camera's view of the tube; otherwise (or if that point is behind the camera)
// the cross-section pinhole's, shifted onto the base.
function beamAim(w, h, base, X, Y) {
  let far = rendererKind === 'webgl2' ? shipMirror.aimPoint(BEAM_FAR, w, h) : null;
  if (!far) {
    const near = projectCross(w, h, 0, X, Y), end = projectCross(w, h, BEAM_FAR, X, Y);
    far = [base[0] + end[0] - near[0], base[1] + end[1] - near[1]];
  }
  return {dir: [(far[0] - base[0]) / w, (far[1] - base[1]) / h], law: measureLaw(w, h, base, X, Y)};
}

// Walks the tick rows the overlay has not seen yet, so a beam that opens and closes between two
// frames still flies. A shorter reach on an open row means a new beam opened after a close.
function syncBeams(w, h, base, X, Y) {
  const detach = () => {
    if (!liveRay) return;
    const {dir, law} = liveRay.aim ?? beamAim(w, h, base, X, Y);
    flights.push({base: [base[0] / w, base[1] / h], dir, law, tail: 0, head: liveRay.reach, speed: liveRay.reach / FLIGHT_STEPS, age: 0});
    if (flights.length > FLIGHT_MAX) flights.splice(0, flights.length - FLIGHT_MAX);
    liveRay = null;
  };
  for (const row of trail) {
    if (!(row.p > beamSeenP)) continue;
    beamSeenP = row.p;
    const reach = row.state?.beam_hold === 1 ? Number(row.state.beam_reach) || 0 : 0;
    if (liveRay && reach > 0 && reach < liveRay.reach) detach();
    if (reach > 0) (liveRay ??= {aim: null, reach: 0}).reach = reach;
    else detach();
  }
  if (liveRay && !liveRay.aim) liveRay.aim = beamAim(w, h, base, X, Y);
}

// Frame steps since the last overlay draw; 0 while paused, so a paused flight holds still.
function flightSteps(now) {
  const last = flightClock;
  flightClock = now;
  if (last === null || !Number.isFinite(now) || pause.isPaused()) return 0;
  return Math.min(4, Math.max(0, (now - last) / TICK_MS));
}

// One straight ray from depth tail to depth head (mu): every point is base + dir * fraction, so all
// BEAM_SEGMENTS + 1 points lie on one line by construction.
function strokeRay(ctx, w, h, dpr, base, {dir, law}, tail, head, alpha, sparkAlpha) {
  const pts = [];
  for (let i = 0; i <= BEAM_SEGMENTS; i++) {
    const f = lawFrac(law, tail + (head - tail) * i / BEAM_SEGMENTS);
    pts.push([base[0] + dir[0] * w * f, base[1] + dir[1] * h * f]);
  }
  ctx.lineJoin = 'round';
  // Glow (R43.2, width per R45.3): one pass along the core's own line, a halo around the core.
  ctx.globalAlpha = alpha; ctx.lineCap = 'round';
  ctx.strokeStyle = BEAM_GLOW; ctx.lineWidth = BEAM_GLOW_W * dpr;
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i <= BEAM_SEGMENTS; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  // Core: one stroke per segment. The core is always translucent now (R45.3), so butt caps keep
  // neighbours abutting instead of blending a bright bead into every joint.
  ctx.strokeStyle = BEAM_CORE; ctx.lineWidth = BEAM_CORE_W * dpr; ctx.lineCap = 'butt';
  for (let i = 0; i < BEAM_SEGMENTS; i++) {
    ctx.globalAlpha = alpha * BEAM_CORE_ALPHA * BEAM_ALPHAS[beamBand(tail + (head - tail) * (i + 0.5) / BEAM_SEGMENTS)];
    ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[i + 1][0], pts[i + 1][1]); ctx.stroke();
  }
  ctx.globalAlpha = alpha * sparkAlpha;
  ctx.fillStyle = BEAM_CORE;
  ctx.beginPath(); ctx.arc(pts[BEAM_SEGMENTS][0], pts[BEAM_SEGMENTS][1], BEAM_SPARK_R * dpr, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}

function drawBeam(ctx, w, h, dpr, now) {
  const s = currState;
  const a = Math.min(1, Math.max(0, accumulator / TICK_MS));
  const from = prevState?.position ?? s.position;
  const X = (from[0] + (s.position[0] - from[0]) * a) / MU;
  const Y = (from[1] + (s.position[1] - from[1]) * a) / MU;
  const base = beamBase(w, h, X, Y);
  const steps = flightSteps(now);
  for (const f of flights) { f.tail += f.speed * steps; f.head += f.speed * steps; f.age += steps; }
  flights = flights.filter(f => f.age < FLIGHT_STEPS && f.tail <= BEAM_R_MAX);
  syncBeams(w, h, base, X, Y);
  // The held ray first, so the first moveTo of the frame stays the welded base (R43.3).
  if (liveRay && s.beam_hold === 1 && Number(s.beam_reach) > 0) {
    // Reach is interpolated like the renderers' ship; it grows from 0 on the opening tick, so the
    // ray extends out of the ship instead of stepping in a tick at a time.
    const reachFrom = prevState?.beam_hold === 1 ? Number(prevState.beam_reach) || 0 : 0;
    const reach = reachFrom + (Number(s.beam_reach) - reachFrom) * a;
    // The tip spark brightens with charge, so a held beam visibly charges.
    // PM fix (R45.3 harvest): the direction stays frozen at beam start (that is the straight law),
    // but the foreshortening law is refitted every frame so the tip tracks the moving camera.
    // The law only spreads points along the frozen line, so refitting it cannot bend the ray.
    const aim = {dir: liveRay.aim.dir, law: measureLaw(w, h, base, X, Y)};
    strokeRay(ctx, w, h, dpr, base, aim, 0, reach, 1, SPARK_MIN_ALPHA + (1 - SPARK_MIN_ALPHA) * Math.min(1, reach / BEAM_R_MAX));
  }
  for (const f of flights) strokeRay(ctx, w, h, dpr, [f.base[0] * w, f.base[1] * h], f, f.tail, f.head, 1 - f.age / FLIGHT_STEPS, 1);
}

function drawPickups(now) {
  if (!pickupCtx) return;
  const ctx = pickupCtx;
  if (!(running && currState?.status === 'running')) { // lobby, game over, abandoned: nothing drawn
    resetBeams(); // nothing keeps flying into the next run
    if (pickupDirty) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, pickupLayer.width, pickupLayer.height); pickupDirty = false; }
    return;
  }
  const dpr = Math.min(globalThis.devicePixelRatio || 1, settingsNow().quality === 'low' ? 1 : 2);
  const w = Math.max(1, Math.round((pickupLayer.clientWidth || pickupLayer.width) * dpr));
  const h = Math.max(1, Math.round((pickupLayer.clientHeight || pickupLayer.height) * dpr));
  if (pickupLayer.width !== w || pickupLayer.height !== h) { pickupLayer.width = w; pickupLayer.height = h; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  pickupDirty = true;
  drawBeam(ctx, w, h, dpr, now); // R41.1: the ray first, so minerals paint over it
  const list = view?.pickups;
  if (!Array.isArray(list) || list.length === 0) return;
  const p = currState.processed, shipLane = currState.lane;
  // Both renderers present asteroids at T = processed - 2 + alpha; view rows are for tick processed.
  const lag = 2 - Math.min(1, Math.max(0, accumulator / TICK_MS));
  syncPickupSpeeds(p);
  const byTier = {};
  for (const e of list) {
    if (!Array.isArray(e) || e.length < 6) continue;
    const [id, kind, lane, x, y] = e;
    // A 6-field entry (no amount) renders at normal brightness; unknown kinds are not drawn.
    const tier = tierOf(kind, e.length >= 7 && Number.isFinite(e[6]) ? e[6] : MINERAL_NORMAL);
    const ticks = pickupTicksLeft(e, p);
    if (!tier || !Number.isFinite(ticks) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = (ticks + lag) * (pickupSpeed.get(id) ?? DEFAULT_ROCK_SPEED) / MU;
    const [sx, sy] = projectCross(w, h, d, x / MU + (lane - shipLane) * LANE_SPACING, y / MU);
    const s = PICKUP_SPRITES[tier][1] * PICKUP_SCALE * dpr, halo = s * HALO_SCALE;
    if (sx < -halo || sy < -halo || sx > w + halo || sy > h + halo) continue;
    (byTier[tier] ??= []).push(sx, sy, s);
  }
  for (const tier of PICKUP_TIERS) {
    const pts = byTier[tier];
    if (!pts) continue;
    ctx.fillStyle = PICKUP_SPRITES[tier][0];
    // Halo first, one path per tier, so the solid core paints over it.
    ctx.globalAlpha = HALO_ALPHA;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], r = pts[i + 2] * HALO_SCALE;
      ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 3) { // diamond: a square rotated 45 degrees
      const x = pts[i], y = pts[i + 1], s = pts[i + 2];
      ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath();
    }
    ctx.fill();
    if (tier === 'gem') { ctx.strokeStyle = GEM_RIM; ctx.lineWidth = dpr; ctx.lineJoin = 'round'; ctx.stroke(); }
  }
}

// ------------------------------------------------------------------ frame loop
function frame(timestamp) {
  song.sync({now: timestamp, running, paused: pause.isPaused(), hidden: document.hidden, muted: settingsNow().mute});
  sfx.frame(); // R54: refill the hop/boost/wallCrash/gameOverBoom burst budget once per frame
  if (running && !pause.isPaused() && !document.hidden) {
    if (previousFrame !== null) accumulator += Math.min(MAX_FRAME_MS, Math.max(0, timestamp - previousFrame));
    previousFrame = timestamp;
    while (accumulator >= TICK_MS && running) { tickOnce(); accumulator -= TICK_MS; }
  } else previousFrame = null;
  const ended = currState?.status === 'ended';
  const rows = currState
    ? {prev: prevState, curr: currState, alpha: ended ? 1 : accumulator / TICK_MS, view, trail, paused: pause.isPaused() || !running, now: timestamp}
    : {cruise: timestamp / 1000, now: timestamp};
  const drawRows = rendererKind === 'webgl2' ? webglRows(rows) : fallbackRows(rows); // R44.1, R45.3
  try { renderer.draw(drawRows); }
  catch (err) {
    if (rendererKind === 'webgl2') { console.warn('WebGL2 draw failed, switching to the 2D fallback:', err?.message ?? err); useFallback('lost'); }
  }
  // Spec 26.3.6: pickups on the overlay, after the game canvas frame (either renderer kind). R44.2:
  // under WebGL the ship mirror first takes the same rows the renderer just drew.
  try {
    if (rendererKind === 'webgl2') {
      const glCanvas = $('canvas');
      shipMirror.advance(drawRows, Boolean(settingsNow().reduced_motion), glCanvas.width / glCanvas.height);
    }
    drawPickups(timestamp);
  }
  catch (err) { if (!pickupWarned) { pickupWarned = true; console.warn('Pickup overlay draw failed:', err?.message ?? err); } }
  // W4c R-1: HUD DOM writes only when a tick produced a new state row, not on every frame.
  // R45.5: the LASER meter's capacity is the one the sim was created with (runShip = shipId at start).
  if (currState && currState !== hudState) { renderHud(document, currState, scoreMap, {shipId: runShip}); hudState = currState; }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ controls (spec 6.1)
const stickEl = $('stick'), knob = stickEl.querySelector('.knob');
function stickCentre() { const r = stickEl.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
function setStickFromPointer(event) {
  const [x, y] = stickOrigin || stickCentre();
  const dx = event.clientX - x, dy = event.clientY - y, m = Math.hypot(dx, dy), k = m > MAX_RADIUS_PX ? MAX_RADIUS_PX / m : 1;
  touchStick = quantizeStick(dx * k, dy * k, MAX_RADIUS_PX);
  knob.style.setProperty('--kx', `${dx * k}px`); knob.style.setProperty('--ky', `${dy * k}px`);
}
function releaseStick() {
  stickPointer = null; touchStick = [0, 0]; stickOrigin = null;
  knob.style.setProperty('--kx', '0px'); knob.style.setProperty('--ky', '0px');
}
// Spec 26.1.2: the single stick pointer is captured by a pointerdown on the thumbpad (within the
// capture radius, as before) or anywhere on the game canvas. A pointerdown on any button (fire,
// boost, hops, ammo badge, pause) never captures: those keep their own handlers.
document.addEventListener('pointerdown', event => {
  unlockAudio();
  if (!running || stickPointer !== null) return;
  if (event.target?.closest?.('button')) return;
  const [x, y] = stickCentre();
  const onCanvas = event.target === $('canvas'); // looked up live: the 2D fallback swaps the element
  if (!onCanvas && Math.hypot(event.clientX - x, event.clientY - y) > CAPTURE_RADIUS_PX) return;
  stickPointer = event.pointerId;
  // Spec 26.1.2 (R38.6): a canvas press outside the pad capture radius uses the press point
  // as the virtual pad centre; a pad-internal drag keeps measuring from the pad centre.
  stickOrigin = onCanvas && Math.hypot(event.clientX - x, event.clientY - y) > CAPTURE_RADIUS_PX
    ? [event.clientX, event.clientY] : null;
  setStickFromPointer(event);
  event.preventDefault();
});
document.addEventListener('pointermove', event => { if (event.pointerId === stickPointer) setStickFromPointer(event); });
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, event => { if (event.pointerId === stickPointer) releaseStick(); });
// R-2 (R35.9): the round boost button (charge ring) joins the cluster; hud.js paints its state.
buildControls(document);
for (const [id, kind] of [['hop-left', 'left'], ['hop-right', 'right'], ['boost', 'boost']]) {
  const button = $(id);
  button.addEventListener('pointerdown', event => { event.preventDefault(); press(kind); });
  button.addEventListener('click', event => { if (event.detail === 0) press(kind); }); // keyboard activation only
}
// R41.3: the fire button drives the fire LEVEL: pointerdown holds, pointerup / pointercancel of the
// same pointer releases (also when it lifts off the button, via the document listener below).
const fireButton = $('fire');
fireButton.addEventListener('pointerdown', event => { event.preventDefault(); press('fire'); firePointer = event.pointerId; });
for (const type of ['pointerup', 'pointercancel']) fireButton.addEventListener(type, () => liftFire());
// Keyboard activation only: a tap (press, then release; the release goes out one tick later).
fireButton.addEventListener('click', event => { if (event.detail === 0) { press('fire'); liftFire(); } });
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, event => { if (firePointer !== null && event.pointerId === firePointer) liftFire(); });
// Ammo badge = mobile rocket-latch toggle (spec 26.2.3), same press pattern as the cluster buttons.
const ammoBadge = $('hud-ammo');
if (ammoBadge) {
  ammoBadge.addEventListener('pointerdown', event => { event.preventDefault(); toggleRocketLatch(); });
  ammoBadge.addEventListener('click', event => { if (event.detail === 0) toggleRocketLatch(); }); // keyboard activation only
}
setRocketLatch(false);
// Spec 26.1.1: WASD no longer steers (steering is pointer only, 26.1.2); no key feeds the stick.
const STICK_KEYS = Object.freeze({});
// Spec 26.1.1 / 26.1.3: one-shot presses through press(), exactly like the touch buttons.
const PRESS_KEYS = Object.freeze({KeyA: 'left', KeyD: 'right', KeyW: 'boost'});
document.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || lobby.open || gameOver.isOpen()) return;
  if (STICK_KEYS[event.code]) { held[STICK_KEYS[event.code]] = true; return; }
  if (event.repeat) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); press(event.key === 'ArrowLeft' ? 'left' : 'right'); }
  else if (event.code === 'Space') { event.preventDefault(); press('fire'); } // level 1 until keyup (R41.3)
  else if (event.code === 'KeyB' || event.key === 'b' || event.key === 'B') { event.preventDefault(); press('boost'); }
  else if (event.ctrlKey || event.metaKey || event.altKey) return; // browser shortcuts (reload, close tab) stay theirs
  else if (PRESS_KEYS[event.code]) { event.preventDefault(); press(PRESS_KEYS[event.code]); }
  else if (event.code === 'KeyR') { event.preventDefault(); toggleRocketLatch(); }
});
document.addEventListener('keyup', event => {
  if (STICK_KEYS[event.code]) held[STICK_KEYS[event.code]] = false;
  if (event.code === 'Space') liftFire(); // R41.3: keyup drops the fire level (never gated)
});
window.addEventListener('blur', () => { for (const k of Object.keys(held)) held[k] = false; releaseStick(); releaseFire(); });

// ------------------------------------------------------------------ lobby buttons and save management
function download(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function replaceSave(text) {
  const result = importSave(text);
  if (!result.ok) return notice(`Save was not changed: ${result.code}.`);
  endSession(); save = forceSettingsDefaults(result.state); game = null; recorded = false; lastRun = null;
  applySettingsToOutputs();
  persist(); notice('Save loaded. Settings and run history restored.');
}
// Play = new seed: the unplayed seed shown in the lobby, then a fresh one for the next Play.
$('play').onclick = () => { const next = seed; seed = randomSeed(); start(next); };
$('retry').onclick = () => { if (retryEnabled({lastSeed})) start(lastSeed); };
$('save').onclick = () => persist();
$('load').onclick = () => {
  try { const text = localStorage.getItem(STORAGE_KEY); if (text !== null) replaceSave(text); else notice('No local save yet.'); }
  catch { notice('Local storage is unavailable. Import a save file instead.'); }
};
$('export').onclick = () => { if (save) download('pulse-lanes-save.json', exportSave(save)); };
$('replay').onclick = () => { if (typeof game?.replayBytes === 'function' && game.state().status === 'ended') download(`pulse-lanes-${lastSeed}.replay`, game.replayBytes()); };
$('import').onchange = async event => {
  const file = event.target.files[0];
  if (file) {
    try { replaceSave(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(await file.arrayBuffer())); }
    catch { notice('Save was not changed: invalid_json.'); }
  }
  event.target.value = '';
};
$('reset').onclick = () => {
  if (save && !confirm('Start an empty save? Export first if you want to keep your history.')) return;
  endSession(); save = forceSettingsDefaults(newSave(crypto.randomUUID())); game = null; lastRun = null;
  applySettingsToOutputs();
  persist(); notice('New empty save created.');
};

document.addEventListener('pointerdown', () => unlockAudio());
// R49.3 (AU-9): stick drags and swipes fire touch events; on mobile engines touchstart/touchend are
// the user-activation triggers, so unlock must ride them too, not just pointerdown/keydown.
document.addEventListener('touchstart', () => unlockAudio(), {passive: true});
document.addEventListener('click', () => { if (running && !pause.isPaused()) unlockAudio(); });
document.addEventListener('keydown', () => unlockAudio());
document.addEventListener('visibilitychange', () => {
  previousFrame = null; accumulator = 0;
  if (document.hidden) { music.quiet(); song.pause(); scanner?.close(); } // a hidden page never keeps the camera open
  else if (session && Date.now() - lastActive >= IDLE_MS) { endSession(); openLobbyUnlessGameOver(); }
});
window.addEventListener('pagehide', () => { scanner?.close(); endSession(); });
setInterval(() => {
  if (session && Date.now() - lastActive >= IDLE_MS) { endSession(); openLobbyUnlessGameOver(); notice('Session ended after five minutes without active play.'); }
}, 1000);

// ------------------------------------------------------------------ boot
try {
  const text = localStorage.getItem(STORAGE_KEY);
  if (text === null) save = forceSettingsDefaults(newSave(crypto.randomUUID()));
  else {
    const result = importSave(text);
    if (result.ok) save = forceSettingsDefaults(result.state);
    else notice(`Existing save was not changed: ${result.code}.`);
  }
} catch { save = forceSettingsDefaults(newSave(crypto.randomUUID())); notice('Local storage unavailable. Use Export save to keep your runs.'); }
if (save) persist(); // R50.3: the forced-defaults migration rewrites storage, not just memory
shipId = runShip = loadShip(); // before the renderer exists, so the first frame shows the chosen ship
buildShipPicker();
modeId = loadMode();
buildModePicker();
loadSongPrefs();
buildSongTile();
buildSongCreditsStrip();
buildLobbyV2(); // R50
buildChallengeUi();
initRenderer();
// Lobby backdrop: the course of the shown seed, cruising without asteroids (presentation only).
map = scoreMap = createGame(seed).map();
renderer.setCourse(map, []);
if (rendererKind === 'webgl2') shipMirror.setCourse(map); // R44.2: the backdrop course too
applySettingsToOutputs();
openLobby();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then(reg => { if (reg) reg.update(); return navigator.serviceWorker.ready; }) // R49: check for a new build on every boot
    .then(() => { if (!$('notice').textContent) notice('Offline build cached. You can play without a connection.'); })
    .catch(() => notice('Offline cache unavailable. Keep the local static server running to reload.'));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // R49: the cache-first fetch handler pins the running page to its worker's assets, so adopting
    // a new build requires a reload; never interrupt a live run, a pause, or the game-over read.
    if (running || pause.isPaused() || gameOver.isOpen()) { pendingReload = true; return; }
    location.reload();
  });
}
if (typeof caches !== 'undefined') caches.keys().then(keys => {
  const key = keys.find(k => k.indexOf('pulse-lanes-pl-web-') === 0); // R49: visible build stamp
  const stamp = key ? key.slice(key.lastIndexOf('-') + 1) : 'no-cache';
  let tag = $('build-tag');
  if (!tag) {
    tag = document.createElement('span');
    tag.id = 'build-tag';
    document.body.appendChild(tag);
  }
  tag.textContent = stamp;
}).catch(() => {});
// R49.2: ?dbg telemetry overlay - a silent failure must never be invisible again.
if (/[?&]dbg/.test(globalThis.location?.search ?? '')) {
  const pre = document.createElement('pre');
  pre.id = 'dbg';
  pre.style.cssText = 'position:fixed;left:6px;top:6px;z-index:9;margin:0;font:10px/1.35 monospace;color:#9fe;background:rgba(4,6,12,.82);padding:6px 8px;max-width:96vw;pointer-events:none;white-space:pre-wrap';
  document.body.appendChild(pre);
  const taps = [];
  window.addEventListener('pointerdown', () => { taps.unshift('tap ' + new Date().toISOString().slice(11, 19)); if (taps.length > 3) taps.pop(); }, {passive: true});
  const render = () => {
    try {
      const i = music.inspect();
      pre.textContent = [`ctx ${i.contextState} ready ${i.ready} unlocked ${i.unlocked} pending ${i.unlockPending}`,
        `quiet ${i.quietMode} susp ${i.suspensions} muted ${i.muted} err ${i.unlockError ?? '-'}`,
        `song ${song.state} run ${running} paused ${pause.isPaused()}`,
        ...taps, ...music.evLog.slice(-10).map(e => e.join(' ')).reverse()].join('\n');
    } catch (err) { pre.textContent = 'dbg ' + String(err); }
  };
  setInterval(render, 250);
  render();
}

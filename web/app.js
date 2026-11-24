// Client loop. The only module that calls step/abandon on the game. Renderers, HUD,
// lobby and audio receive read-only rows (map, course, state snapshots, view) from here.
// New runs play pl-v3 (spec 21, ruling R35) in the lobby mode; the pl-v2 module stays for the
// lobby backdrop, the shared tunnel geometry and a legacy (v1 challenge) pl-v2 run path.
import {createGame, TICKS_PER_SECOND, MAX_TICKS, WEAPONS} from '../src/sim/space_racer.js';
import {createGame as createGameV3, loopCourse, loopStart, BEAM_TIERS, MINERAL_NORMAL, MODES, MODE_TICKS, validateInputs as validateInputsV3} from '../src/sim/space_racer_v3.js';
import {newSave, importSave, exportSave, STORAGE_KEY} from '../src/state/pilot_state.js';
import {quantizeStick, keyboardStick, MAX_RADIUS_PX, CAPTURE_RADIUS_PX} from '../src/input/controls.js';
import {digest} from './digest.js';
import {Music} from './music.js';
import {ScoreVoice} from './score_voice.js';
import {Sfx} from './sfx.js';
import {renderHud, buildControls, formatKm, MODE_LABELS, paintRocketLatch} from './hud.js';
import {createPause} from './pause.js';
import {applySetting, defaultSettings, lastResultText, retryEnabled, SETTING_CONTROLS} from './lobby_model.js';
import {createRenderer, LANE_SPACING, MU} from './render.js';
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
let save = null, session = null, game = null, map = null, course = [], view = EMPTY_VIEW;
let prevState = null, currState = null, hudState = null, lastRun = null, lastSeed = null, seed = randomSeed();
let running = false, recorded = false, accumulator = 0, previousFrame = null, lastActive = Date.now();
// Spec 27.4.1 / R41.3: fire is a LEVEL (fireHeld 0 or 1), not a tap queue. lastSent keeps the
// last entry's [sx, sy, fire level]; the level persists in the sim without entries (27.1.1).
// fireTap / fireRepress: pending edges kept for the next tick (holdFire / liftFire below).
let hops = [], fireHeld = 0, fireTap = false, fireRepress = false, firePointer = null, boosts = 0, lastSent = [0, 0, 0];
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
function showRendererKind() { $('renderer-kind').textContent = rendererKind; }
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
  pause.runEnded();
  music.quiet();
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
  const s = settingsNow();
  $('set-music-level').value = String(s.music_level);
  $('set-music-level-value').textContent = String(s.music_level);
  $('set-mute').checked = s.mute;
  $('set-quality').value = s.quality;
  $('set-reduced-motion').checked = s.reduced_motion;
  if (!save) { $('history').textContent = 'Save could not be loaded. Import a valid save or choose New empty save.'; return; }
  const best = save.runs.reduce((score, run) => run.ruleset_id === 'pl-v2' && run.terminal_reason !== 'abandoned' ? Math.max(score, run.score) : score, 0);
  $('history').textContent = `${save.runs.length} recorded runs · Best: ${best} / ${MAX_TICKS} ticks`;
}
function openLobby() {
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
  lobby.querySelector('.launch').after(section);
  showShip();
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
  launch.append(b);
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
  music.setLevel(s.music_level);
  music.setMute(s.mute);
  renderer?.setSettings({quality: s.quality, reduced_motion: s.reduced_motion});
}
function changeSetting(key, raw) {
  if (!save) return;
  const result = applySetting(save.settings, key, raw);
  if (result.ok && result.persist) { save.settings = result.settings; persist(); }
  applySettingsToOutputs();
  updateLobby();
}
$(SETTING_CONTROLS.music_level).addEventListener('input', event => changeSetting('music_level', event.target.value));
$(SETTING_CONTROLS.mute).addEventListener('change', event => { music.gesture(); changeSetting('mute', event.target.checked); });
$(SETTING_CONTROLS.quality).addEventListener('change', event => changeSetting('quality', event.target.value));
$(SETTING_CONTROLS.reduced_motion).addEventListener('change', event => changeSetting('reduced_motion', event.target.checked));

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
    game = createGameV3(nextSeed, runMode);
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
  accumulator = 0; previousFrame = null; eventCursor = 0;
  setRocketLatch(false); // a run starts on the laser (ammo starts at 0)
  music.reset(); voice.setMap(scoreMap);
  beginSession(); music.gesture(); persist();
  renderer.setCourse(map, course);
  runShip = shipId; renderer.setShip?.(runShip);
  runSettings = {...settingsNow()};
  applySettingsToOutputs();
  pause.runStarted();
  ensurePickupLayer(); // R39.3.1: the overlay is created on the run-start path, never at import
  pickupSpeed.clear(); pickupView = null;
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
  onPause: () => { accumulator = 0; previousFrame = null; music.quiet(); },
  onResume: () => { accumulator = 0; previousFrame = null; lastActive = Date.now(); music.gesture(); },
  onExit: () => { endSession(); openLobby(); },
});

// ------------------------------------------------------------------ input sampling (spec 6.4)
function currentStick() { return stickPointer !== null ? touchStick : keyboardStick(held); }
function press(kind) {
  music.gesture();
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
function toggleRocketLatch() { music.gesture(); setRocketLatch(!rocketLatch); }
// Spec 26.4.1 cue wiring: voice the pl-v3 events produced since the last call. A tick can carry an
// accepted fire [t, 3, code, shots] only when fire_ready rises and a destroying event only when
// destroyed rises, so the trace is read on those ticks alone. Refusals [t, 6, 1] / [t, 6, 2] are
// 3 fields long; the destroying event is [t, 6, id, code, pickup_kind, amount] (R38.4), and a
// 4-field [t, 6, id, code] from a pre-26.3 sim still voices the explosion.
// R38.7 (FB3-REV4 E-1): the frozen pl-v3 destroying event encodes the pickup as numeric
// kind 1 (mineral) / 2 (gem) plus an amount (NOTE 27). sfx.energy speaks tier names, so
// derive the tier from the shipped tuple here in the bridge (the oracle stays authoritative).
function pickupTier(kind, amount) {
  if (kind === 2) return 'gem';
  if (kind !== 1) return null;
  return amount >= 50 ? 'mineral_large' : amount >= 25 ? 'mineral_normal' : 'mineral_small';
}
function voiceEvents(prev, curr) {
  if (!(curr.fire_ready > prev.fire_ready || curr.destroyed > prev.destroyed)) return;
  const events = game.trace().events;
  const hits = [];
  for (let i = eventCursor; i < events.length; i++) {
    const e = events[i];
    if (e[1] === 5 && e.length === 4) hits.push(e); // [t, 5, id, hp_left] hit (R41.4 burst strength)
    if (e[1] === 3 && e.length === 4) sfx.fire(e[2]);
    else if (e[1] === 6 && e.length >= 4) {
      const [, , , , pickupKind, amount] = e;
      sfx.destroyed(e.length === 6 && Number.isInteger(pickupKind) && Number.isInteger(amount) ? pickupTier(pickupKind, amount) : null);
    }
  }
  eventCursor = events.length;
  // Before the next draw syncs the new view, so the renderer still holds each rock's prior hp.
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
  currState = game.step(1, entries);
  if (v3) {
    ensureCourse(currState.loop);
    if (currState.boost_until > prevState.boost_until) runBoosts++; // boost_until moves only on a boost
  }
  view = game.view();
  trail.push({p: currState.processed, state: currState, view});
  if (trail.length > TRAIL_TICKS) trail.shift();
  session.active_ticks += currState.processed - t;
  lastActive = Date.now();
  // pl-v3 cycles the three base loops (R35.4): music and score voice follow the tick in the cycle.
  const beatTick = v3 ? t % V3_CYCLE_TICKS : t;
  music.beat(beatTick);
  voice.beat(beatTick, currState.lane);
  // pl-v3: shot, explosion and energy cues from the sim events (spec 26.4). pl-v2 keeps the W4c
  // R-2 path: a fire_ready rise across tick t is its [t, 3, code, shots] event (read-only rows).
  if (v3) voiceEvents(prevState, currState);
  else sfx.tick(prevState, currState, WEAPONS);
  if (currState.status === 'ended') finishRun();
}

// ------------------------------------------------------------------ pickup overlay (spec 26.3.6, R39.3.1)
// One 2D canvas (id pickup-layer) stacked right after the game canvas, so it paints above it and
// below the HUD and touch controls; the same code path serves both renderer kinds (render.js stays
// untouched). Created on the run-start path, drawn only while a run is active, cleared every frame,
// one path fill per tier. Presentation only: it reads view/state/course rows, never inputs.
const PICKUP_SPRITES = Object.freeze({ // tier (pickupTier names) -> [fill, half-size in CSS px]
  mineral_small: ['rgba(207,239,255,0.45)', 3],
  mineral_normal: ['rgba(207,239,255,0.7)', 4],
  mineral_large: ['rgba(207,239,255,1)', 5],
  gem: ['#ffd166', 4],
});
const PICKUP_TIERS = Object.keys(PICKUP_SPRITES);
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

// ------------------------------------------------------------------ laser ray (spec 27.4.2, R41.1, restyled by R43)
// Drawn on the pickup overlay before the pickups, only while the run is active and the sim reports
// an open beam (state().beam_hold === 1). R43 (owner playtest): the original 2d renderer's laser
// look (web/render2d.js ship laser, '#ff4d6a'), stretched to the live beam reach. BEAM_SEGMENTS
// line segments run from the ship (projectCross at z = 0, no world nose lift) to the reach point
// along the aim column; each segment's alpha echoes the BEAM_TIERS damage decay.
const BEAM_SEGMENTS = 12;
// Pinned red family (R43.2): core line + glow pass, matching the original laser stroke colour.
const BEAM_CORE = '#ff4d6a';
const BEAM_GLOW = 'rgba(255,77,106,0.35)';
// Depth alphas by BEAM_TIERS band (near full brightness; far fades like the damage does).
const BEAM_ALPHAS = Object.freeze([1, 0.7, 0.4]);
function beamBand(z) {
  const i = BEAM_TIERS.findIndex(([dMax]) => z <= dMax);
  return Math.min(BEAM_ALPHAS.length - 1, i < 0 ? BEAM_ALPHAS.length - 1 : i);
}

function drawBeam(ctx, w, h, dpr) {
  const s = currState;
  if (!(running && s?.status === 'running' && s.beam_hold === 1)) return;
  const reach = Number(s.beam_reach);
  if (!(reach > 0)) return;
  // Aim point (interpolated like the renderers' ship). The beam row is the ship's own lane, so the
  // lane term of the pickup form x / MU + (lane - shipLane) * LANE_SPACING is zero here.
  const a = Math.min(1, Math.max(0, accumulator / TICK_MS)), from = prevState?.position ?? s.position;
  const X = (from[0] + (s.position[0] - from[0]) * a) / MU;
  const Y = (from[1] + (s.position[1] - from[1]) * a) / MU;
  const pts = [];
  for (let i = 0; i <= BEAM_SEGMENTS; i++) {
    const f = i / BEAM_SEGMENTS;
    pts.push(projectCross(w, h, f * reach / MU, X, Y));
  }
  // R43.3 anchor: weld the base to the sprite. The 2D renderer publishes the ship's exact screen
  // position (shipAnchor); it owns the laneF camera lag the overlay cannot recompute. Fallback
  // (WebGL renderer, render2d never drew): projectCross base, same convention as the pickups.
  if (shipAnchor[2] === 1) pts[0] = [shipAnchor[0], shipAnchor[1]];
  const tip = pts[BEAM_SEGMENTS];
  ctx.globalAlpha = 1; ctx.lineCap = 'round';
  ctx.strokeStyle = BEAM_GLOW; ctx.lineWidth = 7 * dpr; // glow pass under the core (R43.2)
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke();
  ctx.strokeStyle = BEAM_CORE; ctx.lineWidth = 3 * dpr; // core, 12 per-segment strokes
  for (let i = 0; i < BEAM_SEGMENTS; i++) {
    ctx.globalAlpha = BEAM_ALPHAS[beamBand((i + 0.5) / BEAM_SEGMENTS * reach)];
    ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[i + 1][0], pts[i + 1][1]); ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.fillStyle = BEAM_CORE; // tip spark at the live reach end
  ctx.beginPath(); ctx.arc(tip[0], tip[1], 3 * dpr, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}

function drawPickups() {
  if (!pickupCtx) return;
  const ctx = pickupCtx;
  if (!(running && currState?.status === 'running')) { // lobby, game over, abandoned: nothing drawn
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
  drawBeam(ctx, w, h, dpr); // R41.1: the ray first, so minerals paint over it
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
    const tier = pickupTier(kind, e.length >= 7 && Number.isFinite(e[6]) ? e[6] : MINERAL_NORMAL);
    const ticks = pickupTicksLeft(e, p);
    if (!tier || !Number.isFinite(ticks) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = (ticks + lag) * (pickupSpeed.get(id) ?? DEFAULT_ROCK_SPEED) / MU;
    const [sx, sy] = projectCross(w, h, d, x / MU + (lane - shipLane) * LANE_SPACING, y / MU);
    const s = PICKUP_SPRITES[tier][1] * dpr;
    if (sx < -s || sy < -s || sx > w + s || sy > h + s) continue;
    (byTier[tier] ??= []).push(sx, sy, s);
  }
  for (const tier of PICKUP_TIERS) {
    const pts = byTier[tier];
    if (!pts) continue;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 3) { // diamond: a square rotated 45 degrees
      const x = pts[i], y = pts[i + 1], s = pts[i + 2];
      ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath();
    }
    ctx.fillStyle = PICKUP_SPRITES[tier][0];
    ctx.fill();
  }
}

// ------------------------------------------------------------------ frame loop
function frame(timestamp) {
  if (running && !pause.isPaused() && !document.hidden) {
    if (previousFrame !== null) accumulator += Math.min(MAX_FRAME_MS, Math.max(0, timestamp - previousFrame));
    previousFrame = timestamp;
    while (accumulator >= TICK_MS && running) { tickOnce(); accumulator -= TICK_MS; }
  } else previousFrame = null;
  const ended = currState?.status === 'ended';
  const rows = currState
    ? {prev: prevState, curr: currState, alpha: ended ? 1 : accumulator / TICK_MS, view, trail, paused: pause.isPaused() || !running, now: timestamp}
    : {cruise: timestamp / 1000, now: timestamp};
  try { renderer.draw(rows); }
  catch (err) {
    if (rendererKind === 'webgl2') { console.warn('WebGL2 draw failed, switching to the 2D fallback:', err?.message ?? err); useFallback('lost'); }
  }
  // Spec 26.3.6: pickups on the overlay, after the game canvas frame (either renderer kind).
  try { drawPickups(); }
  catch (err) { if (!pickupWarned) { pickupWarned = true; console.warn('Pickup overlay draw failed:', err?.message ?? err); } }
  // W4c R-1: HUD DOM writes only when a tick produced a new state row, not on every frame.
  if (currState && currState !== hudState) { renderHud(document, currState, scoreMap); hudState = currState; }
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
  music.gesture();
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
  endSession(); save = result.state; game = null; recorded = false; lastRun = null;
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
  endSession(); save = newSave(crypto.randomUUID()); game = null; lastRun = null;
  applySettingsToOutputs();
  persist(); notice('New empty save created.');
};

document.addEventListener('pointerdown', () => music.gesture(), {once: true});
document.addEventListener('keydown', () => music.gesture(), {once: true});
document.addEventListener('visibilitychange', () => {
  previousFrame = null; accumulator = 0;
  if (document.hidden) { music.quiet(); scanner?.close(); } // a hidden page never keeps the camera open
  else if (session && Date.now() - lastActive >= IDLE_MS) { endSession(); openLobbyUnlessGameOver(); }
});
window.addEventListener('pagehide', () => { scanner?.close(); endSession(); });
setInterval(() => {
  if (session && Date.now() - lastActive >= IDLE_MS) { endSession(); openLobbyUnlessGameOver(); notice('Session ended after five minutes without active play.'); }
}, 1000);

// ------------------------------------------------------------------ boot
try {
  const text = localStorage.getItem(STORAGE_KEY);
  if (text === null) save = newSave(crypto.randomUUID());
  else {
    const result = importSave(text);
    if (result.ok) save = result.state;
    else notice(`Existing save was not changed: ${result.code}.`);
  }
} catch { save = newSave(crypto.randomUUID()); notice('Local storage unavailable. Use Export save to keep your runs.'); }
shipId = runShip = loadShip(); // before the renderer exists, so the first frame shows the chosen ship
buildShipPicker();
modeId = loadMode();
buildModePicker();
buildChallengeUi();
initRenderer();
// Lobby backdrop: the course of the shown seed, cruising without asteroids (presentation only).
map = scoreMap = createGame(seed).map();
renderer.setCourse(map, []);
applySettingsToOutputs();
openLobby();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready)
  .then(() => { if (!$('notice').textContent) notice('Offline build cached. You can play without a connection.'); })
  .catch(() => notice('Offline cache unavailable. Keep the local static server running to reload.'));

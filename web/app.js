// Client loop (pl-v2). The only module that calls step/abandon on the game. Renderers, HUD,
// lobby and audio receive read-only rows (map, course, state snapshots, view) from here.
import {createGame, TICKS_PER_SECOND, MAX_TICKS, WEAPONS} from '../src/sim/space_racer.js';
import {newSave, importSave, exportSave, STORAGE_KEY} from '../src/state/pilot_state.js';
import {quantizeStick, keyboardStick, MAX_RADIUS_PX, CAPTURE_RADIUS_PX} from '../src/input/controls.js';
import {digest} from './digest.js';
import {Music} from './music.js';
import {ScoreVoice} from './score_voice.js';
import {Sfx} from './sfx.js';
import {renderHud} from './hud.js';
import {createPause} from './pause.js';
import {applySetting, defaultSettings, lastResultText, retryEnabled, SETTING_CONTROLS} from './lobby_model.js';
import {createRenderer} from './render.js';
import {createRenderer2d} from './render2d.js';
import {createGameOver} from './gameover.js';

const BUILD = 'pl-web-0.2.0';
// Spec section 2 SPAWN_Z (mu). The sim module keeps this constant private, so it is handed to the
// renderers as a depth floor; they also extend visible depth to the largest z seen in view rows.
const SPAWN_Z = 360000;
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
let hops = [], fires = 0, lastSent = [0, 0];
// Per-tick {p, state, view} rows already produced by step/view, newest last (presentation only).
// A frame that runs several ticks hands all of them to the renderer, so no fire or short-lived
// rocket row is lost between frames.
const TRAIL_TICKS = 24;
let trail = [];
const held = {w: false, a: false, s: false, d: false};
let stickPointer = null, touchStick = [0, 0];

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
    renderer = createRenderer({canvas: $('canvas'), settings: settingsNow(), spawnZ: SPAWN_Z, onLost: () => useFallback('lost')});
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
  running = false; hops = []; fires = 0; accumulator = 0; previousFrame = null;
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
  $('last-result').textContent = lastResultText(lastRun);
  $('seed').textContent = String(lastSeed ?? seed);
  $('retry').disabled = !retryEnabled({lastSeed});
  $('replay').disabled = !(game && game.state().status === 'ended' && recorded);
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
  lastSeed = nextSeed;
  game = createGame(nextSeed); map = game.map(); course = game.course();
  prevState = currState = game.state(); view = game.view();
  trail = [{p: currState.processed, state: currState, view}];
  recorded = false; running = true; hops = []; fires = 0; lastSent = [0, 0];
  accumulator = 0; previousFrame = null;
  music.reset(); voice.setMap(map);
  beginSession(); music.gesture(); persist();
  renderer.setCourse(map, course);
  applySettingsToOutputs();
  pause.runStarted();
  closeLobby();
}

function finishRun() {
  stopRun();
  const s = currState;
  if (!s || s.status !== 'ended' || s.terminal_reason === 'abandoned') return openLobby();
  document.body.classList.remove('running');
  gameOver.show({
    score: s.score, ticks: s.terminal_tick, tps: TICKS_PER_SECOND, maxTicks: MAX_TICKS,
    loops: s.loop + 1, loopCount: map?.loops?.length ?? 3, lanes: s.lane_count, lane: s.lane, weapon: s.weapon,
    seed: s.seed, ruleset: s.ruleset_id, reason: s.terminal_reason, date: now().slice(0, 10),
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
  if (kind === 'fire') fires++;
  else hops.push({dir: kind, tick: t});
}
function takeHop(t) {
  let best = -1;
  for (let i = 0; i < hops.length; i++) {
    if (hops[i].tick > t) continue;
    if (best < 0 || hops[i].tick < hops[best].tick || (hops[i].tick === hops[best].tick && hops[i].dir === 'left' && hops[best].dir !== 'left')) best = i;
  }
  return best < 0 ? null : hops.splice(best, 1)[0].dir;
}
function tickOnce() {
  const t = game.state().processed;
  let buttons = 0;
  const hop = takeHop(t);
  if (hop) buttons |= hop === 'left' ? 1 : 2;
  if (fires > 0) { fires--; buttons |= 4; }
  const stick = currentStick();
  const entries = [];
  if (buttons || stick[0] !== lastSent[0] || stick[1] !== lastSent[1]) {
    entries.push([t, buttons, stick[0], stick[1]]);
    lastSent = [stick[0], stick[1]];
  }
  prevState = currState;
  currState = game.step(1, entries);
  view = game.view();
  trail.push({p: currState.processed, state: currState, view});
  if (trail.length > TRAIL_TICKS) trail.shift();
  session.active_ticks += currState.processed - t;
  lastActive = Date.now();
  music.beat(t);
  voice.beat(t, currState.lane);
  // W4c R-2: a fire_ready rise across tick t is the sim's [t, 3, code, shots] event (read-only rows).
  sfx.tick(prevState, currState, WEAPONS);
  if (currState.status === 'ended') finishRun();
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
  // W4c R-1: HUD DOM writes only when a tick produced a new state row, not on every frame.
  if (currState && currState !== hudState) { renderHud(document, currState, map); hudState = currState; }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ controls (spec 6.1)
const stickEl = $('stick'), knob = stickEl.querySelector('.knob');
function stickCentre() { const r = stickEl.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
function setStickFromPointer(event) {
  const [x, y] = stickCentre();
  const dx = event.clientX - x, dy = event.clientY - y, m = Math.hypot(dx, dy), k = m > MAX_RADIUS_PX ? MAX_RADIUS_PX / m : 1;
  touchStick = quantizeStick(dx * k, dy * k, MAX_RADIUS_PX);
  knob.style.setProperty('--kx', `${dx * k}px`); knob.style.setProperty('--ky', `${dy * k}px`);
}
function releaseStick() {
  stickPointer = null; touchStick = [0, 0];
  knob.style.setProperty('--kx', '0px'); knob.style.setProperty('--ky', '0px');
}
document.addEventListener('pointerdown', event => {
  music.gesture();
  if (!running || stickPointer !== null) return;
  const [x, y] = stickCentre();
  if (Math.hypot(event.clientX - x, event.clientY - y) > CAPTURE_RADIUS_PX) return;
  stickPointer = event.pointerId;
  setStickFromPointer(event);
  event.preventDefault();
});
document.addEventListener('pointermove', event => { if (event.pointerId === stickPointer) setStickFromPointer(event); });
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, event => { if (event.pointerId === stickPointer) releaseStick(); });
for (const [id, kind] of [['hop-left', 'left'], ['hop-right', 'right'], ['fire', 'fire']]) {
  const button = $(id);
  button.addEventListener('pointerdown', event => { event.preventDefault(); press(kind); });
  button.addEventListener('click', event => { if (event.detail === 0) press(kind); }); // keyboard activation only
}
const STICK_KEYS = {KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd'};
document.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || lobby.open || gameOver.isOpen()) return;
  if (STICK_KEYS[event.code]) { held[STICK_KEYS[event.code]] = true; return; }
  if (event.repeat) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); press(event.key === 'ArrowLeft' ? 'left' : 'right'); }
  else if (event.code === 'Space') { event.preventDefault(); press('fire'); }
});
document.addEventListener('keyup', event => { if (STICK_KEYS[event.code]) held[STICK_KEYS[event.code]] = false; });
window.addEventListener('blur', () => { for (const k of Object.keys(held)) held[k] = false; releaseStick(); });

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
$('replay').onclick = () => { if (game?.state().status === 'ended') download(`pulse-lanes-${lastSeed}.replay`, game.replayBytes()); };
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
  if (document.hidden) music.quiet();
  else if (session && Date.now() - lastActive >= IDLE_MS) { endSession(); openLobbyUnlessGameOver(); }
});
window.addEventListener('pagehide', () => endSession());
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
initRenderer();
// Lobby backdrop: the course of the shown seed, cruising without asteroids (presentation only).
map = createGame(seed).map();
renderer.setCourse(map, []);
applySettingsToOutputs();
openLobby();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready)
  .then(() => { if (!$('notice').textContent) notice('Offline build cached. You can play without a connection.'); })
  .catch(() => notice('Offline cache unavailable. Keep the local static server running to reload.'));

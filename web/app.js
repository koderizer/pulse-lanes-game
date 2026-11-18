import {createGame, TICKS_PER_SECOND} from '../src/sim/pulse_lanes.js';
import {newSave, importSave, exportSave, STORAGE_KEY} from '../src/state/pilot_state.js';
import {digest} from './digest.js';
import {Music} from './music.js';

const BUILD = 'pl-web-0.1.0';
const $ = id => document.getElementById(id);
const music = new Music();
const now = () => new Date().toISOString();
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
let save = null, session = null, game = null, rows = [], seed = randomSeed();
let playing = false, paused = false, recorded = false, queue = [];
let accumulator = 0, previousFrame = null, lastActive = Date.now();
const notice = message => { $('notice').textContent = message; };

function persist() {
  if (!save) return;
  try { localStorage.setItem(STORAGE_KEY, exportSave(save)); }
  catch { notice('Storage is unavailable or full. Export your save to keep these runs.'); }
  updateHistory();
}

function updateHistory() {
  const best = save?.runs.reduce((score, run) => run.terminal_reason === 'abandoned' ? score : Math.max(score, run.score), 0) ?? 0;
  $('history').textContent = save ? `${save.runs.length} recorded runs · Best: ${best} ticks` : 'Save could not be loaded. Import a valid save or choose New empty save.';
  $('mute').setAttribute('aria-pressed', String(save?.settings.mute ?? false));
  $('mute').textContent = save?.settings.mute ? 'Unmute' : 'Mute';
  music.setMute(save?.settings.mute ?? false);
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
  recorded = true;
  $('replay').disabled = false;
  persist();
}

function endSession(message = 'Session saved. Press Play to start again.') {
  recordRun();
  playing = false; paused = false; queue = []; accumulator = 0; previousFrame = null;
  music.quiet();
  if (session) { session.ended_at = now(); session = null; persist(); }
  $('pause').disabled = true; $('exit').disabled = true; $('pause').textContent = 'Pause';
  $('status').textContent = message;
}

function start(nextSeed = seed) {
  if (!save) return notice('Import a valid save or choose New empty save before playing.');
  if (playing) recordRun();
  seed = nextSeed;
  game = createGame(seed); rows = game.course();
  recorded = false; playing = true; paused = false; queue = [];
  accumulator = 0; previousFrame = null; music.reset();
  beginSession(); music.gesture(); persist();
  $('seed').textContent = seed; $('replay').disabled = true;
  $('pause').disabled = false; $('exit').disabled = false; $('pause').textContent = 'Pause';
  $('status').textContent = 'Find the open lane. Arrow keys or the buttons below.';
}

function move(action) {
  music.gesture();
  if (playing && !paused && !document.hidden) queue.push(action);
}

function togglePause() {
  if (!playing) return;
  paused = !paused; accumulator = 0; previousFrame = null;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('status').textContent = paused ? 'Paused. Your next tick will wait.' : 'Find the open lane.';
  if (paused) music.quiet(); else music.gesture();
}

function draw() {
  const canvas = $('canvas'), ctx = canvas.getContext('2d');
  const state = game?.state() ?? {lane: 1, processed: 0, score: 0};
  const width = canvas.width, height = canvas.height, laneWidth = width / 3, target = height - 100;
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0,0,0,height);
  gradient.addColorStop(0,'#101323'); gradient.addColorStop(1,'#202942');
  ctx.fillStyle = gradient; ctx.fillRect(0,0,width,height);
  ctx.strokeStyle = '#38425d'; ctx.lineWidth = 2;
  for (let lane = 1; lane < 3; lane++) { ctx.beginPath(); ctx.moveTo(lane*laneWidth,0); ctx.lineTo(lane*laneWidth,height); ctx.stroke(); }
  ctx.setLineDash([10,10]); ctx.strokeStyle = '#8e9ab9';
  ctx.beginPath(); ctx.moveTo(0,target); ctx.lineTo(width,target); ctx.stroke(); ctx.setLineDash([]);
  for (const [tick, mask] of rows) {
    const ahead = tick - state.processed;
    if (ahead < -1 || ahead > 180) continue;
    const y = target - ahead * target / 180;
    for (let lane = 0; lane < 3; lane++) if (mask & (1 << lane)) {
      ctx.fillStyle = '#ff8e8e'; ctx.fillRect(lane*laneWidth+16,y-14,laneWidth-32,28);
      ctx.fillStyle = '#4a283c'; ctx.fillRect(lane*laneWidth+28,y-3,laneWidth-56,6);
    }
  }
  const x = (state.lane + 0.5) * laneWidth;
  ctx.fillStyle = state.terminal_reason === 'collision' ? '#f7d7a1' : '#69e2d3';
  ctx.beginPath(); ctx.moveTo(x,target-24); ctx.lineTo(x+24,target); ctx.lineTo(x,target+24); ctx.lineTo(x-24,target); ctx.closePath(); ctx.fill();
  const stage = Math.min(2, Math.floor(state.processed / 2400));
  $('tempo').textContent = `${[90,120,150][stage]} BPM`;
  $('stage').textContent = `STAGE ${stage+1} / 3`;
  $('score').textContent = `${state.score} / 7200 ticks`;
}

function frame(timestamp) {
  if (playing && !paused && !document.hidden) {
    if (previousFrame !== null) accumulator += Math.max(0, timestamp - previousFrame);
    previousFrame = timestamp;
    const tickDuration = 1000 / TICKS_PER_SECOND;
    while (accumulator >= tickDuration && playing) {
      const before = game.state().processed;
      const action = queue.shift();
      game.step(1, action ? [{tick: before, action}] : []);
      session.active_ticks += game.state().processed - before;
      lastActive = Date.now();
      music.beat(before);
      accumulator -= tickDuration;
      if (game.state().status === 'ended') {
        recordRun(); playing = false; music.quiet();
        $('pause').disabled = true;
        $('status').textContent = game.state().terminal_reason === 'complete'
          ? 'All three stages cleared. 7200 ticks!' : `Collision at tick ${game.state().score}. Retry this course or try a new seed.`;
      }
    }
  } else previousFrame = null;
  draw(); requestAnimationFrame(frame);
}

function download(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function replaceSave(text) {
  const result = importSave(text);
  if (!result.ok) return notice(`Save was not changed: ${result.code}.`);
  endSession(); save = result.state; game = null; rows = []; recorded = false;
  $('replay').disabled = true;
  persist(); notice('Save loaded. Settings and run history restored.');
}

$('play').onclick = () => { if (playing) { if (paused) togglePause(); } else start(); };
$('retry').onclick = () => start(seed);
$('new').onclick = () => start(randomSeed());
$('left').onclick = () => move('left'); $('right').onclick = () => move('right');
$('pause').onclick = togglePause;
$('exit').onclick = () => endSession();
$('mute').onclick = () => {
  if (!save) return;
  save.settings.mute = !save.settings.mute;
  music.setMute(save.settings.mute); music.gesture(); persist();
};
$('save').onclick = () => { persist(); };
$('load').onclick = () => {
  try { const text = localStorage.getItem(STORAGE_KEY); if (text !== null) replaceSave(text); else notice('No local save yet.'); }
  catch { notice('Local storage is unavailable. Import a save file instead.'); }
};
$('export').onclick = () => { if (save) download('pulse-lanes-save.json', exportSave(save)); };
$('replay').onclick = () => { if (game?.state().status === 'ended') download(`pulse-lanes-${seed}.replay`, game.replayBytes()); };
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
  endSession(); save = newSave(crypto.randomUUID()); game = null; rows = [];
  $('replay').disabled = true;
  persist(); notice('New empty save created.');
};
document.addEventListener('keydown', event => {
  if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); if (!event.repeat) move(event.key === 'ArrowLeft' ? 'left' : 'right');
  }
});
document.addEventListener('pointerdown', () => music.gesture(), {once: true});
document.addEventListener('keydown', () => music.gesture(), {once: true});
document.addEventListener('visibilitychange', () => {
  previousFrame = null; accumulator = 0;
  if (document.hidden) music.quiet();
  else {
    if (session && Date.now() - lastActive >= 300000) endSession('Session ended after five minutes without active play.');
  }
});
window.addEventListener('pagehide', () => endSession());
setInterval(() => {
  if (session && Date.now() - lastActive >= 300000) endSession('Session ended after five minutes without active play.');
}, 1000);

try {
  const text = localStorage.getItem(STORAGE_KEY);
  if (text === null) save = newSave(crypto.randomUUID());
  else {
    const result = importSave(text);
    if (result.ok) save = result.state;
    else notice(`Existing save was not changed: ${result.code}.`);
  }
} catch { save = newSave(crypto.randomUUID()); notice('Local storage unavailable. Use Export save to keep your runs.'); }
updateHistory(); $('seed').textContent = seed;
requestAnimationFrame(frame);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready)
  .then(() => { if (!$('notice').textContent) notice('Offline build cached. You can play without a connection.'); })
  .catch(() => notice('Offline cache unavailable. Keep the local static server running to reload.'));

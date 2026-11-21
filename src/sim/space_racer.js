// Pulse Lanes v2 space racer simulation, ruleset `pl-v2` (spec docs/specs/space-racer-v2.md
// sections 2 to 11, spec/RULESET-v2.md). Pure ES module: integer math only, no I/O, no
// wall clock, no randomness other than the seeded streams of section 3. Identical in
// Node and in browsers.
import {strictJson} from '../shared/strict_json.js';

export const RULESET_ID = 'pl-v2';
export const MAP_FORMAT = 'pl-map-1';
export const TICKS_PER_SECOND = 60;
export const MAX_TICKS = 7200;

const LOOP_COUNT = 3;
const LOOP_BPM = [90, 120, 150];
const LOOP_BEATS = [60, 80, 100];
const LOOP_LANES = [3, 4, 5];
const LOOP_WEAPON = ['laser', 'rocket', 'laser'];
const LOOP_GRID16 = [4, 2, 2];
const LOOP_DENSITY = [30, 35, 40];
const LANE_LENGTHS = [4, 6, 8];
const START_LANE = 1;
const TUNNEL_RADIUS = 100000;
const SHIP_RADIUS = 8000;
const SHIP_TRAVEL_RADIUS = 92000;
const DEAD_ZONE = 15;
const THRUST_ACCEL_MAX = 250;
const DRIFT_PER_CURVE = 30;
const ENERGY_CAP = 10000;
const ENERGY_START = 10000;
const ENERGY_REGEN = 6;
const THRUST_COST_MAX = 12;
const HOP_COST = 2500;
const HOP_COOLDOWN = 12;
const EXHAUST_LOCK_TICKS = 90;
const SPAWN_Z = 360000;
const FIRST_ONSET_MIN = 120;
const SHAPE_COUNT = 8;
const SALT_MAP = 0x00000000;
const SALT_SPAWN = 0x5BD1E995;
const POSITION_ATTEMPTS = 8;
const SEED_MAX = 4294967295;
const SPEED = {1: 6000, 2: 4500, 4: 3600, 8: 3000, 16: 2400};
const VALUE16 = [1, 2, 4, 8, 16];

export const WEAPONS = Object.freeze({
  laser: Object.freeze({id: 'laser', code: 1, kind: 'hitscan', energy_cost: 300,
                        cooldown_ticks: 12, damage: 1, range_z: 240000, half_width: 3000, speed: 0}),
  rocket: Object.freeze({id: 'rocket', code: 2, kind: 'projectile', energy_cost: 1200,
                         cooldown_ticks: 45, damage: 4, range_z: 360000, half_width: 6000, speed: 8000}),
});

export function fail(code) { throw Object.assign(new Error(code), {code}); }

// ---------------------------------------------------------------- arithmetic (section 3)
const tdiv = (a, b) => { const q = Math.trunc(a / b); return q === 0 ? 0 : q; };
const fdiv = (a, b) => Math.floor(a / b);
function isqrt(n) {
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

function mix32(value) {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7FEB352D) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846CA68B) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function stream(seed, salt) {
  let state = mix32((seed ^ salt) >>> 0);
  if (state === 0) state = 0x9E3779B9;
  return {
    next() {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      return state;
    },
  };
}

const validSeed = seed => Number.isInteger(seed) && seed >= 0 && seed <= SEED_MAX;

// ---------------------------------------------------------------- canonical JSON, SHA-256 (section 10.2)
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('wrong_type');
    return String(value === 0 ? 0 : value);
  }
  return JSON.stringify(value);
}

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// Synchronous SHA-256 so replayObject() can carry map_hash without an async step.
function sha256Sync(bytes) {
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000), false);
  view.setUint32(padded.length - 4, (length << 3) >>> 0, false);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + 4 * i, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, x => x.toString(16).padStart(8, '0')).join('');
}

export async function sha256Hex(bytes) { return sha256Sync(bytes); }

const utf8 = text => new TextEncoder().encode(text);

// ---------------------------------------------------------------- map generator (section 4.3)
export function generateMap(seed) {
  if (!validSeed(seed)) fail('out_of_range');
  const r = stream(seed, SALT_MAP);
  const loops = [];
  for (let i = 0; i < LOOP_COUNT; i++) {
    const lanes = [];
    for (let j = 0; j < LOOP_LANES[i]; j++) {
      const length = LANE_LENGTHS[r.next() % 3];
      const curve = [];
      for (let k = 0; k < length; k++) {
        const cx = (r.next() % 9) - 4;
        const cy = (r.next() % 9) - 4;
        curve.push([cx, cy]);
      }
      const low = 24 + 12 * (r.next() % 5);
      const score = [];
      for (let p = 0; p < 4 * length; p += LOOP_GRID16[i]) {
        if (r.next() % 100 < LOOP_DENSITY[i]) {
          const value16 = VALUE16[r.next() % 5];
          const pitch = low + (r.next() % 12);
          score.push([p, value16, pitch]);
        }
      }
      if (score.length === 0) score.push([0, 4, low]);
      lanes.push({curve, length, score});
    }
    loops.push({beats: LOOP_BEATS[i], bpm: LOOP_BPM[i], lanes, weapon: LOOP_WEAPON[i]});
  }
  return {format: MAP_FORMAT, loops, seed};
}

// ---------------------------------------------------------------- map validator (sections 4.1, 4.2)
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasKeys = (v, keys) => isObject(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const isInt = (v, lo, hi) => Number.isInteger(v) && (lo === undefined || v >= lo) && (hi === undefined || v <= hi);

// Number tokens with a fraction or exponent are not plain integers (rule 1), outside of strings.
function hasNonIntegerToken(text) {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '.' || ch === 'e' || ch === 'E') {
      if (/[0-9]/.test(text[i - 1] ?? '')) return true;
    }
  }
  return false;
}

function mapProblem(m) {
  if (!hasKeys(m, ['format', 'loops', 'seed'])) return 'top-level members';
  if (m.format !== MAP_FORMAT) return 'format';
  if (!isInt(m.seed, 0, SEED_MAX)) return 'seed';
  if (!Array.isArray(m.loops) || m.loops.length < 1 || m.loops.length > 8) return 'loops';
  let total = 0;
  for (let i = 0; i < m.loops.length; i++) {
    const loop = m.loops[i], at = `loop ${i}`;
    if (!hasKeys(loop, ['beats', 'bpm', 'lanes', 'weapon'])) return `${at}: members`;
    if (!isInt(loop.bpm, 60, 240)) return `${at}: bpm`;
    if (!isInt(loop.beats, 1)) return `${at}: beats`;
    if (typeof loop.weapon !== 'string' || !['laser', 'rocket'].includes(loop.weapon)) return `${at}: weapon`;
    if (!Array.isArray(loop.lanes) || loop.lanes.length < 1 || loop.lanes.length > 5) return `${at}: lanes`;
    for (let j = 0; j < loop.lanes.length; j++) {
      const lane = loop.lanes[j], lat = `${at} lane ${j}`;
      if (!hasKeys(lane, ['curve', 'length', 'score'])) return `${lat}: members`;
      if (!isInt(lane.length, 1, 16)) return `${lat}: length`;
      if (!Array.isArray(lane.curve)) return `${lat}: curve`;
      for (const v of lane.curve) {
        if (!Array.isArray(v) || v.length !== 2 || !isInt(v[0], -4, 4) || !isInt(v[1], -4, 4)) return `${lat}: curve vector`;
      }
      if (!Array.isArray(lane.score) || lane.score.length < 1) return `${lat}: score`;
      for (const n of lane.score) {
        if (!Array.isArray(n) || n.length !== 3 || !isInt(n[0], 0) || !VALUE16.includes(n[1]) || !isInt(n[2], 24, 84)) {
          return `${lat}: note`;
        }
      }
    }
    // rules beyond the schema (4.2 rules 3 to 5)
    if (3600 % loop.bpm !== 0) return `${at}: 3600 % bpm`;
    total += loop.beats * (3600 / loop.bpm);
    if (!Object.hasOwn(WEAPONS, loop.weapon)) return `${at}: weapon registry`;
    for (let j = 0; j < loop.lanes.length; j++) {
      const lane = loop.lanes[j];
      if (lane.curve.length !== lane.length) return `${at} lane ${j}: len(curve)`;
      for (let k = 0; k < lane.score.length; k++) {
        const pos = lane.score[k][0];
        if (pos >= 4 * lane.length || (k > 0 && pos <= lane.score[k - 1][0])) return `${at} lane ${j}: pos16`;
      }
    }
  }
  if (total !== MAX_TICKS) return `loop ticks sum ${total}`;
  return null;
}

export function validateMap(value) {
  let doc = value;
  if (typeof value === 'string') {
    try {
      if (hasNonIntegerToken(value)) return {ok: false, code: 'invalid_map', detail: 'non-integer number token'};
      doc = strictJson(value);
    } catch (err) {
      return {ok: false, code: 'invalid_map', detail: `strict JSON: ${err.code ?? 'invalid_json'}`};
    }
  }
  const problem = mapProblem(doc);
  return problem === null ? {ok: true} : {ok: false, code: 'invalid_map', detail: problem};
}

// ---------------------------------------------------------------- course expansion (section 5)
const hpOf = pitch => pitch <= 35 ? 4 : pitch <= 47 ? 3 : pitch <= 59 ? 2 : 1;
const radiusOf = pitch => 9000 + (84 - pitch) * 450;

function loopStarts(map) {
  const starts = [];
  let s = 0;
  for (const loop of map.loops) { starts.push(s); s += loop.beats * (3600 / loop.bpm); }
  return starts;
}

function buildCourse(map) {
  const starts = loopStarts(map), notes = [];
  map.loops.forEach((loop, i) => {
    const beatTicks = 3600 / loop.bpm;
    loop.lanes.forEach((lane, j) => {
      for (let rep = 0; rep * 4 * lane.length < 4 * loop.beats; rep++) {
        for (const [pos16, value16, pitch] of lane.score) {
          const k = rep * 4 * lane.length + pos16;
          if (k >= 4 * loop.beats) continue;
          const onset = starts[i] + fdiv(k * beatTicks, 4);
          if (onset >= FIRST_ONSET_MIN) notes.push({onset, lane: j, loop: i, value16, pitch});
        }
      }
    });
  });
  notes.sort((a, b) => a.onset - b.onset || a.lane - b.lane);
  const seen = new Set();
  for (const n of notes) {
    const key = `${n.onset}:${n.loop}:${n.lane}`;
    if (seen.has(key)) throw new Error('internal: one-per-lane-per-onset violated');
    seen.add(key);
  }
  const r = stream(map.seed, SALT_SPAWN);
  return notes.map((n, id) => {
    const shape = r.next() % SHAPE_COUNT;
    const radius = radiusOf(n.pitch), lim = TUNNEL_RADIUS - radius;
    let ax = 0, ay = 0;
    for (let a = 0; a < POSITION_ATTEMPTS; a++) {
      const x = (r.next() % (2 * lim + 1)) - lim;
      const y = (r.next() % (2 * lim + 1)) - lim;
      if (x * x + y * y <= lim * lim) { ax = x; ay = y; break; }
    }
    return [id, n.loop, n.lane, n.onset, n.value16, n.pitch, radius, hpOf(n.pitch), shape, ax, ay];
  });
}

// ---------------------------------------------------------------- input entries (section 6.3)
export function validateInputs(inputs) {
  if (!Array.isArray(inputs)) fail('wrong_type');
  if (inputs.length > MAX_TICKS) fail('out_of_range');
  let previous = -1;
  for (let i = 0; i < inputs.length; i++) {
    const e = inputs[i];
    if (!Array.isArray(e) || e.length !== 4) fail('invalid_input_entry');
    for (let k = 0; k < 4; k++) if (!Number.isInteger(e[k])) fail('wrong_type');
    const [tick, buttons, sx, sy] = e;
    if (tick < 0 || tick >= MAX_TICKS || buttons < 0 || buttons > 7 ||
        sx < -100 || sx > 100 || sy < -100 || sy > 100 || sx * sx + sy * sy > 10000) fail('out_of_range');
    if ((buttons & 3) === 3) fail('invalid_action');
    if (tick === previous) fail('conflicting_inputs');
    if (tick < previous) fail('input_order');
    previous = tick;
  }
}

// ---------------------------------------------------------------- thrust curve (section 6.5)
function thrustOf(sx, sy) {
  const m = isqrt(sx * sx + sy * sy);
  let level = 0;
  if (m >= DEAD_ZONE) {
    const e = fdiv((m - 15) * 100, 85);
    level = fdiv(e * (e + 100), 200);
  }
  if (level === 0) return [0, 0, 0];
  return [tdiv(sx * level * THRUST_ACCEL_MAX, m * 100), tdiv(sy * level * THRUST_ACCEL_MAX, m * 100),
    fdiv(level * THRUST_COST_MAX + 99, 100)];
}

// ---------------------------------------------------------------- the game (sections 8, 9, 10, 11)
export function createGame(seed) {
  if (!validSeed(seed)) fail('out_of_range');
  const map = generateMap(seed);
  const mapJson = canonicalJson(map);
  const mapHash = sha256Sync(utf8(mapJson));
  const course = buildCourse(map);
  const starts = loopStarts(map);
  const hp = course.map(row => row[7]);
  const dead = new Set();
  const byLane = [[], [], [], [], []];
  const at = new Map();
  for (const row of course) { byLane[row[2]].push(row); at.set(row[3] * 64 + row[1] * 8 + row[2], row); }

  let lane = START_LANE, x = 0, y = 0, vx = 0, vy = 0, energy = ENERGY_START, sx = 0, sy = 0;
  let lockedUntil = 0, hopReady = 0, fireReady = 0, dodged = 0, destroyed = 0, shots = 0;
  let rockets = [];
  let reason = null, terminal = null;
  const events = [], states = [], applied = [];

  const loopOf = t => {
    for (let i = starts.length - 1; i >= 0; i--) if (t >= starts[i]) return i;
    return 0;
  };

  const candidates = (laneIndex, t, px, py, halfWidth) => {
    const out = [];
    for (const row of byLane[laneIndex]) {
      if (dead.has(row[0]) || row[3] <= t) continue;
      const speed = SPEED[row[4]];
      if (row[3] - SPAWN_Z / speed > t) continue;
      const dx = px - row[9], dy = py - row[10], reach = row[6] + halfWidth;
      if (dx * dx + dy * dy <= reach * reach) out.push([row, (row[3] - t) * speed]);
    }
    return out;
  };

  const hit = (row, damage, t, code) => {
    const left = Math.max(0, hp[row[0]] - damage);
    hp[row[0]] = left;
    events.push([t, 5, row[0], left]);
    if (left === 0) {
      dead.add(row[0]);
      destroyed++;
      events.push([t, 6, row[0], code]);
    }
  };

  const tick = entry => {
    const t = states.length;
    const i = loopOf(t);
    const current = map.loops[i];
    const count = current.lanes.length;
    lane = Math.min(lane, count - 1);
    const weapon = WEAPONS[current.weapon];
    let buttons = 0;
    if (entry) {
      applied.push([entry[0], entry[1], entry[2] + 0, entry[3] + 0]);
      buttons = entry[1]; sx = entry[2] + 0; sy = entry[3] + 0;
    }
    const locked = t < lockedUntil;
    const d = (buttons & 1) ? -1 : (buttons & 2) ? 1 : 0;
    if (d) {
      const why = locked ? 1 : (lane + d < 0 || lane + d > count - 1) ? 2 : t < hopReady ? 3 : energy < HOP_COST ? 4 : 0;
      if (why) events.push([t, 2, why, d === -1 ? 0 : 1]);
      else {
        events.push([t, 1, lane, lane + d]);
        lane += d; energy -= HOP_COST; hopReady = t + HOP_COOLDOWN;
      }
    }
    if (buttons & 4) {
      const why = locked ? 1 : t < fireReady ? 3 : energy < weapon.energy_cost ? 4 : 0;
      if (why) events.push([t, 4, why, weapon.code]);
      else {
        shots++;
        events.push([t, 3, weapon.code, shots]);
        energy -= weapon.energy_cost; fireReady = t + weapon.cooldown_ticks;
        if (weapon.kind === 'hitscan') {
          let best = null;
          for (const [row, z] of candidates(lane, t, x, y, weapon.half_width)) {
            if (z > weapon.range_z) continue;
            if (best === null || z < best[1] || (z === best[1] && row[0] < best[0][0])) best = [row, z];
          }
          if (best) hit(best[0], weapon.damage, t, weapon.code);
        } else rockets.push([shots, lane, x, y, 0, weapon]);
      }
    }
    let ax = 0, ay = 0;
    if (!locked) {
      const [tx, ty, cost] = thrustOf(sx, sy);
      if (cost > energy) {
        events.push([t, 7, t + EXHAUST_LOCK_TICKS, 0]);
        lockedUntil = t + EXHAUST_LOCK_TICKS;
      } else { ax = tx; ay = ty; energy -= cost; }
    }
    const shape = current.lanes[lane];
    const seg = fdiv(t - starts[i], 3600 / current.bpm) % shape.length;
    const [cx, cy] = shape.curve[seg];
    vx = tdiv((vx + ax - cx * DRIFT_PER_CURVE) * 15, 16);
    vy = tdiv((vy + ay - cy * DRIFT_PER_CURVE) * 15, 16);
    const nx = x + vx, ny = y + vy, wall = SHIP_TRAVEL_RADIUS * SHIP_TRAVEL_RADIUS;
    if (nx * nx + ny * ny <= wall) { x = nx; y = ny; }
    else if (nx * nx + y * y <= wall) { x = nx; vy = 0; }
    else if (x * x + ny * ny <= wall) { y = ny; vx = 0; }
    else { vx = 0; vy = 0; }
    const keep = [];
    for (const rk of rockets) {
      rk[4] += rk[5].speed;
      let best = null;
      for (const [row, z] of candidates(rk[1], t, rk[2], rk[3], rk[5].half_width)) {
        if (z <= rk[4] && (best === null || row[0] < best[0])) best = row;
      }
      if (best) { hit(best, rk[5].damage, t, rk[5].code); continue; }
      if (rk[4] > rk[5].range_z) continue;
      keep.push(rk);
    }
    rockets = keep;
    energy = Math.min(ENERGY_CAP, energy + ENERGY_REGEN);
    const row = at.get(t * 64 + i * 8 + lane);
    let collided = false;
    if (row && !dead.has(row[0])) {
      const dx = x - row[9], dy = y - row[10], reach = SHIP_RADIUS + row[6];
      if (dx * dx + dy * dy < reach * reach) collided = true;
      else dodged++;
    }
    states.push([t, lane, x, y, vx, vy, energy, dodged, destroyed]);
    if (collided) { reason = 'collision'; terminal = t; }
    else if (t === MAX_TICKS - 1) { reason = 'complete'; terminal = MAX_TICKS; }
  };

  const core = () => {
    if (!reason) fail('not_terminal');
    return {ruleset_id: RULESET_ID, seed, inputs: applied.map(e => [...e]),
      terminal_tick: terminal, terminal_reason: reason, score: terminal};
  };

  const game = {
    step(ticks, inputs) {
      if (reason) return game.state();
      if (!Number.isSafeInteger(ticks) || ticks < 0) fail('out_of_range');
      validateInputs(inputs);
      const start = states.length;
      for (const e of inputs) if (e[0] < start || e[0] - start >= ticks) fail('out_of_range');
      let index = 0;
      for (let n = 0; n < ticks && !reason; n++) {
        const t = states.length;
        const entry = inputs[index] && inputs[index][0] === t ? inputs[index++] : null;
        tick(entry);
      }
      return game.state();
    },
    abandon() {
      if (!reason) { reason = 'abandoned'; terminal = states.length; }
      return game.state();
    },
    state() {
      const processed = states.length;
      const i = loopOf(Math.min(processed, MAX_TICKS - 1));
      return {destroyed, dodged, energy, fire_ready: fireReady, hop_ready: hopReady, lane,
        lane_count: map.loops[i].lanes.length, locked_until: lockedUntil, loop: i,
        position: [x, y], processed, ruleset_id: RULESET_ID, score: reason ? terminal : processed, seed,
        status: reason ? 'ended' : 'running', terminal_reason: reason, terminal_tick: terminal,
        velocity: [vx, vy], weapon: map.loops[i].weapon};
    },
    map: () => JSON.parse(mapJson),
    course: () => course.map(row => [...row]),
    view() {
      const p = states.length;
      const asteroids = [];
      for (const row of course) {
        if (dead.has(row[0])) continue;
        const speed = SPEED[row[4]];
        if (row[3] - SPAWN_Z / speed <= p && p <= row[3]) asteroids.push([row[0], row[1], row[2], (row[3] - p) * speed, hp[row[0]]]);
      }
      return {asteroids, rockets: rockets.map(rk => [rk[0], rk[1], rk[2], rk[3], rk[4]])};
    },
    runRecordCore: core,
    replayObject() {
      const base = core();
      return {course: game.course(), events: events.map(e => [...e]), inputs: base.inputs, map_hash: mapHash,
        ruleset_id: RULESET_ID, score: base.score, seed, states: states.map(row => [...row]),
        terminal_reason: base.terminal_reason, terminal_tick: base.terminal_tick};
    },
    replayBytes: () => utf8(canonicalJson(game.replayObject())),
  };
  return game;
}

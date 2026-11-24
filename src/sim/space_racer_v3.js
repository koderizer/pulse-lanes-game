// Ruleset pl-v3: the economy round (spec docs/specs/space-racer-v2.md sections 21 and 22,
// rulings R35 and R35.14) with the round-six onboarding tuning (section 25, ruling R36) and the
// round-seven player weapon select and drop economy (sections 26.2 and 26.3, ruling R38; FB3-TA9
// NOTE 24 to NOTE 29). Pure ES module: integer math only, no I/O, no wall clock and no
// Math.random. Every random draw comes from a seeded stream of the run seed.
//
// Isolation (R35.1): src/sim/space_racer.js is never edited and its private helpers are not
// read. Everything pl-v3 needs from pl-v2 (mix32, the section 3 stream, the section 4.3 map
// draws, the section 5 expansion and the section 9 tick physics) is re-implemented here.
//
// Where the spec is silent, the FB3-TA6 NOTE lines (docs/pm/runs/FB3-TA6/report.md) are binding
// (R35.13). Comments below cite the NOTE each choice honors.

// ------------------------------------------------------------ public constants
export const RULESET_ID = 'pl-v3';
export const TICKS_PER_SECOND = 60;
export const MODES = Object.freeze(['death', 'timed90', 'timed120']);
export const MODE_TICKS = Object.freeze({death: null, timed90: 5400, timed120: 7200}); // NOTE 10
export const CHARGE_START = 0;
export const CHARGE_CAP = 100;
export const HOP_COST = 25;
export const HOP_COOLDOWN = 12;
export const BOOST_TICKS = 120;
export const AMMO_START = 0;
export const ROCKET_CAP = 12;
export const MINERAL_CHARGE = 25;
export const GEM_AMMO = 2;
export const PICKUP_RADIUS = 4000;
export const SALT_DROP = 0x44524F50; // R35.12
export const Z_SPEED = 1000; // NOTE 1, R35.14 Q5
export const DENSITY_CAP = 60;
export const DENSITY_STEP = 5;
// NOTE 26 (section 26.3.3, R38): tier draw r = draw mod 100 from ordinal 6 on: r < 70 mineral
// small (+10 charge), r < 90 mineral normal (+25), r < 95 mineral large (+50), else gem (+2
// rockets). Every destruction drops (26.3.1), so the 21.4 "none" bucket is empty
// (DROP_NONE_BELOW 0) and every r below DROP_MINERAL_BELOW (95) is a mineral.
export const DROP_SMALL_BELOW = 70;
export const DROP_NORMAL_BELOW = 90;
export const DROP_LARGE_BELOW = 95;
export const MINERAL_SMALL = 10;
export const MINERAL_NORMAL = 25;
export const MINERAL_LARGE = 50;
export const DROP_NONE_BELOW = 0;
export const DROP_MINERAL_BELOW = DROP_LARGE_BELOW;
// NOTE 24 (section 26.2.1, ruling R38): buttons 0..31, bit4 (16) selects the rocket for this tick.
export const BUTTONS_MAX = 31;
export const ROCKET_SELECT = 16;

// NOTE 7: pl-v2 weapon physics with energy_cost replaced by ammo_cost.
export const WEAPONS = Object.freeze({
  laser: Object.freeze({id: 'laser', code: 1, kind: 'hitscan', ammo_cost: 0,
    cooldown_ticks: 12, damage: 1, range_z: 240000, half_width: 3000, speed: 0}),
  rocket: Object.freeze({id: 'rocket', code: 2, kind: 'projectile', ammo_cost: 1,
    cooldown_ticks: 45, damage: 4, range_z: 360000, half_width: 6000, speed: 8000}),
});

// NOTE 34 (spec 27.2.3 + 27.6, rulings R40.1/R40.2 + R42.1): the pl-v3 laser beam law lives in
// these exports; WEAPONS above is byte-frozen. NOTE 35 (27.2.2/27.2.5): reach and tier damage
// helpers are module-private; BEAM_TIERS is pinned law (first row with d <= d_max gives the
// damage). R42 (owner playtest): R_MAX 2x (full extension 20 ticks) and tiers 2/1/1 so big
// rocks need multiple passes.
export const BEAM_V_EXT = 48000;
export const BEAM_R_MAX = 960000;
export const BEAM_HALF_WIDTH = 3000;
export const BEAM_TIERS = Object.freeze([
  Object.freeze([160000, 2]), Object.freeze([320000, 1]), Object.freeze([BEAM_R_MAX, 1])]);
function beamReach(t0, t) { return Math.min(BEAM_R_MAX, BEAM_V_EXT * (t - t0 + 1)); }
function beamDamage(d) {
  for (const [dMax, damage] of BEAM_TIERS) if (d <= dMax) return damage;
  return 1;
}

// ------------------------------------------------------------ pl-v2 constants (section 2), private
// NOTE 25 (R38.2): the pl-v2 song bar weapon column (laser, rocket, laser) is not carried by
// pl-v3 at all; base loops keep no weapon field, so no pl-v3 path can fire from it.
const BASE = Object.freeze({
  bpm: [90, 120, 150],
  beats: [60, 80, 100],
  lanes: [3, 4, 5],
  grid16: [4, 2, 2],
  density: [30, 35, 40],
});
const BASE_LOOPS = 3;
const LANE_LENGTHS = [4, 6, 8];
const VALUE16 = [1, 2, 4, 8, 16];
const NOTE_SPEED = {1: 6000, 2: 4500, 4: 3600, 8: 3000, 16: 2400}; // section 5.2
const START_LANE = 1;
const MAX_LANES = 5;
const TUNNEL_RADIUS = 100000;
const SHIP_RADIUS = 8000;
const SHIP_TRAVEL_RADIUS = 92000;
const DEAD_ZONE = 15;
const THRUST_ACCEL_MAX = 250;
const DRIFT_PER_CURVE = 30;
// Section 25 (round six, ruling R36; FB3-TA7 NOTE 15 to NOTE 18).
export const SPAWN_Z = 1080000; // NOTE 15: view, targeting gate and renderer depth band
export const FIRST_ONSET_MIN = 240; // NOTE 16
// NOTE 16: opening schedule [end tick (exclusive), percent]; onsets at or past the last end use
// loopDensity(L).
export const OPENING_DENSITY = Object.freeze([
  Object.freeze([1200, 6]), Object.freeze([2400, 14]), Object.freeze([3600, 24])]);
// NOTE 17: destruction ordinal k (1-based) <= length overrides the drop roll with kind
// DROP_GUARANTEE[k - 1] (1 mineral, 2 gem). Round seven (NOTE 26, 26.3.2): no stream draw is
// consumed for a guaranteed ordinal any more; ordinal 6 takes the first SALT_DROP draw.
export const DROP_GUARANTEE = Object.freeze([1, 1, 1, 2, 1]);
// Section 25.5 (rulings R36.7, R36.8; FB3-TA8 NOTE 19 to NOTE 23): tutorial lane alignment and
// supply floor for onsets below TUTORIAL_END. Private, as in the reference.
const TUTORIAL_END = 1800;
const SUPPLY_FLOOR = 7;
const FILLER_GRID = 40;
const SHAPE_COUNT = 8;
const POSITION_ATTEMPTS = 8;
const SALT_MAP = 0x00000000;
const SALT_SPAWN = 0x5BD1E995;
const SEED_MAX = 0xFFFFFFFF;
const ZERO_STATE = 0x9E3779B9;

const beatTicksOf = b => 3600 / BASE.bpm[b];
const LOOP_TICKS = BASE.bpm.map((_, b) => BASE.beats[b] * beatTicksOf(b));
const CYCLE_TICKS = LOOP_TICKS.reduce((a, n) => a + n, 0);

// ------------------------------------------------------------ arithmetic (section 3)
function fail(code) { throw Object.assign(new Error(code), {code}); }
function tdiv(a, b) { const q = Math.trunc(a / b); return q === 0 ? 0 : q; }
function fdiv(a, b) { return Math.floor(a / b); }
function isqrt(n) {
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}
function isSeed(seed) { return Number.isInteger(seed) && seed >= 0 && seed <= SEED_MAX; }

// pl-v1 RULESET 4.1 mix32.
function mix32(value) {
  let h = value >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846CA68B) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Section 3 stream: state = mix32(seed ^ salt), 0 replaced, then pl-v1 4.3 xorshift32.
function makeStream(seed, salt) {
  let s = mix32((seed ^ salt) >>> 0);
  if (s === 0) s = ZERO_STATE;
  return function nextU32() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

// ------------------------------------------------------------ drops (21.4, R35.12, 26.3)
// r = draw mod 100: r < DROP_NONE_BELOW none (0, empty since 26.3.1), r < DROP_MINERAL_BELOW
// mineral (1), else gem (2).
export function dropKind(r) {
  if (r < DROP_NONE_BELOW) return 0;
  return r < DROP_MINERAL_BELOW ? 1 : 2;
}

// NOTE 26 (26.3.3): the pickup of tier draw r as [kind, amount]; amount is charge points for a
// mineral and rockets for a gem (before the CHARGE_CAP / ROCKET_CAP clamp at collection).
export function dropTier(r) {
  if (r < DROP_SMALL_BELOW) return [1, MINERAL_SMALL];
  if (r < DROP_NORMAL_BELOW) return [1, MINERAL_NORMAL];
  if (r < DROP_LARGE_BELOW) return [1, MINERAL_LARGE];
  return [2, GEM_AMMO];
}

// NOTE 26 (26.3.2): guaranteed ordinal k (1-based, k <= DROP_GUARANTEE.length) as [kind, amount]:
// minerals at NORMAL tier, gems GEM_AMMO. No draw is taken for a guaranteed ordinal.
export function guaranteedDrop(k) {
  const kind = DROP_GUARANTEE[k - 1];
  return [kind, kind === 1 ? MINERAL_NORMAL : GEM_AMMO];
}

export function dropRolls(seed, n) {
  if (!isSeed(seed)) fail('out_of_range');
  const next = makeStream(seed, SALT_DROP);
  return Array.from({length: n}, () => next() % 100);
}

// ------------------------------------------------------------ ramp and cycling (21.5, R35.4)
export function loopDensity(L) {
  const k = Math.floor(L / BASE_LOOPS);
  return Math.min(DENSITY_CAP, BASE.density[L % BASE_LOOPS] + DENSITY_STEP * k);
}

// NOTE 16 (section 25.2): density percent for an asteroid of absolute loop L with onset tick t.
export function onsetDensity(L, t) {
  for (const [end, percent] of OPENING_DENSITY) if (t < end) return percent;
  return loopDensity(L);
}

// NOTE 3: the absolute loop ordinal is mixed into the spawn salt (mix32(0) = 0).
export function loopSalt(L) { return (SALT_SPAWN ^ mix32(L)) >>> 0; }

export function loopStart(L) {
  let start = Math.floor(L / BASE_LOOPS) * CYCLE_TICKS;
  for (let b = 0; b < L % BASE_LOOPS; b++) start += LOOP_TICKS[b];
  return start;
}

function loopAt(t) {
  const cycleBase = BASE_LOOPS * Math.floor(t / CYCLE_TICKS);
  let L = cycleBase;
  while (L < cycleBase + BASE_LOOPS - 1 && loopStart(L + 1) <= t) L++;
  return L;
}

// Section 4.3 draw order on the MAP stream. Scores are drawn (to keep the stream aligned) but
// discarded: NOTE 2 re-draws every lane score per absolute loop. Kept per lane: length, curve
// and the register low.
function baseLoops(seed) {
  const next = makeStream(seed, SALT_MAP);
  const out = [];
  for (let b = 0; b < BASE_LOOPS; b++) {
    const lanes = [];
    for (let j = 0; j < BASE.lanes[b]; j++) {
      const length = LANE_LENGTHS[next() % 3];
      const curve = [];
      for (let c = 0; c < length; c++) {
        const cx = (next() % 9) - 4;
        const cy = (next() % 9) - 4;
        curve.push([cx, cy]);
      }
      const low = 24 + 12 * (next() % 5);
      for (let p = 0; p < 4 * length; p += BASE.grid16[b]) {
        if (next() % 100 < BASE.density[b]) { next(); next(); }
      }
      lanes.push({length, curve, low});
    }
    out.push({bpm: BASE.bpm[b], beats: BASE.beats[b], lanes});
  }
  return out;
}

function hpOf(pitch) {
  if (pitch <= 35) return 4;
  if (pitch <= 47) return 3;
  if (pitch <= 59) return 2;
  return 1;
}
function radiusOf(pitch) { return 9000 + (84 - pitch) * 450; }

// NOTE 2: course rows of absolute loop L from one stream(seed, loopSalt(L)): lane scores at
// loopDensity(L), the section 5.1 expansion from loopStart(L), then the section 5.5 shape and
// position draws in (onset, lane) order. Row: [id, L, lane, onset, value16, pitch, radius, hp,
// shape, ax, ay]; ids continue from firstId.
function loopRows(bases, seed, L, firstId) {
  const b = L % BASE_LOOPS;
  const base = bases[b];
  const density = loopDensity(L);
  const start = loopStart(L);
  const beatTicks = beatTicksOf(b);
  const span16 = 4 * base.beats;
  const next = makeStream(seed, loopSalt(L));

  const notes = [];
  for (let j = 0; j < base.lanes.length; j++) {
    const lane = base.lanes[j];
    const lane16 = 4 * lane.length;
    const score = [];
    for (let p = 0; p < lane16; p += BASE.grid16[b]) {
      // NOTE 16: the slot draw u is unchanged and kept per slot for the opening gate below.
      const u = next() % 100;
      if (u < density) {
        const value16 = VALUE16[next() % 5];
        const pitch = lane.low + (next() % 12);
        score.push([p, value16, pitch, u]);
      }
    }
    // The empty-score fallback has no slot draw and is never thinned (u = -1).
    if (score.length === 0) score.push([0, 4, lane.low, -1]);
    for (let offset = 0; offset < span16; offset += lane16) {
      for (const [pos16, value16, pitch, u] of score) {
        const k = offset + pos16;
        if (k >= span16) continue;
        const onset = start + fdiv(k * beatTicks, 4);
        // Section 25.2: an expanded onset is an asteroid only when u < onsetDensity(L, onset).
        if (onset >= FIRST_ONSET_MIN && u < onsetDensity(L, onset)) notes.push([onset, j, value16, pitch]);
      }
    }
  }
  notes.sort((a, c) => (a[0] - c[0]) || (a[1] - c[1]));
  for (let i = 1; i < notes.length; i++) {
    if (notes[i][0] === notes[i - 1][0] && notes[i][1] === notes[i - 1][1]) {
      throw new Error('internal: one asteroid per lane per onset violated');
    }
  }

  // Section 5.5 shape and position draws for one rock: [shape, radius, ax, ay].
  const drawRock = pitch => {
    const shape = next() % SHAPE_COUNT;
    const radius = radiusOf(pitch);
    const lim = TUNNEL_RADIUS - radius;
    let ax = 0, ay = 0;
    for (let attempt = 0; attempt < POSITION_ATTEMPTS; attempt++) {
      const px = (next() % (2 * lim + 1)) - lim;
      const py = (next() % (2 * lim + 1)) - lim;
      if (px * px + py * py <= lim * lim) { ax = px; ay = py; break; }
    }
    return [shape, radius, ax, ay];
  };

  // Every natural rock takes its draws first, in (onset, lane) order, whether or not section
  // 25.5 later drops it (R36.8.1, NOTE 19). Rock: [lane, onset, value16, pitch, shape, radius, ax, ay].
  const rocks = notes.map(([onset, lane, value16, pitch]) => [lane, onset, value16, pitch, ...drawRock(pitch)]);
  let out = rocks;
  if (start < TUTORIAL_END) out = tutorialRocks(rocks, base.lanes[START_LANE].low, next, drawRock);
  return out.map(([lane, onset, value16, pitch, shape, radius, ax, ay], i) =>
    [firstId + i, L, lane, onset, value16, pitch, radius, hpOf(pitch), shape, ax, ay]);
}

// Section 25.5 (rulings R36.7, R36.8; FB3-TA8 NOTE 19 to NOTE 23) for the loop that starts below
// TUTORIAL_END. rocks are in (onset, lane) order with their natural draws already taken.
function tutorialRocks(rocks, low, next, drawRock) {
  // R36.8.1 (NOTE 19): onset < TUTORIAL_END forced to START_LANE; the later rock whose
  // (START_LANE, onset) is already taken is dropped (its draws stay consumed).
  const out = [];
  const taken = new Set();
  for (const k of rocks) {
    if (k[1] < TUTORIAL_END) {
      if (taken.has(k[1])) continue;
      taken.add(k[1]);
      k[0] = START_LANE;
    }
    out.push(k);
  }
  // R36.8.2 (NOTE 20): the floor counts survivors in [FIRST_ONSET_MIN, TUTORIAL_END).
  let have = 0;
  for (const k of out) if (k[1] >= FIRST_ONSET_MIN && k[1] < TUTORIAL_END) have++;
  const fill = Math.max(0, SUPPLY_FLOOR - have);
  const W = TUTORIAL_END - FIRST_ONSET_MIN;
  for (let i = 0; i < fill; i++) {
    // R36.8.3 (NOTE 21): grid-snapped midpoint (round half up); taken or out-of-window onsets
    // probe +40, -40, +80, -80, ... inside [FIRST_ONSET_MIN, TUTORIAL_END).
    const mid = FIRST_ONSET_MIN + FILLER_GRID * Math.round(fdiv((2 * i + 1) * W, 2 * fill) / FILLER_GRID);
    let onset = mid;
    for (let step = 1; taken.has(onset) || onset < FIRST_ONSET_MIN || onset >= TUTORIAL_END; step++) {
      if (step > 2 * W) throw new Error('internal: no free filler onset');
      onset = mid + (step % 2 ? 1 : -1) * FILLER_GRID * Math.ceil(step / 2);
    }
    taken.add(onset);
    // R36.8.4 (NOTE 22): filler draws after every natural draw of the loop: slot draw (kept
    // regardless), value16, pitch, shape, position attempts. No generation-time drop draw.
    next();
    const value16 = VALUE16[next() % 5];
    const pitch = low + (next() % 12);
    out.push([START_LANE, onset, value16, pitch, ...drawRock(pitch)]);
  }
  // R36.8.5 (NOTE 23): rows renumbered in (onset, lane) order, fillers included.
  out.sort((a, c) => (a[1] - c[1]) || (a[0] - c[0]));
  for (let i = 1; i < out.length; i++) {
    if (out[i][1] === out[i - 1][1] && out[i][0] === out[i - 1][0]) {
      throw new Error('internal: one asteroid per lane per onset violated');
    }
  }
  return out;
}

export function loopCourse(seed, L) {
  if (!isSeed(seed)) fail('out_of_range');
  if (!Number.isInteger(L) || L < 0) fail('out_of_range');
  const bases = baseLoops(seed);
  let firstId = 0;
  let rows = [];
  for (let i = 0; i <= L; i++) {
    rows = loopRows(bases, seed, i, firstId);
    firstId += rows.length;
  }
  return rows;
}

// ------------------------------------------------------------ input entries (21.1, 21.6, NOTE 10)
export function validateInputs(inputs, mode) {
  if (!MODES.includes(mode)) fail('invalid_mode');
  const limit = MODE_TICKS[mode];
  if (!Array.isArray(inputs)) fail('wrong_type');
  if (limit !== null && inputs.length > limit) fail('out_of_range');
  const tickMax = limit === null ? Number.MAX_SAFE_INTEGER : limit - 1;
  let previous = -1;
  for (const entry of inputs) {
    if (!Array.isArray(entry) || entry.length !== 4) fail('invalid_input_entry');
    if (!entry.every(Number.isInteger)) fail('wrong_type');
    const [tick, buttons, sx, sy] = entry;
    // NOTE 24: the range check precedes invalid_action (35 is out_of_range, 31 invalid_action).
    if (tick < 0 || tick > tickMax || buttons < 0 || buttons > BUTTONS_MAX ||
        sx < -100 || sx > 100 || sy < -100 || sy > 100 || sx * sx + sy * sy > 10000) fail('out_of_range');
    if ((buttons & 3) === 3) fail('invalid_action');
    if (tick === previous) fail('conflicting_inputs');
    if (tick < previous) fail('input_order');
    previous = tick;
  }
}

// Section 6.5 thrust curve; pl-v3 thrust has no cost.
function thrust(sx, sy) {
  const m = isqrt(sx * sx + sy * sy);
  if (m < DEAD_ZONE) return [0, 0];
  const e = fdiv((m - 15) * 100, 85);
  const level = fdiv(e * (e + 100), 200);
  if (level === 0) return [0, 0];
  return [tdiv(sx * level * THRUST_ACCEL_MAX, m * 100), tdiv(sy * level * THRUST_ACCEL_MAX, m * 100)];
}

// ------------------------------------------------------------ the game
// Events (NOTE 4, R35.2):
//   [t, 1, from, to] hop; [t, 2, why, dir] hop refused (2 boundary, 3 cooldown, 4 charge_low);
//   [t, 3, code, shots] fire; [t, 4, 3, code] fire refused on cooldown; [t, 5, id, hp_left] hit;
//   [t, 6, id, code, kind, amount] destroyed (NOTE 27, R38.3: kind 1 mineral / 2 gem and amount
//   appended by round seven); [t, 6, 1] boost refused; [t, 6, 2] fire refused, no ammo;
//   [t, 5, kind, x, y] pickup collected (unchanged, kind 1 mineral / 2 gem).
// Tick order (NOTE 5): loop and lane clamp, input, hop, fire, boost, thrust, drift, move,
// rockets, distance, collision with dodge and pickup collection, state record, completion.
export function createGame(seed, mode) {
  if (!isSeed(seed)) fail('out_of_range'); // NOTE 11: seed first
  if (!MODES.includes(mode)) fail('invalid_mode');
  const limit = MODE_TICKS[mode];
  const bases = baseLoops(seed);

  // Lazily built course, one entry per absolute loop.
  const course = [];
  const hpLeft = new Map();
  const dead = new Set();
  let idCursor = 0;
  const buildThrough = L => {
    while (course.length <= L) {
      const rows = loopRows(bases, seed, course.length, idCursor);
      idCursor += rows.length;
      const byLane = Array.from({length: MAX_LANES}, () => []);
      const atOnset = new Map();
      for (const r of rows) {
        byLane[r[2]].push(r);
        atOnset.set(r[3] * MAX_LANES + r[2], r);
        hpLeft.set(r[0], r[7]);
      }
      course.push({rows, byLane, atOnset});
    }
  };

  const drops = makeStream(seed, SALT_DROP);
  const pickups = new Map(); // asteroid id -> {id, kind, amount, lane, x, y, onset, speed}

  let lane = START_LANE, x = 0, y = 0, vx = 0, vy = 0, sx = 0, sy = 0;
  let charge = CHARGE_START, ammo = AMMO_START, boostUntil = 0;
  let hopReady = 0, fireReady = 0, shots = 0, dodged = 0, destroyed = 0, distance = 0;
  let lastWeapon = 'laser'; // NOTE 28 (26.2.3): weapon id of the most recent accepted fire
  let fireLevel = 0, beam = null; // NOTE 36 (27.1.1, 27.2.2): fire level state; open beam {t0, reach, hit} or null
  let rockets = []; // [id, lane, x, y, z, weapon]
  let reason = null, terminal = null;
  const events = [];
  const states = [];

  // Live asteroids of a lane at tick t inside the lateral reach, with their depth (section 8).
  const targetsIn = (laneIndex, t, px, py, halfWidth) => {
    const L = loopAt(t);
    const found = [];
    for (const part of [course[L], course[L + 1]]) {
      for (const r of part.byLane[laneIndex]) {
        if (dead.has(r[0]) || r[3] <= t) continue;
        const speed = NOTE_SPEED[r[4]];
        if (r[3] - SPAWN_Z / speed > t) continue;
        const dx = px - r[9], dy = py - r[10], reach = r[6] + halfWidth;
        if (dx * dx + dy * dy <= reach * reach) found.push({r, z: (r[3] - t) * speed});
      }
    }
    return found;
  };

  const damage = (r, hitPoints, t, code) => {
    const left = Math.max(0, hpLeft.get(r[0]) - hitPoints);
    hpLeft.set(r[0], left);
    events.push([t, 5, r[0], left]);
    if (left > 0) return;
    dead.add(r[0]);
    destroyed++;
    // NOTE 17 / NOTE 26 (sections 25.3, 26.3): ordinal = destroyed (1-based, just incremented).
    // Ordinals 1..5 take the guarantee without a draw; from 6 one draw per destruction, in
    // destruction-call order. Every destruction drops one pickup (26.3.1).
    const [kind, amount] = destroyed <= DROP_GUARANTEE.length ? guaranteedDrop(destroyed) : dropTier(drops() % 100);
    events.push([t, 6, r[0], code, kind, amount]); // NOTE 27 (R38.3)
    pickups.set(r[0], {id: r[0], kind, amount, lane: r[2], x: r[9], y: r[10], onset: r[3], speed: NOTE_SPEED[r[4]]});
  };

  const doHop = (t, buttons, laneCount) => {
    const dir = (buttons & 1) ? -1 : (buttons & 2) ? 1 : 0;
    if (dir === 0) return;
    let why = 0;
    if (lane + dir < 0 || lane + dir > laneCount - 1) why = 2;
    else if (t < hopReady) why = 3;
    else if (charge < HOP_COST) why = 4;
    if (why !== 0) { events.push([t, 2, why, dir < 0 ? 0 : 1]); return; }
    events.push([t, 1, lane, lane + dir]);
    lane += dir;
    charge -= HOP_COST;
    hopReady = t + HOP_COOLDOWN;
  };

  const doFire = (t, weapon) => {
    // NOTE 7, NOTE 24: one shared fire cooldown; the cooldown refusal names the selected weapon
    // and precedes the out-of-ammo refusal. Refused fires leave lastWeapon unchanged (NOTE 28).
    if (t < fireReady) { events.push([t, 4, 3, weapon.code]); return; }
    if (ammo < weapon.ammo_cost) { events.push([t, 6, 2]); return; }
    ammo -= weapon.ammo_cost;
    shots++;
    lastWeapon = weapon.id;
    events.push([t, 3, weapon.code, shots]);
    fireReady = t + weapon.cooldown_ticks;
    if (weapon.kind !== 'hitscan') { rockets.push([shots, lane, x, y, 0, weapon]); return; }
    let best = null;
    for (const c of targetsIn(lane, t, x, y, weapon.half_width)) {
      if (c.z > weapon.range_z) continue;
      if (best === null || c.z < best.z || (c.z === best.z && c.r[0] < best.r[0])) best = c;
    }
    if (best !== null) damage(best.r, weapon.damage, t, weapon.code);
  };

  const doBoost = t => {
    // NOTE 8: legal only at full charge; no success event; a refusal is [t, 6, 1].
    if (charge !== CHARGE_CAP) { events.push([t, 6, 1]); return; }
    charge = 0;
    boostUntil = t + BOOST_TICKS;
  };

  const doMove = (t, L, base) => {
    const [ax, ay] = thrust(sx, sy);
    const laneShape = base.lanes[lane];
    const seg = fdiv(t - loopStart(L), beatTicksOf(L % BASE_LOOPS)) % laneShape.length;
    const [cx, cy] = laneShape.curve[seg];
    vx = tdiv((vx + ax - cx * DRIFT_PER_CURVE) * 15, 16);
    vy = tdiv((vy + ay - cy * DRIFT_PER_CURVE) * 15, 16);
    const nx = x + vx, ny = y + vy, wall = SHIP_TRAVEL_RADIUS * SHIP_TRAVEL_RADIUS;
    if (nx * nx + ny * ny <= wall) { x = nx; y = ny; }
    else if (nx * nx + y * y <= wall) { x = nx; vy = 0; }
    else if (x * x + ny * ny <= wall) { y = ny; vx = 0; }
    else { vx = 0; vy = 0; }
  };

  const doRockets = t => {
    const flying = [];
    for (const rk of rockets) {
      const weapon = rk[5];
      rk[4] += weapon.speed;
      let best = null;
      for (const c of targetsIn(rk[1], t, rk[2], rk[3], weapon.half_width)) {
        if (c.z <= rk[4] && (best === null || c.r[0] < best[0])) best = c.r;
      }
      if (best !== null) { damage(best, weapon.damage, t, weapon.code); continue; }
      if (rk[4] <= weapon.range_z) flying.push(rk);
    }
    rockets = flying;
  };

  // Returns true on collision. NOTE 30 (spec 26.3.5, ruling R39): pickups are collected
  // automatically at their onset tick whatever the ship lane or position (the NOTE 6 lane and
  // sphere test are retired for pl-v3); every pickup despawns at that point.
  const doContact = (t, L) => {
    let collided = false;
    const r = course[L].atOnset.get(t * MAX_LANES + lane);
    if (r !== undefined) {
      if (!dead.has(r[0])) {
        const dx = x - r[9], dy = y - r[10], reach = SHIP_RADIUS + r[6];
        if (dx * dx + dy * dy < reach * reach) collided = true;
        else dodged++;
      }
    }
    // pickup collection (NOTE 30, spec 26.3.5, R39): every pickup whose onset is this tick is
    // collected automatically, whatever the ship lane or position (no lane, sphere or position
    // test), in destruction-call order (NOTE 31: Map insertion order), also on a collision tick
    // (NOTE 32). NOTE 29 (26.3.3): the pickup grants its own amount, clamped at the cap.
    for (const pk of pickups.values()) {
      if (pk.onset !== t) continue;
      if (pk.kind === 1) charge = Math.min(CHARGE_CAP, charge + pk.amount);
      else ammo = Math.min(ROCKET_CAP, ammo + pk.amount);
      events.push([t, 5, pk.kind, pk.x, pk.y]);
    }
    for (const [id, pk] of pickups) if (pk.onset <= t) pickups.delete(id); // NOTE 6: despawn after onset tick
    return collided;
  };

  const runTick = entry => {
    const t = states.length;
    const L = loopAt(t);
    buildThrough(L + 1);
    const base = bases[L % BASE_LOOPS];
    lane = Math.min(lane, base.lanes.length - 1);
    let buttons = 0;
    if (entry !== null) { buttons = entry[1]; sx = entry[2] + 0; sy = entry[3] + 0; }
    // NOTE 24 (26.2.2): the weapon of this tick is the player's: rocket while bit4 is set, else laser.
    const weapon = (buttons & ROCKET_SELECT) ? WEAPONS.rocket : WEAPONS.laser;
    doHop(t, buttons, base.lanes.length);
    // fire (spec 27.1/27.2, NOTE 36 to NOTE 38): bit2 is a LEVEL set by accepted entries;
    // without an entry the level persists; release closes the beam; only a rising edge fires
    // (NOTE 7/NOTE 24 unchanged on the edge: weapon by the edge entry's bit4, shared cooldown,
    // refusal order, held level never re-fires or refuses). The laser opens a beam; the old
    // hitscan path (doFire below) is no longer reached by pl-v3 fire.
    const wasLevel = fireLevel;
    if (entry !== null) fireLevel = (buttons & 4) ? 1 : 0;
    if (fireLevel === 0) beam = null;
    if (fireLevel === 1 && wasLevel === 0) {
      if (t < fireReady) { events.push([t, 4, 3, weapon.code]); }
      else if (ammo < weapon.ammo_cost) { events.push([t, 6, 2]); }
      else {
        ammo -= weapon.ammo_cost;
        shots++;
        lastWeapon = weapon.id;
        events.push([t, 3, weapon.code, shots]);
        fireReady = t + weapon.cooldown_ticks;
        // NOTE 37 (27.2.1): the laser opens a beam (new hit set) at t0 = t; the rocket is unchanged.
        if (weapon.id === 'laser') beam = {t0: t, reach: 0, hit: new Set()};
        else rockets.push([shots, lane, x, y, 0, weapon]);
      }
    }
    // beam step (NOTE 38, 27.2.2 to 27.2.6): every open tick, reach grows; each live rock with
    // 0 < z <= reach in the aim column not yet hit by this beam is hit once, (z asc, id asc),
    // for beamDamage(z) hit points (drop and guarantee logic unchanged via damage()).
    if (beam) {
      beam.reach = beamReach(beam.t0, t);
      const due = targetsIn(lane, t, x, y, BEAM_HALF_WIDTH)
        .filter(c => c.z > 0 && c.z <= beam.reach && !beam.hit.has(c.r[0]));
      due.sort((a, c) => a.z - c.z || a.r[0] - c.r[0]);
      for (const c of due) { beam.hit.add(c.r[0]); damage(c.r, beamDamage(c.z), t, WEAPONS.laser.code); }
    }
    if (buttons & 8) doBoost(t);
    doMove(t, L, base);
    doRockets(t);
    // NOTE 1, NOTE 9: z speed doubled while t < boost_until; the press tick is boosted.
    const boosting = t < boostUntil;
    distance += boosting ? 2 * Z_SPEED : Z_SPEED;
    const collided = doContact(t, L);
    states.push([t, lane, x, y, vx, vy, charge, dodged, destroyed, ammo, boosting ? 1 : 0, distance]);
    if (collided) { reason = 'collision'; terminal = t; }
    else if (limit !== null && t === limit - 1) { reason = 'complete'; terminal = limit; }
  };

  const game = {
    step(ticks, inputs) {
      if (reason !== null) return game.state();
      if (!Number.isSafeInteger(ticks) || ticks < 0) fail('out_of_range');
      validateInputs(inputs, mode);
      const first = states.length;
      for (const e of inputs) if (e[0] < first || e[0] - first >= ticks) fail('out_of_range');
      let cursor = 0;
      for (let n = 0; n < ticks && reason === null; n++) {
        const t = states.length;
        let entry = null;
        if (cursor < inputs.length && inputs[cursor][0] === t) entry = inputs[cursor++];
        runTick(entry);
      }
      return game.state();
    },
    abandon() {
      if (reason === null) { reason = 'abandoned'; terminal = states.length; } // NOTE 9
      return game.state();
    },
    // NOTE 11: exact key set; loop is the absolute L of the next tick (clamped in timed modes).
    state() {
      const processed = states.length;
      const L = loopAt(limit === null ? processed : Math.min(processed, limit - 1));
      const base = bases[L % BASE_LOOPS];
      return {ammo, boost_until: boostUntil, charge, destroyed, distance, dodged, fire_ready: fireReady,
        hop_ready: hopReady, lane, lane_count: base.lanes.length, loop: L, mode, position: [x, y], processed,
        ruleset_id: RULESET_ID, score: distance, seed, status: reason === null ? 'running' : 'ended',
        terminal_reason: reason, terminal_tick: terminal, velocity: [vx, vy], weapon: lastWeapon,
        // NOTE 39 (27.3.1, R40.4): beam state for the renderer; all previous keys unchanged.
        beam_hold: beam === null ? 0 : 1, beam_reach: beam === null ? 0 : beam.reach}; // NOTE 28
    },
    // View for the next tick p (NOTE 6, NOTE 11).
    view() {
      const p = states.length;
      const L = loopAt(p);
      buildThrough(L + 1);
      const asteroids = [];
      for (const part of [course[L], course[L + 1]]) {
        for (const r of part.rows) {
          if (dead.has(r[0])) continue;
          const speed = NOTE_SPEED[r[4]];
          if (r[3] - SPAWN_Z / speed <= p && p <= r[3]) asteroids.push([r[0], r[1], r[2], (r[3] - p) * speed, hpLeft.get(r[0])]);
        }
      }
      const live = [];
      for (const pk of pickups.values()) if (p <= pk.onset) live.push(pk);
      live.sort((a, c) => a.id - c.id);
      return {
        asteroids,
        pickups: live.map(pk => [pk.id, pk.kind, pk.lane, pk.x, pk.y, pk.onset - p, pk.amount]),
        rockets: rockets.map(rk => [rk[0], rk[1], rk[2], rk[3], rk[4]]),
      };
    },
    trace() {
      return {events: events.map(e => e.slice()), states: states.map(s => s.slice())};
    },
  };
  return game;
}

// render.js - WebGL2 tunnel renderer (FB3-W4, spec section 12). Presentation only.
// Consumes the rows app.js hands in (map, course, two state snapshots, view) and never
// drives the game: no game methods are called here and nothing computed here flows back
// into an input entry. No third-party libraries, no fetched assets, shaders are inline.
//
// World units: 1 unit = 1000 mu. x right, y up, -z ahead. The ship depth plane is z = 0.
// Lanes are parallel tubes side by side, lane j centred at x = j * LANE_SPACING (lane 0
// leftmost). Each tube centreline is integrated from its curve vectors per beat segment
// and is periodic with the lane length, so the tunnel repeats every `length` beats.
import {SHIPS, shipById, hexRgb} from './ships.js';

export const MU = 1000;
export const SEG = 120;            // world units per beat segment along the tube
export const LANE_SPACING = 330;   // centre to centre; tube diameter is 200
export const TUBE_R = 100;         // TUNNEL_RADIUS / MU
export const DEFAULT_SPAWN_Z = 1080000;
const RES = 16;                    // centreline samples per beat
const BLEND_BEATS = 1;             // centreline cross-fade at a loop seam
const MAX_OFF_X = 50, MAX_OFF_Y = 60; // keeps neighbouring tubes apart (330 - 2 * 50 > 200)
const CURVE_GAIN = 8;              // world units per (curve unit * beat^2)
const BEHIND = 70;                 // tube drawn behind the ship plane
const CAM_BACK = 38, CAM_UP = 15, CAM_AHEAD = 90;
// FB3-W4b R-4: minimum eye height above the ship (world units). The eye follows the ship's lateral
// y at 0.72, so at the top of the 92-unit travel disk CAM_UP alone left it about 11 units below;
// the floor keeps spec 12 "behind and slightly above" for every lateral offset, lane and hop.
const CAM_MIN_ABOVE = 6;
// FB3-W4b R-1 speed feel (presentation only; no sim state is read or written for these).
const DEG = Math.PI / 180;
const DESKTOP_FOVY = 66;           // deg, landscape and desktop (unchanged)
const PORTRAIT_HALF_FOV_X = 40;    // deg, horizontal half-angle the portrait branch aims for (was 37)
const PORTRAIT_FOVY_MAX = 112;     // deg, portrait vertical ceiling (was 100)
const RING_DENSITY = 6;            // minor rings per beat segment on the tube wall (was 4)
export const BEAT_SURGE = 4;       // world units the chase camera surges forward on each beat
export const BEAT_BOB = 0.6;       // world units of vertical dolly bob, one cycle per beat
export const BEAT_FOV_KICK = 3;    // deg added to fovy on the beat
// FB3-W4c R-1 (ruling R29): the R27 envelope exp(-6 * phase) restarted at 1 on every beat while it
// had decayed to 0.0025 just before, so surge, FOV kick and tube pulse stepped in a single frame at
// each beat boundary. The envelope is now a periodic C1 pulse of the beat phase: a smoothstep attack
// over BEAT_ATTACK of the beat, then a flat-ended decay to exactly 0 with zero slope at phase 1.
export const BEAT_ATTACK = 0.3;    // fraction of the beat spent rising to the peak
// FB3-SHIP R-5 (spec 19 SH-4): asteroid read distance. The sim streams asteroids from SPAWN_Z
// (360 units); these shape how they fade in and gain contrast. All fractions are of visDepth().
export const MESH_FOG_NEAR = 0.3;     // asteroid fog ramp start (was 0.45): wider, softer ramp
export const MESH_FOG_MIN = 0.55;     // shading kept at the far end (was 0.38): brighter far reads
export const MESH_HAZE = [0.05, 0.065, 0.1]; // far haze lift on asteroids (was none): silhouette vs void
export const EXIST_RAMP = 48;         // units over which a new asteroid fades in from spawn depth (was 0: pop)
export const TUBE_FOG_NEAR = 0.45;    // tube fog ramp start (unchanged)
export const TUBE_FOG_MID = 0.9;      // tube ramp reaches its floor here (was: fades to 0 at 1.0)
export const TUBE_FAR = 0.22;         // tube glow floor out to the spawn band (was 0): rocks occlude grid
export const TUBE_MINOR_FADE = [0.5, 0.85]; // minor rings thin out with depth (was none): no far moire
const BG = [0.012, 0.016, 0.04];      // clear colour; asteroids fade in from it
const SHIP_SCALE = 6.5;               // world units per ship-local unit (unchanged from the W4 mesh)
const glf = v => v.toFixed(4);
const LANE_COLORS = [[1.0, 0.35, 0.85], [0.3, 0.95, 0.9], [1.0, 0.72, 0.3], [0.45, 1.0, 0.45], [0.65, 0.5, 1.0]];
const SHAPE_COLORS = [[0.62, 0.55, 0.5], [0.55, 0.6, 0.68], [0.7, 0.5, 0.42], [0.5, 0.46, 0.42],
  [0.6, 0.56, 0.48], [0.45, 0.42, 0.46], [0.6, 0.7, 0.85], [0.66, 0.5, 0.55]];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const hermite = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Deterministic presentation hash (mulberry32 over a 32-bit key).
export function hash01(key) {
  let t = (key + 0x6D2B79F5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ track model (shared with render2d.js)
function integrateCurve(values, length) {
  const n = length * RES, h = 1 / RES;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= length;
  const p = new Float64Array(n);
  let acc = 0, pm = 0;
  for (let i = 0; i < n; i++) { p[i] = acc; pm += acc; acc += (values[Math.floor(i / RES)] - mean) * h; }
  pm /= n;
  const x = new Float64Array(n);
  let xm = 0;
  acc = 0;
  for (let i = 0; i < n; i++) { x[i] = acc; xm += acc; acc += (p[i] - pm) * h; }
  xm /= n;
  for (let i = 0; i < n; i++) x[i] = (x[i] - xm) * CURVE_GAIN;
  return x;
}

function fitAmplitude(x, limit) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const k = peak > limit ? limit / peak : 1;
  return Float32Array.from(x, v => v * k);
}

function laneShape(lane) {
  const length = Math.max(1, lane?.length | 0);
  const curve = Array.isArray(lane?.curve) && lane.curve.length === length ? lane.curve : Array.from({length}, () => [0, 0]);
  return {
    length, n: length * RES, curve,
    x: fitAmplitude(integrateCurve(curve.map(c => c[0]), length), MAX_OFF_X),
    y: fitAmplitude(integrateCurve(curve.map(c => c[1]), length), MAX_OFF_Y),
  };
}

export function createTrack(map) {
  const loops = [];
  let start = 0, beatsBefore = 0;
  for (const loop of map?.loops ?? []) {
    const beatTicks = 3600 / loop.bpm;
    loops.push({start, beatTicks, beats: loop.beats, beatsBefore, bpm: loop.bpm, weapon: loop.weapon, lanes: loop.lanes.map(laneShape)});
    start += loop.beats * beatTicks;
    beatsBefore += loop.beats;
  }
  if (!loops.length) {
    const flat = {length: 4, curve: [[1, 0], [0, 1], [-1, 0], [0, -1]]};
    loops.push({start: 0, beatTicks: 40, beats: 60, beatsBefore: 0, bpm: 90, weapon: 'laser', lanes: [flat, flat, flat].map(laneShape)});
  }
  const loopAtTick = t => { let i = 0; while (i + 1 < loops.length && t >= loops[i + 1].start) i++; return i; };
  const loopAtBeat = u => { let i = 0; while (i + 1 < loops.length && u >= loops[i + 1].beatsBefore) i++; return i; };
  // Total beats elapsed at presentation tick T (float); continues linearly past both ends.
  const beatsAt = T => { const L = loops[loopAtTick(T)]; return L.beatsBefore + (T - L.start) / L.beatTicks; };
  const sample = (loopIndex, lane, b, out, k) => {
    const sh = loops[loopIndex].lanes[lane];
    let ph = (b % sh.length) * RES;
    if (ph < 0) ph += sh.n;
    const i0 = Math.floor(ph) % sh.n, i1 = (i0 + 1) % sh.n, f = ph - Math.floor(ph);
    out[0] += k * lerp(sh.x[i0], sh.x[i1], f);
    out[1] += k * lerp(sh.y[i0], sh.y[i1], f);
  };
  // Centreline of integer lane at spatial coordinate s (units along the course). out = [x, y, exist].
  const centreInt = (lane, s, out) => {
    const u = s / SEG, i = loopAtBeat(u), L = loops[i], b = u - L.beatsBefore;
    out[0] = 0; out[1] = 0; out[2] = 0;
    if (lane < L.lanes.length) {
      out[2] = 1;
      const prev = i > 0 ? loops[i - 1] : null;
      if (prev && b < BLEND_BEATS && b >= 0) {
        const w = hermite(0, BLEND_BEATS, b);
        if (lane < prev.lanes.length) { sample(i - 1, lane, prev.beats + b, out, 1 - w); sample(i, lane, b, out, w); }
        else { sample(i, lane, b, out, 1); out[2] = w; }
      } else sample(i, lane, b, out, 1);
    } else {
      let j = i + 1;
      while (j < loops.length && lane >= loops[j].lanes.length) j++;
      if (j < loops.length) sample(j, lane, u - loops[j].beatsBefore, out, 1);
    }
    out[0] += lane * LANE_SPACING;
    return out;
  };
  const tmpA = [0, 0, 0], tmpB = [0, 0, 0];
  // Fractional lane (camera and ship smoothing on hops) blends the two neighbouring centrelines.
  const centre = (laneF, s, out = [0, 0, 0]) => {
    const l0 = Math.max(0, Math.floor(laneF)), f = laneF - l0;
    centreInt(l0, s, tmpA);
    if (f < 1e-4) { out[0] = tmpA[0]; out[1] = tmpA[1]; out[2] = tmpA[2]; return out; }
    centreInt(l0 + 1, s, tmpB);
    out[0] = lerp(tmpA[0], tmpB[0], f); out[1] = lerp(tmpA[1], tmpB[1], f); out[2] = Math.max(tmpA[2], tmpB[2]);
    return out;
  };
  const maxLanes = Math.max(...loops.map(L => L.lanes.length));
  return {loops, maxLanes, loopAtTick, beatsAt, sAt: T => SEG * beatsAt(T), centre, centreInt,
    laneCountAtS: s => loops[loopAtBeat(s / SEG)].lanes.length};
}

// R-2: rocket rows sampled at presentation time T. `hist` maps processed count p to a Map of
// id -> view row [id, lane, x, y, z] (the view after tick p - 1). A rocket in the rows at
// floor(T) or floor(T) + 1 is drawn: interpolated when in both, flying out of the muzzle when only
// in the later row, and carried on by its own last step over the tick in which it resolved when
// only in the earlier row (spec 12 presentation extrapolation; nothing is invented or fed back).
export function sampleRockets(hist, T) {
  const p0 = Math.floor(T), f = T - p0, out = [];
  const h0 = hist.get(p0), h1 = hist.get(p0 + 1), back = hist.get(p0 - 1);
  for (const [id, b] of h1 ?? []) {
    const a = h0?.get(id);
    if (a) out.push({id, lane: b[1], x: lerp(a[2], b[2], f), y: lerp(a[3], b[3], f), depth: lerp(a[4], b[4], f)});
    else out.push({id, lane: b[1], x: b[2], y: b[3], depth: h0 ? b[4] * f : b[4]});
  }
  for (const [id, a] of h0 ?? []) {
    if (h1?.has(id)) continue;
    const prior = back?.get(id), step = prior ? a[4] - prior[4] : a[4];
    out.push({id, lane: a[1], x: a[2], y: a[3], depth: a[4] + step * f});
  }
  return out;
}

// Vertical field of view (radians) for a viewport aspect w / h, before the beat kick.
// Landscape keeps 66 deg; portrait widens to a horizontal half-angle target under a ceiling.
export function fovyFor(aspect) {
  if (aspect >= 1) return DESKTOP_FOVY * DEG;
  return Math.min(PORTRAIT_FOVY_MAX * DEG, 2 * Math.atan(Math.tan(PORTRAIT_HALF_FOV_X * DEG) / aspect));
}

// R-1 beat envelope in [0, 1] of the beat phase (any real; only the fractional part is used).
// Value and first derivative are continuous everywhere, including the beat boundary:
// e(0) = e(1) = 0 and e'(0) = e'(1) = 0; at the peak (phase BEAT_ATTACK) e = 1 and e' = 0 on both
// sides. Decay g(u) = (1 - u)^4 (1 + 4u) has g(0) = 1, g'(0) = 0, g(1) = 0, g'(1) = 0.
export function beatEnvelope(phase) {
  const f = phase - Math.floor(phase);
  if (f < BEAT_ATTACK) { const t = f / BEAT_ATTACK; return t * t * (3 - 2 * t); }
  const u = (f - BEAT_ATTACK) / (1 - BEAT_ATTACK), v = 1 - u;
  return v * v * v * v * (1 + 4 * u);
}

// All beat-locked motion cues for presentation beat `beat` (float beats from track.beatsAt(T)),
// written into `out` so the frame path allocates nothing. surge: world units forward; bob: world
// units up; fovKick: radians; pulse: tube near-ring glow in [0, 1]. Reduced motion zeroes the
// motion cues and keeps the (non-motion) glow pulse.
export function beatCues(beat, reduced, out = {surge: 0, bob: 0, fovKick: 0, pulse: 0}) {
  const f = beat - Math.floor(beat), e = beatEnvelope(f);
  out.surge = reduced ? 0 : BEAT_SURGE * e;
  out.bob = reduced ? 0 : BEAT_BOB * Math.sin(f * 2 * Math.PI);
  out.fovKick = reduced ? 0 : BEAT_FOV_KICK * DEG * e;
  out.pulse = e;
  return out;
}

// ------------------------------------------------------------------ matrices (column-major)
const m4 = () => new Float32Array(16);
function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf; out[11] = -1; out[14] = 2 * far * near * nf;
  return out;
}
function normalize(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function lookAt(out, eye, target, up) {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross(up, z)), y = cross(z, x);
  out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
  out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
  out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
  out[12] = -dot(x, eye); out[13] = -dot(y, eye); out[14] = -dot(z, eye); out[15] = 1;
  return out;
}
const MUL_TMP = new Float32Array(16);
function mul(out, a, b) {
  const r = MUL_TMP;
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
  }
  out.set(r);
  return out;
}
// Model = T * basis(xA, yA, zA) * scale(sx, sy, sz).
function modelBasis(out, p, xA, yA, zA, sx, sy = sx, sz = sx) {
  out[0] = xA[0] * sx; out[1] = xA[1] * sx; out[2] = xA[2] * sx; out[3] = 0;
  out[4] = yA[0] * sy; out[5] = yA[1] * sy; out[6] = yA[2] * sy; out[7] = 0;
  out[8] = zA[0] * sz; out[9] = zA[1] * sz; out[10] = zA[2] * sz; out[11] = 0;
  out[12] = p[0]; out[13] = p[1]; out[14] = p[2]; out[15] = 1;
  return out;
}
function axisAngle(axis, angle) {
  const [x, y, z] = axis, c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [[t * x * x + c, t * x * y + s * z, t * x * z - s * y], [t * x * y - s * z, t * y * y + c, t * y * z + s * x],
    [t * x * z + s * y, t * y * z - s * x, t * z * z + c]];
}

// ------------------------------------------------------------------ procedural meshes
const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]].map(v => normalize([...v]));
const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];

// Triangles [[a, b, c], ...] of points -> interleaved Float32Array (pos3, normal3), flat shaded,
// normals pointing away from `centre`, bounding radius normalised to 1 when `unit`.
function flatMesh(tris, unit = true, centre = [0, 0, 0]) {
  let peak = 1;
  if (unit) { peak = 0; for (const t of tris) for (const p of t) peak = Math.max(peak, Math.hypot(p[0], p[1], p[2])); }
  const out = new Float32Array(tris.length * 18);
  let o = 0;
  for (let [a, b, c] of tris) {
    let n = normalize(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
    const m = [(a[0] + b[0] + c[0]) / 3 - centre[0], (a[1] + b[1] + c[1]) / 3 - centre[1], (a[2] + b[2] + c[2]) / 3 - centre[2]];
    if (dot(n, m) < 0) { [b, c] = [c, b]; n = [-n[0], -n[1], -n[2]]; }
    for (const p of [a, b, c]) { out[o++] = p[0] / peak; out[o++] = p[1] / peak; out[o++] = p[2] / peak; out[o++] = n[0]; out[o++] = n[1]; out[o++] = n[2]; }
  }
  return out;
}
const icoTris = () => ICO_F.map(f => f.map(i => ICO_V[i]));
function subdivide(tris) {
  const mid = (a, b) => normalize([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  const out = [];
  for (const [a, b, c] of tris) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]); }
  return out;
}
function rock(seed, amp, squash) {
  const dirs = Array.from({length: 6}, (_, i) => normalize([hash01(seed * 31 + i * 3) - 0.5, hash01(seed * 31 + i * 3 + 1) - 0.5, hash01(seed * 31 + i * 3 + 2) - 0.5]));
  const phase = dirs.map((_, i) => hash01(seed * 97 + i) * 6.283);
  const disp = p => {
    let r = 1;
    dirs.forEach((d, i) => { r += amp * Math.sin(dot(p, d) * (2.2 + i * 0.9) + phase[i]) / (1 + i * 0.4); });
    return [p[0] * r * squash[0], p[1] * r * squash[1], p[2] * r * squash[2]];
  };
  return flatMesh(subdivide(icoTris()).map(t => t.map(disp)));
}
function dodecaTris() {
  const cents = ICO_F.map(f => normalize([0, 1, 2].map(k => ICO_V[f[0]][k] + ICO_V[f[1]][k] + ICO_V[f[2]][k])));
  const tris = [];
  ICO_V.forEach((v, vi) => {
    const ring = ICO_F.map((f, fi) => f.includes(vi) ? cents[fi] : null).filter(Boolean);
    const u = normalize(cross(v, Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), w = cross(v, u);
    ring.sort((p, q) => Math.atan2(dot(p, w), dot(p, u)) - Math.atan2(dot(q, w), dot(q, u)));
    for (let i = 1; i + 1 < ring.length; i++) tris.push([ring[0], ring[i], ring[i + 1]]);
  });
  return tris;
}
function octaTris() {
  const P = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const tris = [];
  for (const x of [0, 1]) for (const y of [2, 3]) for (const z of [4, 5]) tris.push([P[x], P[y], P[z]]);
  return tris;
}
function shardTris() {
  const top = [0, 1, 0], bot = [0, -1, 0], ring = [];
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + 0.2; ring.push([Math.cos(a) * 0.36, (i % 2 ? 0.12 : -0.1), Math.sin(a) * 0.36]); }
  const tris = [];
  for (let i = 0; i < 6; i++) { const a = ring[i], b = ring[(i + 1) % 6]; tris.push([top, a, b], [bot, b, a]); }
  return tris;
}
function twinTris() {
  const ball = subdivide(icoTris());
  const place = (dx, s) => ball.map(t => t.map(p => [p[0] * s + dx, p[1] * s, p[2] * s]));
  return [place(-0.36, 0.62), place(0.4, 0.54)];
}
function buildShapes() {
  const twin = twinTris();
  const twinMesh = (() => {
    const a = flatMesh(twin[0], false, [-0.36, 0, 0]), b = flatMesh(twin[1], false, [0.4, 0, 0]);
    const out = new Float32Array(a.length + b.length); out.set(a); out.set(b, a.length);
    let peak = 0;
    for (let i = 0; i < out.length; i += 6) peak = Math.max(peak, Math.hypot(out[i], out[i + 1], out[i + 2]));
    for (let i = 0; i < out.length; i += 6) { out[i] /= peak; out[i + 1] /= peak; out[i + 2] /= peak; }
    return out;
  })();
  // Shape ids (spec 5.4): 0 ico, 1 dodeca, 2 octa, 3 rock_a, 4 rock_b, 5 rock_c, 6 shard, 7 twin.
  return [flatMesh(icoTris()), flatMesh(dodecaTris()), flatMesh(octaTris()), rock(3, 0.16, [1, 1, 1]),
    rock(4, 0.12, [1.15, 0.72, 0.95]), rock(5, 0.26, [1, 1.05, 0.9]), flatMesh(shardTris()), twinMesh];
}
// FB3-SHIP R-1: ship hull as an extruded plate of the model's plan view outline (ships.js).
// Ear clipping of a simple polygon given as [x, z] points; returns index triples.
export function triangulate(pts) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
  const sign = area >= 0 ? 1 : -1;
  const crossAt = (a, b, c) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * sign;
  const inside = (p, a, b, c) => crossAt(a, b, p) >= 0 && crossAt(b, c, p) >= 0 && crossAt(c, a, p) >= 0;
  const idx = Array.from({length: n}, (_, i) => i), tris = [];
  let guard = n * n;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length], ib = idx[k], ic = idx[(k + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (crossAt(a, b, c) <= 1e-12) continue;
      let blocked = false;
      for (const j of idx) if (j !== ia && j !== ib && j !== ic && inside(pts[j], a, b, c)) { blocked = true; break; }
      if (blocked) continue;
      tris.push([ia, ib, ic]); idx.splice(k, 1); clipped = true; break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

// Interleaved (pos3, normal3) Float32Array in ship-local units: top and bottom faces from the ear
// clipped outline plus one side wall quad per outline edge. The plate is `height` thick at the
// centreline and thins toward the wing tips; the belly sits flatter than the deck.
export function shipPlateMesh(model) {
  const pts = model.outline, n = pts.length, H = model.height;
  let maxX = 1e-6, area = 0;
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; maxX = Math.max(maxX, Math.abs(p[0])); area += p[0] * q[1] - q[0] * p[1]; }
  const top = pts.map(([x, z]) => [x, H * (1 - 0.7 * Math.abs(x) / maxX), z]);
  const bot = pts.map(([x, z]) => [x, -0.55 * H * (1 - 0.7 * Math.abs(x) / maxX), z]);
  const tris = triangulate(pts), out = new Float32Array((tris.length * 2 + n * 2) * 18);
  let o = 0;
  const emit = (a, b, c, want) => {
    let nn = normalize(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
    if (dot(nn, want) < 0) { [b, c] = [c, b]; nn = [-nn[0], -nn[1], -nn[2]]; }
    for (const p of [a, b, c]) { out[o++] = p[0]; out[o++] = p[1]; out[o++] = p[2]; out[o++] = nn[0]; out[o++] = nn[1]; out[o++] = nn[2]; }
  };
  for (const [i, j, k] of tris) { emit(top[i], top[j], top[k], [0, 1, 0]); emit(bot[i], bot[j], bot[k], [0, -1, 0]); }
  const s = area >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, dx = pts[j][0] - pts[i][0], dz = pts[j][1] - pts[i][1];
    const outward = [dz * s, 0, -dx * s];
    emit(top[i], top[j], bot[j], outward); emit(top[i], bot[j], bot[i], outward);
  }
  return out;
}

// ------------------------------------------------------------------ shaders
const TUBE_VS = n => `#version 300 es
#define RINGS ${n}
in vec2 aGrid;
uniform vec4 uRing[RINGS];
uniform mat4 uVP;
uniform float uDStart, uDStep, uSShip, uRadius;
out float vS; out float vAng; out float vD; out float vExist;
void main() {
  int i = int(aGrid.x + 0.5);
  vec4 r = uRing[i];
  float d = uDStart + aGrid.x * uDStep;
  vec3 p = vec3(r.x + cos(aGrid.y) * uRadius, r.y + sin(aGrid.y) * uRadius, -d);
  vS = uSShip + d; vAng = aGrid.y; vD = d; vExist = r.z;
  gl_Position = uVP * vec4(p, 1.0);
}`;
// FB3-SHIP R-5 tube fog: floor TUBE_FAR out to the spawn band, then out by visDepth.
const TUBE_FS = `#version 300 es
precision highp float;
in float vS; in float vAng; in float vD; in float vExist;
uniform vec3 uColor;
uniform float uFocus, uPulse, uVis, uSeg, uRingDensity;
out vec4 o;
float fadeRange(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float gridLine(float x, float width) {
  float d = abs(fract(x + 0.5) - 0.5);
  float w = fwidth(x) * width + 1e-4;
  return 1.0 - fadeRange(0.0, w, d);
}
void main() {
  float minor = gridLine(vS * uRingDensity / uSeg, 1.1);
  float beat = gridLine(vS / uSeg, 2.2);
  float lon = gridLine(vAng * 16.0 / 6.2831853, 1.0);
  minor *= 1.0 - fadeRange(uVis * ${glf(TUBE_MINOR_FADE[0])}, uVis * ${glf(TUBE_MINOR_FADE[1])}, vD);
  float fog = mix(1.0, ${glf(TUBE_FAR)}, fadeRange(uVis * ${glf(TUBE_FOG_NEAR)}, uVis * ${glf(TUBE_FOG_MID)}, vD))
    * (1.0 - fadeRange(uVis * ${glf(TUBE_FOG_MID)}, uVis, vD));
  float behind = fadeRange(-70.0, -10.0, vD);
  float nearPulse = uPulse * (1.0 - fadeRange(0.0, 160.0, vD));
  float glow = 0.035 + 0.28 * minor + 0.32 * lon + beat * (0.75 + 1.6 * nearPulse);
  o = vec4(uColor * glow * fog * behind * uFocus * vExist, 1.0);
}`;
const MESH_VS = `#version 300 es
in vec3 aPos; in vec3 aNor;
uniform mat4 uVP; uniform mat4 uM;
out vec3 vN; out vec3 vW;
void main() { vec4 w = uM * vec4(aPos, 1.0); vW = w.xyz; vN = mat3(uM) * aNor; gl_Position = uVP * w; }`;
const MESH_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW;
uniform vec3 uColor, uEmit, uCam, uHaze;
uniform float uFogFar, uFogMin, uExist;
out vec4 o;
float fadeRange(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(uCam - vW);
  float diff = max(dot(n, normalize(vec3(-0.4, 0.8, 0.45))), 0.0);
  float fill = max(dot(n, normalize(vec3(0.6, -0.3, 0.5))), 0.0) * 0.3;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.5);
  vec3 c = uColor * (0.14 + 0.85 * diff + fill) + uColor * rim * 0.7 + uEmit;
  // R-5: far objects keep uFogMin of their shading plus a faint haze lift (uHaze is zero outside
  // the asteroid pass), and uExist fades a new asteroid in from the clear colour.
  float t = fadeRange(uFogFar * ${glf(MESH_FOG_NEAR)}, uFogFar, -vW.z);
  vec3 col = mix(c, c * uFogMin + uHaze, t);
  o = vec4(mix(vec3(${BG.map(glf).join(', ')}), col, uExist), 1.0);
}`;
const STAR_VS = `#version 300 es
in vec4 aStar;
uniform mat4 uVPRot; uniform float uScale;
out float vB;
void main() { vec4 p = uVPRot * vec4(aStar.xyz, 1.0); gl_Position = vec4(p.xy, p.w * 0.99999, p.w); gl_PointSize = aStar.w * uScale; vB = aStar.w; }`;
const STAR_FS = `#version 300 es
precision mediump float;
in float vB; out vec4 o;
void main() { float r = length(gl_PointCoord - 0.5); float a = clamp(1.0 - r * 2.0, 0.0, 1.0); o = vec4(vec3(0.75, 0.82, 1.0) * a * a * (0.25 + vB * 0.2), 1.0); }`;
const FS_VS = `#version 300 es
out vec2 vUv;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const BRIGHT_FS = `#version 300 es
precision mediump float;
in vec2 vUv; uniform sampler2D uTex; out vec4 o;
void main() { vec3 c = texture(uTex, vUv).rgb; float l = max(c.r, max(c.g, c.b)); o = vec4(c * max(l - 0.42, 0.0) / max(l, 1e-3) * 1.6, 1.0); }`;
const BLUR_FS = `#version 300 es
precision mediump float;
in vec2 vUv; uniform sampler2D uTex; uniform vec2 uDir; out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.2270270;
  c += (texture(uTex, vUv + uDir * 1.3846154).rgb + texture(uTex, vUv - uDir * 1.3846154).rgb) * 0.3162162;
  c += (texture(uTex, vUv + uDir * 3.2307692).rgb + texture(uTex, vUv - uDir * 3.2307692).rgb) * 0.0702703;
  o = vec4(c, 1.0);
}`;
const COMP_FS = `#version 300 es
precision mediump float;
in vec2 vUv; uniform sampler2D uScene, uBloom; uniform float uBloomK; uniform vec3 uFlash; out vec4 o;
void main() {
  vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uBloomK;
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.55;
  o = vec4(c + uFlash, 1.0);
}`;

// ------------------------------------------------------------------ renderer
const QUALITY = {high: {rings: 160, sides: 40, stars: true, bloom: true, dpr: 2}, low: {rings: 64, sides: 16, stars: false, bloom: false, dpr: 1}};

export function createRenderer(opts = {}) {
  const canvas = opts.canvas;
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('webgl2: no canvas');
  const gl = canvas.getContext('webgl2', {antialias: true, alpha: false, depth: true, powerPreference: 'high-performance'});
  if (!gl) throw new Error('webgl2: context unavailable');

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error('webgl2 shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const program = (vs, fs, names) => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('webgl2 link: ' + gl.getProgramInfoLog(p));
    const u = {};
    for (const n of names) u[n] = gl.getUniformLocation(p, n);
    return {p, u};
  };

  const meshProg = program(MESH_VS, MESH_FS, ['uVP', 'uM', 'uColor', 'uEmit', 'uCam', 'uFogFar', 'uFogMin', 'uHaze', 'uExist']);
  const starProg = program(STAR_VS, STAR_FS, ['uVPRot', 'uScale']);
  const brightProg = program(FS_VS, BRIGHT_FS, ['uTex']);
  const blurProg = program(FS_VS, BLUR_FS, ['uTex', 'uDir']);
  const compProg = program(FS_VS, COMP_FS, ['uScene', 'uBloom', 'uBloomK', 'uFlash']);
  const tubeProgs = {};
  const tubeProgram = q => (tubeProgs[q.rings] ??= program(TUBE_VS(q.rings), TUBE_FS,
    ['uRing', 'uVP', 'uDStart', 'uDStep', 'uSShip', 'uRadius', 'uColor', 'uFocus', 'uPulse', 'uVis', 'uSeg', 'uRingDensity']));

  const meshVao = data => {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(meshProg.p, 'aPos'), norLoc = gl.getAttribLocation(meshProg.p, 'aNor');
    gl.enableVertexAttribArray(posLoc); gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(norLoc); gl.vertexAttribPointer(norLoc, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    return {vao, count: data.length / 6};
  };
  const shapes = buildShapes().map(meshVao);
  // R-1: one hull VAO per registry model, built once; colours parsed once (no per-frame work).
  const shipKits = new Map(SHIPS.map(m => [m.id, {model: m, mesh: meshVao(shipPlateMesh(m)),
    hull: hexRgb(m.colors.hull), accent: hexRgb(m.colors.accent), engine: hexRgb(m.colors.engine)}]));
  let shipKit = shipKits.get(shipById(opts.ship).id);
  const octa = meshVao(flatMesh(octaTris()));
  const emptyVao = gl.createVertexArray();

  const tubeMeshes = {};
  const tubeMesh = q => {
    const key = q.rings + 'x' + q.sides;
    if (tubeMeshes[key]) return tubeMeshes[key];
    const verts = new Float32Array(q.rings * (q.sides + 1) * 2);
    let o = 0;
    for (let r = 0; r < q.rings; r++) for (let s = 0; s <= q.sides; s++) { verts[o++] = r; verts[o++] = s / q.sides * Math.PI * 2; }
    const idx = new Uint16Array((q.rings - 1) * q.sides * 6);
    o = 0;
    for (let r = 0; r + 1 < q.rings; r++) for (let s = 0; s < q.sides; s++) {
      const a = r * (q.sides + 1) + s, b = a + q.sides + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = a + 1; idx[o++] = a + 1; idx[o++] = b; idx[o++] = b + 1;
    }
    const prog = tubeProgram(q);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog.p, 'aGrid');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return (tubeMeshes[key] = {vao, count: idx.length, ring: new Float32Array(q.rings * 4)});
  };

  const stars = (() => {
    const n = 1400, data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const u = hash01(i * 3 + 11) * 2 - 1, a = hash01(i * 3 + 12) * Math.PI * 2, r = Math.sqrt(1 - u * u);
      data.set([Math.cos(a) * r * 1000, u * 1000, Math.sin(a) * r * 1000, 0.6 + hash01(i * 3 + 13) ** 3 * 2.6], i * 4);
    }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(starProg.p, 'aStar');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return {vao, count: n};
  })();

  // Offscreen targets for bloom (high quality only).
  let targets = null;
  const makeTarget = (w, h, depth) => {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    if (depth) { rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb); }
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return {tex, fb, rb, w, h, ok};
  };
  const freeTargets = () => {
    if (!targets) return;
    for (const t of [targets.scene, targets.a, targets.b]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); if (t.rb) gl.deleteRenderbuffer(t.rb); }
    targets = null;
  };
  let bloomBroken = false;
  const ensureTargets = (w, h) => {
    if (targets && targets.w === w && targets.h === h) return targets;
    freeTargets();
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    targets = {w, h, scene: makeTarget(w, h, true), a: makeTarget(hw, hh, false), b: makeTarget(hw, hh, false)};
    if (!targets.scene.ok || !targets.a.ok || !targets.b.ok) { freeTargets(); bloomBroken = true; }
    return targets;
  };

  // ---------------------------------------------------------------- presentation state
  let settings = {quality: 'high', reduced_motion: false, ...(opts.settings ?? {})};
  let track = createTrack(null), course = [];
  let spawnZ = Number.isFinite(opts.spawnZ) && opts.spawnZ > 0 ? opts.spawnZ : DEFAULT_SPAWN_Z;
  let observedZ = 0;
  const live = new Map();            // asteroid id -> presentation entry
  // R-2: rocket rows per processed count p (view after tick p - 1), sampled at presentation time T.
  let rocketHist = new Map(), lastView = null, lastProcessed = -1;
  let particles = [], beams = [];
  let shipLaneF = 1, camLaneF = 1, camLaneVel = 0, shake = 0, flash = [0, 0, 0], effectTime = 0, lastNow = null;
  let lastLane = null, lastFireReady = 0, lastLocked = false, endHandled = false;
  let lostHandler = typeof opts.onLost === 'function' ? opts.onLost : null;
  const onLost = () => { lostHandler?.(); };
  canvas.addEventListener('webglcontextlost', onLost);

  const visDepth = () => Math.max(spawnZ, observedZ) / MU + 40;

  function resetRun() {
    live.clear(); rocketHist = new Map(); lastView = null; lastProcessed = -1;
    particles = []; beams = []; shake = 0; flash = [0, 0, 0];
    lastLane = null; lastFireReady = 0; lastLocked = false; endHandled = false;
  }

  function explode(pos, color, count, speed, size) {
    for (let i = 0; i < count; i++) {
      const k = particles.length + i * 7 + Math.floor(effectTime * 1000);
      const d = normalize([hash01(k) - 0.5, hash01(k + 1) - 0.5, hash01(k + 2) - 0.5]);
      const v = speed * (0.4 + hash01(k + 3) * 0.8);
      particles.push({p: [...pos], v: [d[0] * v, d[1] * v, d[2] * v], life: 0, max: 0.5 + hash01(k + 4) * 0.5, c: color, s: size * (0.5 + hash01(k + 5))});
    }
  }

  // `trail` (optional) is app.js's per-tick list of {p, state, view} rows, oldest first. Every
  // tick since the last sync is consumed, so a frame that ran several ticks loses no fire and
  // no short-lived rocket row (the FB3 owner report of intermittent weapons).
  function syncView(view, p, prev, curr, trail) {
    if (!view || view === lastView) return;
    lastView = view;
    const seen = new Set(), hits = [];
    for (const a of view.asteroids ?? []) {
      const [id, , , z, hp] = a, row = course[id];
      if (!row) continue;
      seen.add(id);
      if (z > observedZ) observedZ = z;
      let e = live.get(id);
      if (!e) { e = {id, row, speed: 0, hp, flash: 0, passing: false, pos: [0, 0, 0], axis: null}; live.set(id, e); }
      if (row[3] > p) e.speed = z / (row[3] - p);
      if (hp < e.hp) { e.flash = 1; e.hitAt = effectTime; hits.push({lane: row[2], target: e, end: null}); }
      e.hp = hp;
    }
    for (const [id, e] of live) {
      if (seen.has(id) || e.passing) continue;
      if (e.row[3] < p) e.passing = true;
      else {
        hits.push({lane: e.row[2], target: null, end: [...e.pos]});
        explode(e.pos, [1, 0.7, 0.35], 26, 90, e.row[6] / MU * 0.18); live.delete(id);
      }
    }
    const rows = Array.isArray(trail) && trail.length ? trail : [{p, state: curr, view}];
    for (const entry of rows) {
      if (!entry?.view || entry.p <= lastProcessed && rocketHist.has(entry.p)) continue;
      rocketHist.set(entry.p, new Map((entry.view.rockets ?? []).map(r => [r[0], r])));
    }
    for (const k of rocketHist.keys()) if (k < p - 32) rocketHist.delete(k);
    if (curr && prev && curr.processed !== lastProcessed) {
      // fire_ready only moves when a shot is accepted (tick t sets it to t + cooldown), so a rise
      // against the last seen value marks exactly one fire tick: the [t, 3, code, shots] event.
      for (const entry of rows) {
        const s = entry?.state;
        if (!s || entry.p <= lastProcessed || !(s.fire_ready > lastFireReady)) continue;
        lastFireReady = s.fire_ready;
        const fireTick = Math.max(0, entry.p - 1);
        const weapon = track.loops[track.loopAtTick(fireTick)]?.weapon ?? s.weapon;
        // Same-tick resolves: the nearest hit in the firing lane this sync (live or just destroyed).
        let best = null;
        const before = rocketHist.get(entry.p - 1);
        const launched = weapon !== 'laser' && (entry.view?.rockets ?? []).some(r => !before?.has(r[0]));
        for (const h of launched ? [] : hits) {
          if (h.lane !== s.lane) continue;
          const z = h.target ? h.target.pos[2] : h.end[2];
          if (!best || z > best.z) best = {...h, z};
        }
        beams.push({weapon, life: 0, max: weapon === 'laser' ? 0.2 : 0.24, target: best?.target ?? null, end: best?.end ?? null,
          length: weapon === 'laser' ? 240 : 0});
        if (!settings.reduced_motion) shake = Math.max(shake, weapon === 'laser' ? 0.05 : 0.12);
      }
      lastFireReady = Math.max(lastFireReady, curr.fire_ready);
      lastProcessed = curr.processed;
      if (lastLane !== null && curr.lane !== lastLane && !settings.reduced_motion) shake = Math.max(shake, 0.12);
      lastLane = curr.lane;
      const locked = curr.locked_until > curr.processed;
      if (locked && !lastLocked && !settings.reduced_motion) shake = Math.max(shake, 0.3);
      lastLocked = locked;
    }
  }

  const VP = m4(), P = m4(), V = m4(), VR = m4(), VPR = m4(), M = m4();
  const cues = {surge: 0, bob: 0, fovKick: 0, pulse: 0};
  const cA = [0, 0, 0], cB = [0, 0, 0];
  let quality = QUALITY[settings.quality] ?? QUALITY.high;

  function resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, quality.dpr);
    const w = Math.max(1, Math.round((canvas.clientWidth || canvas.width) * dpr));
    const h = Math.max(1, Math.round((canvas.clientHeight || canvas.height) * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return [w, h];
  }

  function drawMesh(mesh, model, color, emit) {
    gl.uniformMatrix4fv(meshProg.u.uM, false, model);
    gl.uniform3fv(meshProg.u.uColor, color);
    gl.uniform3fv(meshProg.u.uEmit, emit);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  }
  // Scalar variant for the R-1/R-5 paths: no colour arrays are built per draw.
  function drawMesh6(mesh, model, r, g, b, er, eg, eb) {
    gl.uniformMatrix4fv(meshProg.u.uM, false, model);
    gl.uniform3f(meshProg.u.uColor, r, g, b);
    gl.uniform3f(meshProg.u.uEmit, er, eg, eb);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  }
  // Ship-local point (x, y, z) * SHIP_SCALE -> world, using the frame's ship basis.
  const shipBasis = {pos: [0, 0, 0], right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1]};
  const shipPt = [0, 0, 0];
  const toWorld = (x, y, z) => {
    const {pos, right, up, back} = shipBasis, k = SHIP_SCALE;
    for (let i = 0; i < 3; i++) shipPt[i] = pos[i] + (right[i] * x + up[i] * y + back[i] * z) * k;
    return shipPt;
  };

  function draw(frame = {}) {
    if (gl.isContextLost()) return;
    const now = Number.isFinite(frame.now) ? frame.now : performance.now();
    const dtReal = lastNow === null ? 0 : clamp((now - lastNow) / 1000, 0, 0.1);
    lastNow = now;
    const dt = frame.paused ? 0 : dtReal;
    effectTime += dt;
    quality = QUALITY[settings.quality] ?? QUALITY.high;
    const reduced = Boolean(settings.reduced_motion);
    const [w, h] = resize();

    // ---- presentation time and ship pose (float only; never fed back)
    let T, sx = 0, sy = 0, vx = 0, lane = 1, curr = null, prev = null, alive = true;
    if (frame.curr) {
      curr = frame.curr; prev = frame.prev ?? curr;
      const a = clamp(Number(frame.alpha) || 0, 0, 1);
      T = curr.processed - 2 + a;
      sx = lerp(prev.position[0], curr.position[0], a) / MU;
      sy = lerp(prev.position[1], curr.position[1], a) / MU;
      vx = lerp(prev.velocity[0], curr.velocity[0], a);
      lane = curr.lane;
      syncView(frame.view, curr.processed, prev, curr, frame.trail);
      if (curr.status === 'ended' && !endHandled) {
        endHandled = true;
        if (curr.terminal_reason === 'collision') {
          alive = false;
          for (const [id, e] of live) if (e.row[3] === curr.terminal_tick && e.row[2] === curr.lane) { explode(e.pos, [1, 0.6, 0.3], 30, 110, 2.4); live.delete(id); }
          if (!reduced) shake = 1;
          flash = reduced ? [0.12, 0.05, 0.02] : [0.55, 0.25, 0.1];
          explode([track.centre(lane, track.sAt(T))[0] + sx, track.centre(lane, track.sAt(T))[1] + sy, 0], [0.4, 1, 0.95], 40, 120, 2);
        } else if (curr.terminal_reason === 'complete') flash = reduced ? [0.05, 0.1, 0.1] : [0.2, 0.45, 0.42];
      }
      if (curr.status === 'ended' && curr.terminal_reason === 'collision') alive = false;
    } else {
      T = (Number(frame.cruise) || 0) * 60;
      lane = 1;
      sx = Math.sin(T / 140) * 22; sy = Math.cos(T / 190) * 14 - 6;
    }
    const sShip = track.sAt(T);

    // ---- lane smoothing on hops (camera slower than ship)
    const kShip = 1 - Math.exp(-dtReal / 0.07), kCam = 1 - Math.exp(-dtReal / 0.15);
    shipLaneF += (lane - shipLaneF) * (dtReal > 0 ? kShip : 1);
    const before = camLaneF;
    camLaneF += (lane - camLaneF) * (dtReal > 0 ? kCam : 1);
    camLaneVel = dtReal > 0 ? (camLaneF - before) / dtReal : 0;

    // ---- beat-locked motion cues (W4b R-1, W4c R-1): continuous C1 functions of the presentation
    // beat (T carries alpha, so the phase is not quantized per tick); no allocation here.
    beatCues(track.beatsAt(T), reduced, cues);
    const camBack = CAM_BACK - cues.surge;
    const bob = cues.bob;

    // ---- camera
    const cBack = track.centre(camLaneF, sShip - camBack, [0, 0, 0]);
    const cAhead = track.centre(camLaneF, sShip + CAM_AHEAD, [0, 0, 0]);
    shake *= Math.exp(-dt * 4.5);
    const jx = reduced ? 0 : shake * 3.2 * Math.sin(effectTime * 41), jy = reduced ? 0 : shake * 3.2 * Math.sin(effectTime * 37 + 1.3);
    const eye = [cBack[0] + sx * 0.72 + jx, cBack[1] + sy * 0.72 + CAM_UP + jy + bob, camBack];
    // R-4: floor the eye above the ship. The ship is drawn on the smoothed lane and the sim lane is
    // its hop target; the higher of the two centrelines is the reference, so a hop never dips it.
    const shipY = Math.max(track.centre(shipLaneF, sShip, cA)[1], track.centre(lane, sShip, cB)[1]) + sy;
    eye[1] = Math.max(eye[1], shipY + CAM_MIN_ABOVE);
    const target = [cAhead[0] + sx * 0.45 + jx * 0.5, cAhead[1] + sy * 0.45 + 5 + jy * 0.5, -CAM_AHEAD];
    const roll = reduced ? 0 : clamp(camLaneVel * 0.045 + vx / 3750 * 0.1, -0.3, 0.3);
    const fwd = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    const R = axisAngle(fwd, roll), up = [R[1][0], R[1][1], R[1][2]];
    const aspect = w / h;
    const fovy = fovyFor(aspect) + cues.fovKick;
    const vis = visDepth();
    perspective(P, fovy, aspect, 0.5, vis + CAM_BACK + 200);
    lookAt(V, eye, target, up);
    mul(VP, P, V);
    VR.set(V); VR[12] = 0; VR[13] = 0; VR[14] = 0;
    mul(VPR, P, VR);

    // ---- targets
    const useBloom = quality.bloom && !bloomBroken && ensureTargets(w, h) && targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, useBloom ? targets.scene.fb : null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.012, 0.016, 0.04, 1); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE);

    // ---- starfield (high)
    if (quality.stars) {
      gl.useProgram(starProg.p);
      gl.uniformMatrix4fv(starProg.u.uVPRot, false, VPR);
      gl.uniform1f(starProg.u.uScale, Math.min(globalThis.devicePixelRatio || 1, quality.dpr));
      gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(stars.vao); gl.drawArrays(gl.POINTS, 0, stars.count);
    }

    // ---- opaque: asteroids and ship
    gl.disable(gl.BLEND); gl.depthMask(true);
    gl.useProgram(meshProg.p);
    gl.uniformMatrix4fv(meshProg.u.uVP, false, VP);
    gl.uniform3fv(meshProg.u.uCam, eye);
    gl.uniform1f(meshProg.u.uFogFar, vis);
    gl.uniform1f(meshProg.u.uFogMin, MESH_FOG_MIN);
    gl.uniform3f(meshProg.u.uHaze, MESH_HAZE[0], MESH_HAZE[1], MESH_HAZE[2]);
    const spawnD = spawnZ / MU;
    for (const [id, e] of live) {
      const row = e.row, speed = e.speed || 3600;
      const d = (row[3] - T) * speed / MU;
      if (e.passing && d < -BEHIND) { live.delete(id); continue; }
      // R-5: fade in from the clear colour over EXIST_RAMP units after spawn depth (no pop-in).
      gl.uniform1f(meshProg.u.uExist, 1 - hermite(spawnD - EXIST_RAMP, spawnD, d));
      track.centreInt(row[2], sShip + d, cA);
      e.pos[0] = cA[0] + row[9] / MU; e.pos[1] = cA[1] + row[10] / MU; e.pos[2] = -d;
      if (!e.axis) {
        const k = id * 8 + row[8];
        e.axis = normalize([hash01(k * 5) - 0.5, hash01(k * 5 + 1) - 0.5, hash01(k * 5 + 2) - 0.5]);
        e.rate = (0.004 + hash01(k * 5 + 3) * 0.02) * (hash01(k * 5 + 4) < 0.5 ? -1 : 1);
        e.phase = hash01(k * 5 + 5) * 6.283;
        const base = SHAPE_COLORS[row[8] % 8], j = 0.85 + hash01(k * 5 + 6) * 0.3;
        e.color = base.map(c => c * j);
      }
      const r = axisAngle(e.axis, e.phase + e.rate * T);
      modelBasis(M, e.pos, r[0], r[1], r[2], row[6] / MU);
      e.flash = Math.max(0, e.flash - dt * 5);
      const inLane = row[2] === lane;
      const dim = inLane ? 1 : 0.5;
      const warn = inLane && d < 120 && d > -5 ? (1 - d / 120) * 0.22 : 0;
      drawMesh(shapes[row[8] % 8], M, e.color.map(c => c * dim),
        [e.flash * 1.2 + warn * 1.0, e.flash * 0.8 + warn * 0.25, e.flash * 0.5 + warn * 0.15]);
    }
    gl.uniform1f(meshProg.u.uExist, 1);
    gl.uniform3f(meshProg.u.uHaze, 0, 0, 0);
    let shipPos = null;
    if (alive) {
      track.centre(shipLaneF, sShip, cA);
      track.centre(shipLaneF, sShip + 12, cB);
      shipPos = [cA[0] + sx, cA[1] + sy, 0];
      const f = normalize([cB[0] - cA[0], cB[1] - cA[1], -12]);
      let right = normalize(cross(f, [0, 1, 0])), upv = cross(right, f);
      const bank = clamp(vx / 3750 * (reduced ? 0.3 : 0.7) + (lane - shipLaneF) * (reduced ? 0.4 : 1.2), -1.1, 1.1);
      const rb = axisAngle(f, bank);
      const rot = v => [rb[0][0] * v[0] + rb[1][0] * v[1] + rb[2][0] * v[2], rb[0][1] * v[0] + rb[1][1] * v[1] + rb[2][1] * v[2], rb[0][2] * v[0] + rb[1][2] * v[1] + rb[2][2] * v[2]];
      right = rot(right); upv = rot(upv);
      const back = shipBasis.back;
      back[0] = -f[0]; back[1] = -f[1]; back[2] = -f[2];
      shipBasis.pos = shipPos; shipBasis.right = right; shipBasis.up = upv;
      modelBasis(M, shipPos, right, upv, back, SHIP_SCALE);
      const locked = curr ? curr.locked_until > curr.processed : false;
      const pulse = locked ? 0.5 + 0.5 * Math.sin(effectTime * 18) : 0;
      // R-1: the selected model's hull; the exhaust-lock pulse still swings it toward warning red.
      const {mesh, hull, accent, model} = shipKit;
      drawMesh6(mesh, M, Math.max(0, hull[0] + pulse * 0.6), Math.max(0, hull[1] - pulse * 0.4), Math.max(0, hull[2] - pulse * 0.5),
        hull[0] * 0.09 + pulse * 0.3, hull[1] * 0.14, hull[2] * 0.15);
      // Canopy bubble on the deck, in the accent colour.
      const cp = model.canopy;
      const cw = toWorld(0, model.height * 0.85, cp.z);
      modelBasis(M, cw, right, upv, back, cp.w * SHIP_SCALE, model.height * 0.55 * SHIP_SCALE, cp.l * SHIP_SCALE);
      drawMesh6(octa, M, accent[0] * 0.55, accent[1] * 0.55, accent[2] * 0.55, accent[0] * 0.22, accent[1] * 0.22, accent[2] * 0.22);
    }

    // ---- additive: tubes, engine, rockets, beams, particles
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
    const tube = tubeMesh(quality), tp = tubeProgram(quality);
    gl.useProgram(tp.p);
    gl.uniformMatrix4fv(tp.u.uVP, false, VP);
    const dStart = -BEHIND, dStep = (vis + 20 - dStart) / (quality.rings - 1);
    gl.uniform1f(tp.u.uDStart, dStart); gl.uniform1f(tp.u.uDStep, dStep); gl.uniform1f(tp.u.uSShip, sShip);
    gl.uniform1f(tp.u.uRadius, TUBE_R); gl.uniform1f(tp.u.uVis, vis); gl.uniform1f(tp.u.uSeg, SEG);
    gl.uniform1f(tp.u.uRingDensity, RING_DENSITY);
    gl.uniform1f(tp.u.uPulse, cues.pulse);
    gl.bindVertexArray(tube.vao);
    for (let j = 0; j < track.maxLanes; j++) {
      let any = false;
      for (let i = 0; i < quality.rings; i++) {
        track.centreInt(j, sShip + dStart + i * dStep, cA);
        tube.ring[i * 4] = cA[0]; tube.ring[i * 4 + 1] = cA[1]; tube.ring[i * 4 + 2] = cA[2]; tube.ring[i * 4 + 3] = 0;
        if (cA[2] > 0) any = true;
      }
      if (!any) continue;
      gl.uniform4fv(tp.u.uRing, tube.ring);
      gl.uniform3fv(tp.u.uColor, LANE_COLORS[j % LANE_COLORS.length]);
      gl.uniform1f(tp.u.uFocus, Math.abs(j - camLaneF) < 0.5 ? 1 : 0.42);
      gl.drawElements(gl.TRIANGLES, tube.count, gl.UNSIGNED_SHORT, 0);
    }

    gl.useProgram(meshProg.p);
    const zero = [0, 0, 0];
    if (shipPos) {
      // R-1: one engine glow per thruster rect of the selected model, in its engine colour.
      const g = 0.8 + 0.2 * Math.sin(effectTime * 30), {engine, model} = shipKit;
      const {right, up, back} = shipBasis;
      for (const t of model.thrusters) {
        modelBasis(M, toWorld(t.x, t.y, t.z - 0.05), right, up, back, t.w * 0.6 * SHIP_SCALE * g, t.h * 1.05 * SHIP_SCALE * g, 2.6 * g);
        drawMesh6(octa, M, 0, 0, 0, engine[0], engine[1], engine[2]);
      }
    }
    // Rockets at presentation time T (same clock as ship and asteroids), every frame until resolved.
    for (const r of curr ? sampleRockets(rocketHist, T) : []) {
      const depth = r.depth / MU;
      track.centreInt(r.lane, sShip + depth, cA);
      const px = cA[0] + r.x / MU, py = cA[1] + r.y / MU;
      modelBasis(M, [px, py, -depth], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1.8, 1.8, 5);
      drawMesh(octa, M, zero, [1.3, 0.7, 0.2]);
      modelBasis(M, [px, py, -depth + 9], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1.1, 1.1, 8);
      drawMesh(octa, M, zero, [0.6, 0.22, 0.06]);
    }
    beams = beams.filter(b => (b.life += dt) < b.max);
    for (const b of beams) {
      if (!shipPos) break;
      const fade = 1 - b.life / b.max;
      const end = b.target && live.has(b.target.id) ? b.target.pos : b.end;
      const laser = b.weapon === 'laser';
      if (laser) {
        // Laser muzzle flash at the nose, so a same-tick hitscan resolve is always seen.
        modelBasis(M, [shipPos[0], shipPos[1], -12], [1, 0, 0], [0, 1, 0], [0, 0, 1], 2.2 * fade + 0.6);
        drawMesh(octa, M, zero, [1.4 * fade, 0.3 * fade, 0.4 * fade]);
      } else {
        modelBasis(M, [shipPos[0], shipPos[1], -6], [1, 0, 0], [0, 1, 0], [0, 0, 1], 3 * fade + 0.5);
        drawMesh(octa, M, zero, [1.2 * fade, 0.6 * fade, 0.2 * fade]);
      }
      // Laser: beam always (hitscan). Rocket: a streak only when it resolved before any row showed it.
      if (laser || end) {
        const len = end ? Math.max(4, -end[2]) : b.length;
        const ex = end ? end[0] : track.centre(shipLaneF, sShip + len, cB)[0] + sx, ey = end ? end[1] : cB[1] + sy;
        const mid = [(shipPos[0] + ex) / 2, (shipPos[1] + ey) / 2, -len / 2];
        const zf = normalize([ex - shipPos[0], ey - shipPos[1], -len]);
        const xr = normalize(cross(zf, [0, 1, 0])), yr = cross(xr, zf);
        const k = laser ? 0.55 : 0.9;
        modelBasis(M, mid, xr, yr, zf, k * fade + 0.15, k * fade + 0.15, len / 2);
        drawMesh(octa, M, zero, laser ? [1.6 * fade, 0.25 * fade, 0.35 * fade] : [1.3 * fade, 0.6 * fade, 0.15 * fade]);
      }
    }
    particles = particles.filter(q => (q.life += dt) < q.max);
    for (const q of particles) {
      q.p[0] += q.v[0] * dt; q.p[1] += q.v[1] * dt; q.p[2] += q.v[2] * dt;
      q.v[0] *= Math.exp(-dt * 2); q.v[1] *= Math.exp(-dt * 2); q.v[2] *= Math.exp(-dt * 2);
      const f = 1 - q.life / q.max;
      modelBasis(M, q.p, [1, 0, 0], [0, 1, 0], [0, 0, 1], q.s * (0.4 + f));
      drawMesh(octa, M, zero, q.c.map(c => c * f * 1.4));
    }
    gl.depthMask(true);
    flash = flash.map(c => c * Math.exp(-dt * 3));

    // ---- post (high): bright pass, two blur passes at half resolution, composite
    if (useBloom) {
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.bindVertexArray(emptyVao);
      const pass = (prog, dst, src, setup) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
        gl.viewport(0, 0, dst ? dst.w : w, dst ? dst.h : h);
        gl.useProgram(prog.p);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
        setup?.();
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      const {scene, a: ta, b: tb} = targets;
      pass(brightProg, ta, scene, () => gl.uniform1i(brightProg.u.uTex, 0));
      for (let i = 0; i < 2; i++) {
        pass(blurProg, tb, ta, () => { gl.uniform1i(blurProg.u.uTex, 0); gl.uniform2f(blurProg.u.uDir, (1 + i) / ta.w, 0); });
        pass(blurProg, ta, tb, () => { gl.uniform1i(blurProg.u.uTex, 0); gl.uniform2f(blurProg.u.uDir, 0, (1 + i) / ta.h); });
      }
      pass(compProg, null, scene, () => {
        gl.uniform1i(compProg.u.uScene, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ta.tex);
        gl.uniform1i(compProg.u.uBloom, 1); gl.uniform1f(compProg.u.uBloomK, 1.25);
        gl.uniform3fv(compProg.u.uFlash, flash);
      });
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.bindVertexArray(null);
  }

  return {
    kind: 'webgl2',
    setCourse(map, rows) { track = createTrack(map); course = Array.isArray(rows) ? rows : []; resetRun(); shipLaneF = camLaneF = 1; },
    setSettings(next) { settings = {...settings, ...(next ?? {})}; },
    setSpawnZ(z) { if (Number.isFinite(z) && z > 0) spawnZ = z; },
    // R-1: unknown ids fall back to the default model. Returns the id actually in use.
    setShip(modelId) { shipKit = shipKits.get(shipById(modelId).id); return shipKit.model.id; },
    shipId: () => shipKit.model.id,
    visibleDepthMu: () => visDepth() * MU,
    onContextLost(fn) { lostHandler = typeof fn === 'function' ? fn : null; },
    draw,
    dispose() { canvas.removeEventListener('webglcontextlost', onLost); freeTargets(); lostHandler = null; },
  };
}

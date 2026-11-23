// Game over flow (spec section 18 GO-1..GO-4, ruling R31; pl-v3 card spec 22, ruling R35).
// Presentation only: this module reads one finished-run summary row handed over by the client
// loop and never touches the sim, the save or the network. The only storage it touches is the
// best distance store pl-best-v1 (R35.7), read when the game over modal opens and written by the
// controller after a record card has been drawn; renderCard itself stays pure. All DOM is created
// here with createElement and textContent (no innerHTML from run data); index.html carries no
// markup for it.
import {shipById, shipIdOrDefault, traceOutline, outlineBounds, hexRgb} from './ships.js';
import {qrMatrix} from './qr.js';
import {encodeChallenge} from './challenge.js';
import {formatKm, MODE_LABELS} from './hud.js';
import {MODES} from '../src/sim/space_racer_v3.js';

// pl-v2 tier thresholds over the final score (survived ticks, 0..7200). Each loop section lasts
// 2400 ticks, so a tier marks how far into the course the run got: SILVER reached loop 2,
// GOLD reached loop 3, MYTHIC cleared the whole course. Highest first. Only legacy pl-v2 runs
// (a decoded v1 challenge) use these.
export const TIERS = Object.freeze([
  Object.freeze({name: 'MYTHIC', min: 7200}),
  Object.freeze({name: 'GOLD', min: 4800}),
  Object.freeze({name: 'SILVER', min: 2400}),
  Object.freeze({name: 'BRONZE', min: 0}),
]);
export function tierFor(score) { return TIERS.find(t => score >= t.min) ?? TIERS[TIERS.length - 1]; }

// pl-v3 tier bands by KM (spec 22): < 3000 BRONZE, < 6000 SILVER, < 9000 GOLD, >= 9000 PLATINUM.
// MYTHIC is not a band: it is reserved for a record card (finished distance strictly greater than
// the saved best, see BEST_KEY), and a non-record card keeps its band even at high distance.
export const RULESET_V3 = 'pl-v3';
export const KM_TIERS = Object.freeze([
  Object.freeze({name: 'PLATINUM', min: 9000}),
  Object.freeze({name: 'GOLD', min: 6000}),
  Object.freeze({name: 'SILVER', min: 3000}),
  Object.freeze({name: 'BRONZE', min: 0}),
]);
export const MYTHIC_TIER = Object.freeze({name: 'MYTHIC', min: null});
// R35.11: KM = floor(distance / 1000); the raw mu integer stays in the payload and the store.
export const kmOf = distance => (Number.isSafeInteger(distance) && distance > 0 ? Math.floor(distance / 1000) : 0);
export function kmTierFor(km) { return KM_TIERS.find(t => km >= t.min) ?? KM_TIERS[KM_TIERS.length - 1]; }
const isV3 = d => d.ruleset === RULESET_V3;
// The tier a normalized result is drawn with: pl-v3 MYTHIC on a record card, else its KM band;
// pl-v2 by survived ticks.
export function cardTier(d) {
  if (!isV3(d)) return tierFor(d.score);
  return d.record ? MYTHIC_TIER : kmTierFor(kmOf(d.distance));
}

// Best distance store (R35.7, spec 22): localStorage key pl-best-v1 holding
// {best_distance, best_mode, best_date}, same discipline as pl-ship (every access guarded; a
// missing, unreadable or malformed value reads as no best). A record is strictly greater.
export const BEST_KEY = 'pl-best-v1';
export function parseBest(text) {
  if (typeof text !== 'string') return null;
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object' || !Number.isSafeInteger(v.best_distance) || v.best_distance < 0) return null;
  return {best_distance: v.best_distance, best_mode: typeof v.best_mode === 'string' ? v.best_mode : null,
    best_date: typeof v.best_date === 'string' ? v.best_date : null};
}
export function readBest(storage) {
  try { return parseBest(storage?.getItem?.(BEST_KEY) ?? null); } catch { return null; }
}
export function isNewRecord(distance, best) {
  return Number.isSafeInteger(distance) && distance > (best ? best.best_distance : 0);
}
// Write the result as the new best; false when storage is missing or refuses the write.
export function writeBest(storage, d) {
  try {
    if (typeof storage?.setItem !== 'function') return false;
    storage.setItem(BEST_KEY, JSON.stringify({best_distance: d.distance, best_mode: d.mode, best_date: d.date}));
    return true;
  } catch { return false; }
}
const groupDigits = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// mm:ss from ticks. `tps` is the sim TICKS_PER_SECOND, handed in by the client loop.
export function formatTime(ticks, tps) {
  const total = Number.isFinite(ticks) && ticks > 0 && tps > 0 ? Math.floor(ticks / tps) : 0;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const HEADLINES = {
  collision: ['Hull breach', 'Game over'],
  complete: ['Course clear', 'Run complete'],
  abandoned: ['Signal lost', 'Run ended'],
};
export function flavorText(reason, loops) {
  if (reason === 'complete') return 'All three loops cleared. The pulse bows to you.';
  if (reason === 'collision') return `An asteroid found your hull in loop ${loops}. The tunnel keeps the score.`;
  return 'You pulled out of the tunnel early. The lanes will wait.';
}
// pl-v3 flavor line: the distance is the score (spec 21.6).
export function flavorTextV3(d) {
  const km = formatKm(d.distance);
  if (d.record) return `New record: ${km} KM. The tunnel remembers this one.`;
  if (d.reason === 'complete') return `${MODE_LABELS[d.mode] ?? 'Timed'} run complete at ${km} KM. The pulse bows to you.`;
  if (d.reason === 'collision') return `An asteroid found your hull at ${km} KM. The tunnel keeps the distance.`;
  return 'You pulled out of the tunnel early. The lanes will wait.';
}
const flavorFor = d => (isV3(d) ? flavorTextV3(d) : flavorText(d.reason, d.loops));

// Plain-number summary from the client loop: {score, ticks, tps, loops, loopCount, lanes, lane,
// weapon, seed, ruleset, reason, date, maxTicks, ship, settings}, plus for pl-v3 runs (spec 22)
// {distance, mode, destroyed, dodged, minerals, gems, boosts} and the record flag. Anything
// malformed falls back to a safe value; an unknown or missing ship id becomes SHIP_DEFAULT
// (ships.js).
// FB3-QR R-3: `settings` ({music_level, mute, quality, reduced_motion}, the lobby settings the run
// was played with) plus the raw seed give the challenge code. Missing or invalid data gives
// challenge null (the card is drawn without a QR); it never throws.
// Idempotent: normalizeResult(normalizeResult(r)) equals normalizeResult(r) field for field (the
// app normalizes in show() and again in renderCard), so every input the challenge needs is
// carried through on the normalized object.
export function normalizeResult(r = {}) {
  r = r && typeof r === 'object' ? r : {};
  const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : d);
  const str = (v, d) => (typeof v === 'string' && v ? v : d);
  const mu = (v, d) => (Number.isSafeInteger(v) && v >= 0 ? v : d);
  const d = {
    score: int(r.score), ticks: int(r.ticks, int(r.score)), tps: int(r.tps, 60) || 60,
    loops: int(r.loops, 1) || 1, loopCount: int(r.loopCount, 3) || 3,
    lanes: Math.min(8, Math.max(1, int(r.lanes, 3))), lane: int(r.lane, 1),
    weapon: str(r.weapon, 'laser'), seed: int(r.seed) >>> 0, ruleset: str(r.ruleset, 'pl-v2'),
    reason: str(r.reason, 'collision'), date: str(r.date, '0000-00-00'), maxTicks: int(r.maxTicks, 7200) || 7200,
    ship: shipIdOrDefault(r.ship), selfie: r.selfie ?? null,
    // Carried through so a second normalization (modal show() then Make card) recomputes the same
    // challenge: a plain copy of the four lobby settings, or null when r.settings is not an object.
    settings: r.settings && typeof r.settings === 'object'
      ? {music_level: r.settings.music_level, mute: r.settings.mute, quality: r.settings.quality,
        reduced_motion: r.settings.reduced_motion} : null,
  };
  const v3 = isV3(d);
  // pl-v3 (spec 22): distance in raw mu (summary distance, else dist, else score), the session
  // mode, the secondary stat row and the record flag. null / 0 / false for pl-v2 runs.
  d.distance = v3 ? mu(r.distance, mu(r.dist, mu(r.score, 0))) : null;
  d.mode = v3 && MODES.includes(r.mode) ? r.mode : null;
  for (const k of ['destroyed', 'dodged', 'minerals', 'gems', 'boosts']) d[k] = int(r[k], 0);
  d.record = v3 && r.record === true;
  d.challenge = challengeFor(r, d);
  return d;
}

// The PLR1 code of this run (challenge.js), or null when any needed value is missing/invalid.
// pl-v3 runs always carry a v: 2 payload with mode and dist (R35.6, reference NOTE 13: exactly the
// section 20 settings plus mode, dist and score = dist); pl-v2 runs keep the v: 1 payload.
export function challengeFor(r, d) {
  try {
    const s = d.settings;
    if (!s || !Number.isInteger(r.seed)) return null;
    const preset = {seed: r.seed, ship: d.ship, music_level: s.music_level, mute: s.mute, quality: s.quality,
      reduced_motion: s.reduced_motion};
    if (isV3(d)) {
      if (!d.mode || d.distance === null) return null;
      return encodeChallenge({...preset, v: 2, ruleset: RULESET_V3, mode: d.mode, dist: d.distance, score: d.distance});
    }
    if (!Number.isInteger(r.score)) return null;
    return encodeChallenge({...preset, ruleset: d.ruleset, score: d.score, loops: d.loops, time: formatTime(d.ticks, d.tps)});
  } catch { return null; }
}

// ------------------------------------------------------------------ achievement card (GO-2)
// 1080x1350 (4:5). renderCard(ctx, data) is pure: it only issues CanvasRenderingContext2D calls on
// the ctx it is given. No I/O, no remote assets, no clock, no Math.random (the art is seeded by
// the run seed, so the same run always draws the same card).
export const CARD_W = 1080, CARD_H = 1350;
const ART = Object.freeze({x: 66, y: 206, w: 948, h: 640});
const PORTRAIT = Object.freeze({x: 96, y: 236, w: 272, h: 340});
const FONT = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
// Foil stops, ink (text accent), glow tint and the selfie duotone [shadow, highlight] per tier.
const TIER_STYLE = {
  BRONZE: {foil: ['#3d1d0c', '#c9773a', '#ffd6a8', '#8a4a1f', '#e9a267', '#4a2410'], ink: '#ffcf9e', glow: [233, 140, 70],
    duo: ['#2a1206', '#ffd2a0']},
  SILVER: {foil: ['#4b5566', '#c9d3e6', '#ffffff', '#8592a8', '#e6ecf7', '#3e4757'], ink: '#eef3ff', glow: [185, 205, 235],
    duo: ['#141b2e', '#eef4ff']},
  GOLD: {foil: ['#5e3f08', '#e0a82e', '#fff1b8', '#a8761a', '#ffd76a', '#4d3306'], ink: '#ffe28a', glow: [242, 193, 78],
    duo: ['#2b1a02', '#ffe9a8']},
  PLATINUM: {foil: ['#26323d', '#9fbccd', '#f4fbff', '#6f8ea3', '#dff2ff', '#1f2a33'], ink: '#e8f9ff', glow: [160, 225, 255],
    duo: ['#0c1a26', '#e6fbff']},
  MYTHIC: {foil: ['#ff5bd6', '#7c9bff', '#69e2d3', '#fff1b8', '#ff5bd6', '#7c9bff'], ink: '#ffffff', glow: [255, 91, 214],
    duo: ['#3c0b52', '#9ff6ff']},
};
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// mulberry32 over the run seed: small, fast, deterministic.
export function seededRng(seed) {
  let a = ((seed >>> 0) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function foil(ctx, style, x0, y0, x1, y1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  style.foil.forEach((c, i) => g.addColorStop(i / (style.foil.length - 1), c));
  return g;
}
function text(ctx, value, x, y, {font, color, align = 'left', max}) {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  if (max) ctx.fillText(value, x, y, max); else ctx.fillText(value, x, y);
}

function drawFrame(ctx, style, rng) {
  // Foil rim with a diagonal sheen and seeded sparkles, then the dark card body inside it.
  roundRect(ctx, 0, 0, CARD_W, CARD_H, 48);
  ctx.fillStyle = foil(ctx, style, 0, 0, CARD_W, CARD_H); ctx.fill();
  const sheen = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  sheen.addColorStop(0, 'rgba(255,255,255,0)'); sheen.addColorStop(0.42, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.45)'); sheen.addColorStop(0.58, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen; ctx.fill();
  for (let i = 0; i < 36; i++) {
    const side = i % 4, k = rng();
    const x = side === 0 ? k * CARD_W : side === 1 ? CARD_W - 15 : side === 2 ? k * CARD_W : 15;
    const y = side === 0 ? 15 : side === 1 ? k * CARD_H : side === 2 ? CARD_H - 15 : k * CARD_H;
    const s = 3 + rng() * 6;
    ctx.beginPath();
    ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.25, y - s * 0.25); ctx.lineTo(x + s, y); ctx.lineTo(x + s * 0.25, y + s * 0.25);
    ctx.lineTo(x, y + s); ctx.lineTo(x - s * 0.25, y + s * 0.25); ctx.lineTo(x - s, y); ctx.lineTo(x - s * 0.25, y - s * 0.25);
    ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${(0.35 + rng() * 0.5).toFixed(3)})`; ctx.fill();
  }
  roundRect(ctx, 30, 30, CARD_W - 60, CARD_H - 60, 30);
  const body = ctx.createLinearGradient(0, 30, 0, CARD_H - 30);
  body.addColorStop(0, '#0d1230'); body.addColorStop(0.55, '#070a1c'); body.addColorStop(1, '#04050d');
  ctx.fillStyle = body; ctx.fill();
  const tint = ctx.createRadialGradient(CARD_W / 2, 40, 10, CARD_W / 2, 40, 760);
  tint.addColorStop(0, rgba(style.glow, 0.32)); tint.addColorStop(1, rgba(style.glow, 0));
  ctx.fillStyle = tint; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = rgba(style.glow, 0.55); ctx.stroke();
}

function drawHeader(ctx, style) {
  const ink = ctx.createLinearGradient(0, 70, 0, 150);
  ink.addColorStop(0, '#ffffff'); ink.addColorStop(1, style.ink);
  ctx.save();
  ctx.shadowColor = rgba(style.glow, 0.7); ctx.shadowBlur = 24;
  text(ctx, 'PULSE LANES', 76, 142, {font: `italic 900 92px ${FONT}`, color: ink, max: 700});
  ctx.restore();
  text(ctx, 'SPACE RACER  ·  ACHIEVEMENT', 80, 184, {font: `700 26px ${MONO}`, color: rgba(style.glow, 0.95), max: 700});
}

function drawBadge(ctx, tier, style) {
  const {cx, cy} = BADGE, r = 80;
  ctx.save();
  ctx.shadowColor = rgba(style.glow, 0.8); ctx.shadowBlur = 30;
  ctx.beginPath();
  for (let i = 0; i < 12; i++) { // twelve-point burst rim
    const a = -Math.PI / 2 + i * Math.PI / 6, rr = i % 2 ? r * 0.9 : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = foil(ctx, style, cx - r, cy - r, cx + r, cy + r); ctx.fill();
  ctx.restore();
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.74, 0, Math.PI * 2);
  const core = ctx.createRadialGradient(cx, cy - 20, 4, cx, cy, r * 0.74);
  core.addColorStop(0, '#1b2350'); core.addColorStop(1, '#05060f');
  ctx.fillStyle = core; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = style.ink; ctx.stroke();
  text(ctx, 'TIER', cx, cy - 18, {font: `700 18px ${MONO}`, color: rgba(style.glow, 1), align: 'center'});
  text(ctx, tier.name, cx, cy + 22, {font: `italic 900 ${tier.name.length > 6 ? 26 : 34}px ${FONT}`, color: style.ink, align: 'center', max: 108});
}

// Mythic treatment (spec 22: unique foil/halo plus a NEW RECORD badge), record cards only. The
// halo is a prismatic burst behind the tier badge; the ribbon sits on the top right of the art.
const BADGE = Object.freeze({cx: 942, cy: 118});
function drawMythicHalo(ctx, style) {
  const {cx, cy} = BADGE;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(cx, cy, 60, cx, cy, 170);
  halo.addColorStop(0, rgba(style.glow, 0.55)); halo.addColorStop(0.5, 'rgba(124,155,255,0.22)'); halo.addColorStop(1, 'rgba(105,226,211,0)');
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, 170, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 24; i++) { // prismatic rays
    const a = i * Math.PI / 12, r0 = 92, r1 = i % 2 ? 128 : 156;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineWidth = i % 2 ? 2 : 3; ctx.strokeStyle = foil(ctx, style, cx - r1, cy - r1, cx + r1, cy + r1); ctx.stroke();
  }
  ctx.restore();
}
export const RECORD_RIBBON = Object.freeze({x: 790, y: 222, w: 208, h: 46});
function drawRecordRibbon(ctx, style) {
  const {x, y, w, h} = RECORD_RIBBON;
  ctx.save();
  ctx.shadowColor = rgba(style.glow, 0.9); ctx.shadowBlur = 24;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = foil(ctx, style, x, y, x + w, y + h); ctx.fill();
  ctx.restore();
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
  text(ctx, 'NEW RECORD', x + w / 2, y + 32, {font: `italic 900 26px ${FONT}`, color: '#120424', align: 'center', max: w - 24});
}

// Seeded starfield: a few hundred arcs of varied size, tint and brightness, plus flares.
function drawStarfield(ctx, rng, style) {
  const tints = [[255, 255, 255], [190, 255, 250], [255, 210, 250], [210, 220, 255], style.glow];
  for (let i = 0; i < 340; i++) {
    const x = ART.x + rng() * ART.w, y = ART.y + rng() * ART.h, size = 0.5 + rng() ** 3 * 2.6;
    const c = tints[Math.floor(rng() * tints.length)], alpha = 0.35 + rng() * 0.65;
    ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = rgba(c, alpha.toFixed(3)); ctx.fill();
    if (size > 2.3) {
      ctx.beginPath(); ctx.moveTo(x - size * 5, y); ctx.lineTo(x + size * 5, y); ctx.moveTo(x, y - size * 5); ctx.lineTo(x, y + size * 5);
      ctx.lineWidth = 1; ctx.strokeStyle = rgba(c, (alpha * 0.6).toFixed(3)); ctx.stroke();
    }
  }
}

function drawArt(ctx, d, style, rng) {
  const {x, y, w, h} = ART;
  ctx.save();
  roundRect(ctx, x, y, w, h, 22);
  ctx.clip();
  // Vanishing point of the tunnel, nudged by the seed.
  const vx = x + w * (0.52 + (rng() - 0.5) * 0.3), vy = y + h * (0.34 + (rng() - 0.5) * 0.12);
  const space = ctx.createRadialGradient(vx, vy, 10, vx, vy, w * 0.9);
  space.addColorStop(0, '#1a1f4a'); space.addColorStop(0.5, '#0a0d26'); space.addColorStop(1, '#020309');
  ctx.fillStyle = space; ctx.fillRect(x, y, w, h);
  // Nebula clouds.
  ctx.globalCompositeOperation = 'lighter';
  const clouds = [style.glow, [105, 226, 211], [255, 91, 214], [124, 155, 255]];
  for (let i = 0; i < 5; i++) {
    const cx = x + rng() * w, cy = y + rng() * h * 0.8, cr = 160 + rng() * 260;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
    g.addColorStop(0, rgba(clouds[i % clouds.length], (0.16 + rng() * 0.16).toFixed(3))); g.addColorStop(1, rgba(clouds[i % clouds.length], 0));
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  }
  ctx.globalCompositeOperation = 'source-over';
  drawStarfield(ctx, rng, style);
  // Speed streaks out of the vanishing point.
  for (let i = 0; i < 30; i++) {
    const a = rng() * Math.PI * 2, r0 = 70 + rng() * 90, r1 = r0 + 140 + rng() * 460;
    ctx.beginPath(); ctx.moveTo(vx + Math.cos(a) * r0, vy + Math.sin(a) * r0); ctx.lineTo(vx + Math.cos(a) * r1, vy + Math.sin(a) * r1);
    ctx.lineWidth = 1 + rng() * 2; ctx.strokeStyle = `rgba(200,230,255,${(0.08 + rng() * 0.2).toFixed(3)})`; ctx.stroke();
  }
  drawTube(ctx, d, style, rng, vx, vy);
  drawShip(ctx, d, style, vx, vy);
  // Vignette.
  const vig = ctx.createRadialGradient(x + w / 2, y + h / 2, h * 0.35, x + w / 2, y + h / 2, w * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = vig; ctx.fillRect(x, y, w, h);
  ctx.restore();
  roundRect(ctx, x, y, w, h, 22);
  ctx.lineWidth = 6; ctx.strokeStyle = foil(ctx, style, x, y, x + w, y + h); ctx.stroke();
}

// Curved tunnel: rings along a seeded quadratic curve from below the window into the vanishing
// point, lane rails along the tube floor, a pulse glow at the far end and a few asteroids.
function drawTube(ctx, d, style, rng, vx, vy) {
  const p0 = [ART.x + ART.w * 0.5, ART.y + ART.h + 280];
  const c = [ART.x + ART.w * (0.15 + rng() * 0.7), ART.y + ART.h * (0.5 + rng() * 0.2)];
  const at = s => [(1 - s) ** 2 * p0[0] + 2 * (1 - s) * s * c[0] + s * s * vx, (1 - s) ** 2 * p0[1] + 2 * (1 - s) * s * c[1] + s * s * vy];
  const rings = [];
  for (let i = 0; i < 18; i++) {
    const r = 620 / (1 + 0.45 * i), s = 1 - r / 620;
    const [cx, cy] = at(s), [nx, ny] = at(Math.min(1, s + 0.02));
    rings.push({cx, cy, r, tilt: Math.atan2(ny - cy, nx - cx) + Math.PI / 2});
  }
  const glow = ctx.createRadialGradient(vx, vy, 0, vx, vy, 120);
  glow.addColorStop(0, 'rgba(255,255,255,0.95)'); glow.addColorStop(0.25, rgba(style.glow, 0.6)); glow.addColorStop(1, rgba(style.glow, 0));
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(vx, vy, 120, 0, Math.PI * 2); ctx.fill();
  for (let i = rings.length - 1; i >= 0; i--) {
    const {cx, cy, r, tilt} = rings[i], fade = 1 - i / rings.length;
    ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.86, tilt * 0.25, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * 0.05); ctx.strokeStyle = `rgba(105,226,211,${(0.06 + 0.1 * fade).toFixed(3)})`; ctx.stroke();
    ctx.lineWidth = Math.max(1, r * 0.008); ctx.strokeStyle = `rgba(160,245,235,${(0.25 + 0.6 * fade).toFixed(3)})`; ctx.stroke();
  }
  // Lane rails on the tube floor; the ship's lane glows brighter.
  const lanes = d.lanes, spread = 0.36;
  for (let k = 0; k < lanes; k++) {
    const theta = Math.PI / 2 + (k - (lanes - 1) / 2) * spread;
    ctx.beginPath();
    rings.forEach(({cx, cy, r}, i) => {
      const px = cx + Math.cos(theta) * r, py = cy + Math.sin(theta) * r * 0.86;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    const active = k === Math.min(d.lane, lanes - 1);
    ctx.lineWidth = active ? 5 : 3; ctx.strokeStyle = active ? 'rgba(255,91,214,0.95)' : 'rgba(255,91,214,0.45)'; ctx.stroke();
  }
  // Asteroids: jagged seeded polygons inside the tube.
  for (let i = 0; i < 5; i++) {
    const ring = rings[3 + Math.floor(rng() * 10)], a = rng() * Math.PI * 2, off = rng() * 0.6;
    const ax = ring.cx + Math.cos(a) * ring.r * off, ay = ring.cy + Math.sin(a) * ring.r * 0.86 * off, size = Math.max(8, ring.r * 0.12);
    ctx.beginPath();
    for (let v = 0; v < 9; v++) {
      const va = v / 9 * Math.PI * 2, vr = size * (0.7 + rng() * 0.45);
      ctx.lineTo(ax + Math.cos(va) * vr, ay + Math.sin(va) * vr);
    }
    ctx.closePath();
    const rock = ctx.createRadialGradient(ax - size * 0.3, ay - size * 0.3, 1, ax, ay, size * 1.2);
    rock.addColorStop(0, '#8d8597'); rock.addColorStop(1, '#2a2533');
    ctx.fillStyle = rock; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,220,200,0.35)'; ctx.stroke();
  }
}

// FB3-SHIP R-3: plan view of a registry model (ships.js outline, canopy and thrusters), nose up,
// centred on its outline bounds at (cx, cy) with `scale` px per ship unit. The shapes live only
// in ships.js; the card and the lobby picker both draw through here. `glow` (a CSS colour) adds a
// soft halo under the hull; `flame` lights the thrusters.
export function drawShipPlan(ctx, modelOrId, cx, cy, scale, {glow = null, flame = true} = {}) {
  const model = typeof modelOrId === 'string' || !modelOrId ? shipById(modelOrId) : modelOrId;
  const [x0, z0, x1, z1] = outlineBounds(model);
  const ox = cx - (x0 + x1) / 2 * scale, oy = cy - (z0 + z1) / 2 * scale;
  const rgb = hex => hexRgb(hex, 255).map(Math.round);
  const hull = rgb(model.colors.hull), accent = rgb(model.colors.accent), engine = rgb(model.colors.engine);
  if (flame) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const t of model.thrusters) {
      const fx = ox + t.x * scale, fy = oy + (t.z + 0.12) * scale, r = Math.max(0.22, t.w) * scale * 1.4;
      const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, r);
      g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.3, rgba(engine, 0.8)); g.addColorStop(1, rgba(engine, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  ctx.save();
  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = Math.max(6, scale * 0.35); }
  traceOutline(ctx, model, ox, oy, scale);
  const body = ctx.createLinearGradient(0, oy + z0 * scale, 0, oy + z1 * scale);
  body.addColorStop(0, rgba(hull, 1)); body.addColorStop(0.5, rgba(hull.map(c => Math.round(c * 0.42)), 1)); body.addColorStop(1, '#070912');
  ctx.fillStyle = body; ctx.fill();
  ctx.restore();
  // Deck sheen and spine, clipped to the hull, then the accent trim.
  ctx.save();
  traceOutline(ctx, model, ox, oy, scale);
  ctx.clip();
  const sheen = ctx.createLinearGradient(ox + x0 * scale, 0, ox + x1 * scale, 0);
  sheen.addColorStop(0, 'rgba(0,0,0,0.35)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0.22)'); sheen.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = sheen; ctx.fillRect(ox + x0 * scale, oy + z0 * scale, (x1 - x0) * scale, (z1 - z0) * scale);
  ctx.beginPath(); ctx.moveTo(ox, oy + z0 * scale); ctx.lineTo(ox, oy + z1 * scale);
  ctx.lineWidth = Math.max(1, scale * 0.02); ctx.strokeStyle = rgba(accent, 0.45); ctx.stroke();
  for (const t of model.thrusters) {
    ctx.fillStyle = rgba(engine, 0.9);
    ctx.fillRect(ox + (t.x - t.w / 2) * scale, oy + (t.z - 0.08) * scale, t.w * scale, 0.16 * scale);
  }
  ctx.restore();
  traceOutline(ctx, model, ox, oy, scale);
  ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(1, scale * 0.035); ctx.strokeStyle = rgba(accent, 0.95); ctx.stroke();
  const c = model.canopy, cy0 = oy + c.z * scale;
  ctx.beginPath(); ctx.ellipse(ox, cy0, c.w * scale, c.l * scale, 0, 0, Math.PI * 2);
  const canopy = ctx.createLinearGradient(0, cy0 - c.l * scale, 0, cy0 + c.l * scale);
  canopy.addColorStop(0, rgba(accent, 1)); canopy.addColorStop(1, rgba(hull.map(v => Math.round(v * 0.4)), 1));
  ctx.fillStyle = canopy; ctx.fill();
  return model.id;
}

// Ship from a raised chase view (plan view foreshortened), nose toward the vanishing point, its
// engine glow and the weapon of the loop reached (laser beam or rocket trail). R-3: the model is
// the one the run was played with (d.ship, already defaulted by normalizeResult).
const CARD_SHIP_W = 250, CARD_SHIP_L = 220, CARD_SHIP_TILT = 0.72;
function drawShip(ctx, d, style, vx, vy) {
  const model = shipById(d.ship);
  const [x0, z0, x1, z1] = outlineBounds(model);
  const scale = Math.min(CARD_SHIP_W / (x1 - x0), CARD_SHIP_L / (z1 - z0)), reach = (z1 - z0) / 2 * scale * CARD_SHIP_TILT;
  const sx = ART.x + ART.w * 0.5, sy = ART.y + ART.h - 150;
  const yaw = Math.max(-0.35, Math.min(0.35, Math.atan2(vx - sx, sy - vy)));
  const nose = [sx + Math.sin(yaw) * reach, sy - Math.cos(yaw) * reach];
  ctx.beginPath(); ctx.moveTo(nose[0], nose[1]);
  if (d.weapon === 'rocket') {
    ctx.quadraticCurveTo((nose[0] + vx) / 2 + 40, (nose[1] + vy) / 2, vx + (nose[0] - vx) * 0.35, vy + (nose[1] - vy) * 0.35);
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,180,90,0.85)';
  } else {
    ctx.lineTo(vx + (nose[0] - vx) * 0.25, vy + (nose[1] - vy) * 0.25);
    ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(255,91,214,0.9)';
  }
  ctx.stroke();
  ctx.save();
  ctx.translate(sx, sy); ctx.rotate(yaw); ctx.scale(1, CARD_SHIP_TILT);
  drawShipPlan(ctx, model, 0, 0, scale, {glow: rgba(style.glow, 0.6)});
  ctx.restore();
}

// FB3-SHIP R-4: the selfie is never shown raw. Procedural passes on the card ctx only, over the
// photo already drawn and clipped to (x, y, w, h). No pixel readback and no offscreen canvas, so
// a large or tainted photo cannot break the card and renderCard stays ctx + data only.
//   1 duotone: desaturate ('saturation' with grey), map luminance onto the tier highlight
//     ('multiply'), then lift the shadows to the tier shadow ('screen'): shadow + L * highlight.
//   2 glow: a tier-coloured bloom rising from the bottom and an inner rim light.
//   3 scanlines: thin dark rows every SCAN_STEP px.
//   4 vignette: radial darkening toward the corners.
const SCAN_STEP = 4, SCAN_H = 2;
function stylizePortrait(ctx, style, x, y, w, h) {
  const [shadow, highlight] = style.duo;
  ctx.save();
  ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = '#808080'; ctx.fillRect(x, y, w, h);
  ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = highlight; ctx.fillRect(x, y, w, h);
  ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = shadow; ctx.fillRect(x, y, w, h);
  const bloom = ctx.createRadialGradient(x + w / 2, y + h * 1.05, 0, x + w / 2, y + h * 1.05, h * 0.9);
  bloom.addColorStop(0, rgba(style.glow, 0.55)); bloom.addColorStop(1, rgba(style.glow, 0));
  ctx.fillStyle = bloom; ctx.fillRect(x, y, w, h);
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = rgba(style.glow, 1); ctx.shadowBlur = 22;
  roundRect(ctx, x, y, w, h, 14);
  ctx.lineWidth = 5; ctx.strokeStyle = rgba(style.glow, 0.55); ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.fillStyle = 'rgba(2,3,10,0.3)';
  for (let sy = y; sy < y + h; sy += SCAN_STEP) ctx.fillRect(x, sy, w, SCAN_H);
  const vig = ctx.createRadialGradient(x + w / 2, y + h * 0.45, Math.min(w, h) * 0.3, x + w / 2, y + h * 0.45, Math.hypot(w, h) * 0.6);
  vig.addColorStop(0, 'rgba(2,3,10,0)'); vig.addColorStop(1, 'rgba(2,3,10,0.78)');
  ctx.fillStyle = vig; ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function drawPortrait(ctx, img, style) {
  const {x, y, w, h} = PORTRAIT;
  const iw = img.naturalWidth || img.videoWidth || img.width || 0, ih = img.naturalHeight || img.videoHeight || img.height || 0;
  if (!(iw > 0 && ih > 0)) return false;
  ctx.save();
  ctx.shadowColor = rgba(style.glow, 0.85); ctx.shadowBlur = 34; // tier-coloured outer glow round the foil frame
  roundRect(ctx, x - 9, y - 9, w + 18, h + 18, 20);
  ctx.fillStyle = foil(ctx, style, x, y, x + w, y + h); ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, x, y, w, h, 14);
  ctx.clip();
  const k = Math.max(w / iw, h / ih), dw = iw * k, dh = ih * k; // cover crop, centred
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  stylizePortrait(ctx, style, x, y, w, h);
  const shade = ctx.createLinearGradient(0, y + h * 0.6, 0, y + h);
  shade.addColorStop(0, 'rgba(5,6,15,0)'); shade.addColorStop(1, 'rgba(5,6,15,0.85)');
  ctx.fillStyle = shade; ctx.fillRect(x, y, w, h);
  const gloss = ctx.createLinearGradient(x, y, x + w, y + h * 0.5);
  gloss.addColorStop(0, 'rgba(255,255,255,0.22)'); gloss.addColorStop(0.4, 'rgba(255,255,255,0)');
  ctx.fillStyle = gloss; ctx.fillRect(x, y, w, h);
  ctx.restore();
  text(ctx, 'PILOT', x + w / 2, y + h - 18, {font: `800 26px ${MONO}`, color: style.ink, align: 'center'});
  return true;
}

function panel(ctx, x, y, w, h, style) {
  roundRect(ctx, x, y, w, h, 18);
  ctx.fillStyle = 'rgba(16,22,44,0.72)'; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = rgba(style.glow, 0.5); ctx.stroke();
}

function drawStats(ctx, d, style) {
  const top = 870, h = 186;
  panel(ctx, 66, top, 486, h, style);
  text(ctx, 'SCORE', 92, top + 42, {font: `700 26px ${MONO}`, color: rgba(style.glow, 1)});
  text(ctx, `/ ${d.maxTicks}`, 528, top + 42, {font: `700 26px ${MONO}`, color: '#8e9ab9', align: 'right'});
  const big = ctx.createLinearGradient(0, top + 60, 0, top + 170);
  big.addColorStop(0, '#ffffff'); big.addColorStop(1, style.ink);
  ctx.save();
  ctx.shadowColor = rgba(style.glow, 0.75); ctx.shadowBlur = 26;
  text(ctx, String(d.score), 88, top + 160, {font: `italic 900 122px ${FONT}`, color: big, max: 440});
  ctx.restore();
  const cells = [['TIME', formatTime(d.ticks, d.tps), 572], ['LOOPS', `${d.loops}/${d.loopCount}`, 798]];
  for (const [label, value, cx] of cells) {
    panel(ctx, cx, top, 216, h, style);
    text(ctx, label, cx + 108, top + 42, {font: `700 26px ${MONO}`, color: rgba(style.glow, 1), align: 'center'});
    text(ctx, value, cx + 108, top + 136, {font: `800 64px ${MONO}`, color: '#eef1ff', align: 'center', max: 196});
  }
}

// pl-v3 stats (spec 22): the DISTANCE headline in KM with the mode, TIME and LOOPS cells, then the
// secondary stat row (destroyed, dodged, minerals, gems, boosts used). Same band as drawStats.
export const STATS_V3 = Object.freeze({top: 862, h: 124, rowTop: 996, rowH: 58});
function drawStatsV3(ctx, d, style) {
  const {top, h, rowTop, rowH} = STATS_V3;
  panel(ctx, 66, top, 486, h, style);
  text(ctx, 'DISTANCE', 92, top + 36, {font: `700 24px ${MONO}`, color: rgba(style.glow, 1)});
  text(ctx, MODE_LABELS[d.mode] ?? '', 528, top + 36, {font: `700 24px ${MONO}`, color: '#8e9ab9', align: 'right'});
  const big = ctx.createLinearGradient(0, top + 44, 0, top + 116);
  big.addColorStop(0, '#ffffff'); big.addColorStop(1, style.ink);
  ctx.save();
  ctx.shadowColor = rgba(style.glow, 0.75); ctx.shadowBlur = 24;
  text(ctx, `${formatKm(d.distance)} KM`, 88, top + 108, {font: `italic 900 76px ${FONT}`, color: big, max: 440});
  ctx.restore();
  for (const [label, value, cx] of [['TIME', formatTime(d.ticks, d.tps), 572], ['LOOPS', String(d.loops), 798]]) {
    panel(ctx, cx, top, 216, h, style);
    text(ctx, label, cx + 108, top + 36, {font: `700 24px ${MONO}`, color: rgba(style.glow, 1), align: 'center'});
    text(ctx, value, cx + 108, top + 100, {font: `800 50px ${MONO}`, color: '#eef1ff', align: 'center', max: 196});
  }
  const row = [['DESTROYED', d.destroyed], ['DODGED', d.dodged], ['MINERALS', d.minerals], ['GEMS', d.gems], ['BOOSTS', d.boosts]];
  const gap = 10, w = (ART.w - gap * (row.length - 1)) / row.length;
  row.forEach(([label, value], i) => {
    const x = ART.x + i * (w + gap);
    panel(ctx, x, rowTop, w, rowH, style);
    text(ctx, label, x + w / 2, rowTop + 22, {font: `700 15px ${MONO}`, color: rgba(style.glow, 1), align: 'center', max: w - 16});
    text(ctx, groupDigits(value), x + w / 2, rowTop + 50, {font: `800 26px ${MONO}`, color: '#eef1ff', align: 'center', max: w - 16});
  });
}

// The tier row stated on the card: thresholds ascending, the label of each, the lit band and the
// caption. pl-v3 lights the KM band (a record card shows MYTHIC on the badge and ribbon).
function tierRow(d, tier) {
  if (isV3(d)) {
    return {tiers: [...KM_TIERS].reverse(), label: t => `${t.name} ${groupDigits(t.min)}+`,
      lit: kmTierFor(kmOf(d.distance)).name, caption: 'TIERS BY DISTANCE (KM)  ·  MYTHIC = NEW RECORD'};
  }
  return {tiers: [...TIERS].reverse(), label: t => (t.min >= d.maxTicks ? `${t.name} ${t.min}` : `${t.name} ${t.min}+`),
    lit: tier.name, caption: 'TIERS BY SCORE (SURVIVED TICKS)'};
}
const rulesetLine = d => (isV3(d) && d.mode ? `${d.ruleset} ${MODE_LABELS[d.mode] ?? d.mode}` : d.ruleset);

// Footer without a challenge QR (the GO-2 layout, unchanged for pl-v2).
function drawFooter(ctx, d, tier, style) {
  text(ctx, `“${flavorFor(d)}”`, CARD_W / 2, 1110, {font: `italic 500 32px ${FONT}`, color: '#cfd6f2', align: 'center', max: 940});
  const rule = ctx.createLinearGradient(80, 0, CARD_W - 80, 0);
  rule.addColorStop(0, rgba(style.glow, 0)); rule.addColorStop(0.5, rgba(style.glow, 0.9)); rule.addColorStop(1, rgba(style.glow, 0));
  ctx.fillStyle = rule; ctx.fillRect(80, 1138, CARD_W - 160, 2);
  text(ctx, `SEED ${d.seed}   ·   ${rulesetLine(d)}   ·   ${d.date} UTC`, CARD_W / 2, 1192, {font: `700 30px ${MONO}`, color: '#69e2d3', align: 'center', max: 940});
  // Tier thresholds stated on the card; the earned tier is lit.
  const row = tierRow(d, tier);
  row.tiers.forEach((t, i) => {
    const cx = 168 + i * 248, lit = t.name === row.lit;
    text(ctx, row.label(t), cx, 1246, {font: `${lit ? 800 : 600} 24px ${MONO}`, color: lit ? style.ink : '#6f7899', align: 'center', max: 236});
    if (lit) { ctx.fillStyle = style.ink; ctx.fillRect(cx - 60, 1258, 120, 3); }
  });
  text(ctx, row.caption, CARD_W / 2, 1296, {font: `600 18px ${MONO}`, color: '#59617f', align: 'center', max: 640});
  text(ctx, `No.${d.seed.toString(16).padStart(8, '0').toUpperCase()}`, 70, 1296, {font: `600 18px ${MONO}`, color: '#59617f'});
}

// FB3-QR R-3: challenge QR, bottom right. The matrix rows already carry the 4-module light quiet
// zone, so the white panel is exactly size x size modules; dark modules are drawn as
// pixel-snapped horizontal runs in black. A tier foil frame with a glow sits outside the panel.
export const QR_PANEL = Object.freeze({x: 776, y: 1068, s: 238});
function drawQr(ctx, qr, style) {
  const {x, y, s} = QR_PANEL;
  ctx.save();
  ctx.shadowColor = rgba(style.glow, 0.75); ctx.shadowBlur = 26;
  roundRect(ctx, x - 8, y - 8, s + 16, s + 16, 14);
  ctx.fillStyle = foil(ctx, style, x, y, x + s, y + s); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = '#000000';
  const edge = (o, i) => Math.round(o + i * s / qr.size);
  qr.modules.forEach((row, r) => {
    const y0 = edge(y, r), y1 = edge(y, r + 1);
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== '1') continue;
      let e = c;
      while (e + 1 < row.length && row[e + 1] === '1') e++;
      const x0 = edge(x, c);
      ctx.fillRect(x0, y0, edge(x, e + 1) - x0, y1 - y0);
      c = e;
    }
  });
}

// Footer with the QR: the label and the result to beat on the left, beside the code, then the
// flavor line, run data and the tier row in a narrower left column.
function drawChallengeFooter(ctx, d, tier, style) {
  const left = 80, width = 660;
  const ink = ctx.createLinearGradient(0, 1074, 0, 1110);
  ink.addColorStop(0, '#ffffff'); ink.addColorStop(1, style.ink);
  ctx.save();
  ctx.shadowColor = rgba(style.glow, 0.7); ctx.shadowBlur = 18;
  text(ctx, 'SCAN TO CHALLENGE', left, 1108, {font: `italic 900 46px ${FONT}`, color: ink, max: width});
  ctx.restore();
  const beat = isV3(d) ? `BEAT ${formatKm(d.distance)} KM   ·   ${MODE_LABELS[d.mode] ?? d.mode}   ·   SEED ${d.seed}`
    : `BEAT ${d.score}   ·   SEED ${d.seed}`;
  text(ctx, beat, left, 1150, {font: `700 28px ${MONO}`, color: rgba(style.glow, 1), max: width});
  text(ctx, `“${flavorFor(d)}”`, left, 1194, {font: `italic 500 23px ${FONT}`, color: '#cfd6f2', max: width});
  const rule = ctx.createLinearGradient(left, 0, left + width, 0);
  rule.addColorStop(0, rgba(style.glow, 0.9)); rule.addColorStop(1, rgba(style.glow, 0));
  ctx.fillStyle = rule; ctx.fillRect(left, 1214, width, 2);
  text(ctx, `${rulesetLine(d)}   ·   ${d.date} UTC   ·   No.${d.seed.toString(16).padStart(8, '0').toUpperCase()}`, left, 1250,
    {font: `700 24px ${MONO}`, color: '#69e2d3', max: width});
  const row = tierRow(d, tier);
  row.tiers.forEach((t, i) => {
    const x = left + i * 168, lit = t.name === row.lit;
    text(ctx, row.label(t), x, 1284, {font: `${lit ? 800 : 600} 20px ${MONO}`, color: lit ? style.ink : '#6f7899', max: 160});
    if (lit) { ctx.fillStyle = style.ink; ctx.fillRect(x, 1293, 100, 3); }
  });
  text(ctx, row.caption, left, 1312, {font: `600 15px ${MONO}`, color: '#59617f', max: width});
}

function cardQr(d) {
  if (!d.challenge) return null;
  try {
    const m = qrMatrix(d.challenge);
    return m && m.size > 0 && Array.isArray(m.modules) && m.modules.length === m.size ? m : null;
  } catch { return null; }
}

// Pure: ctx calls only. The record flag is data (decided by the controller from the best store
// before the card is drawn), so a redraw of the same result (selfie retake) draws the same tier.
export function renderCard(ctx, data) {
  const d = normalizeResult(data);
  const v3 = isV3(d), tier = cardTier(d), style = TIER_STYLE[tier.name], rng = seededRng(d.seed);
  const record = v3 && d.record;
  const qr = cardQr(d);
  ctx.save();
  ctx.clearRect(0, 0, CARD_W, CARD_H);
  drawFrame(ctx, style, rng);
  drawArt(ctx, d, style, rng);
  const portrait = d.selfie ? drawPortrait(ctx, d.selfie, style) : false;
  if (record) { drawMythicHalo(ctx, style); drawRecordRibbon(ctx, style); }
  drawHeader(ctx, style);
  drawBadge(ctx, tier, style);
  if (v3) drawStatsV3(ctx, d, style); else drawStats(ctx, d, style);
  if (qr) { drawQr(ctx, qr, style); drawChallengeFooter(ctx, d, tier, style); } else drawFooter(ctx, d, tier, style);
  ctx.restore();
  return {tier: tier.name, time: formatTime(d.ticks, d.tps), portrait, ship: d.ship, record,
    km: v3 ? kmOf(d.distance) : null, band: v3 ? kmTierFor(kmOf(d.distance)).name : null,
    qr: qr ? {text: d.challenge, version: qr.version, size: qr.size, ...QR_PANEL} : null};
}

// Icons reuse the lobby stroke style. The SVG namespace is read from an inline SVG already in the
// static page, so this file carries no URL string; without one the buttons stay text-only.
const ICONS = {
  card: ['M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M7 7h10v6H7z', 'M7 16h6'],
  lobby: ['M10 6L4 12l6 6', 'M4 12h11a5 5 0 0 1 5 5v1'],
  camera: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'],
  save: ['M12 4v11', 'M7 10l5 5 5-5', 'M4 15v5h16v-5'],
  share: ['M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M8.6 13.5l6.8 4', 'M15.4 6.5l-6.8 4'],
};

// localStorage itself may throw on access (storage disabled); the store then reads as absent.
const pageStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

// storage: the best distance store backend (getItem / setItem), default the page localStorage.
export function createGameOver({document: doc = globalThis.document, navigator: nav = globalThis.navigator, URL: Url = globalThis.URL,
  storage = pageStorage(), onBack = () => {}} = {}) {
  const svgNs = doc.querySelector?.('svg')?.namespaceURI ?? null;
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = name => {
    if (!svgNs) return null;
    const svg = doc.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    for (const d of ICONS[name]) { const p = doc.createElementNS(svgNs, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  };
  const button = (cls, iconName, label) => {
    const b = el('button', cls);
    b.type = 'button';
    const i = icon(iconName);
    if (i) b.append(i);
    b.append(el('span', '', label));
    return b;
  };

  const dialog = el('dialog', 'gameover');
  dialog.id = 'gameover';
  dialog.setAttribute('aria-labelledby', 'gameover-title');

  // Summary view (GO-1).
  const summary = el('section', 'go-summary');
  const eyebrow = el('p', 'go-eyebrow');
  const title = el('h2', 'go-title'); title.id = 'gameover-title';
  const scoreBox = el('div', 'go-score');
  const scoreLabel = el('span', 'go-k', 'Score'), scoreValue = el('b', 'go-big'), scoreOf = el('span', 'go-of');
  scoreBox.append(scoreLabel, scoreValue, scoreOf);
  const stats = el('div', 'go-stats');
  const stat = label => { const box = el('div', 'go-stat'), v = el('b'); box.append(el('span', 'go-k', label), v); stats.append(box); return v; };
  const timeValue = stat('Time'), loopsValue = stat('Loops'), tierValue = stat('Tier');
  const flavor = el('p', 'go-flavor');
  const dataLine = el('p', 'go-data');
  const statLine = el('p', 'go-data go-statline'); // pl-v3 secondary stat row (spec 22)
  statLine.hidden = true;
  const actions = el('div', 'go-actions');
  const makeCardButton = button('go-make primary', 'card', 'Make card');
  const backButton = button('go-back', 'lobby', 'Back to lobby');
  actions.append(makeCardButton, backButton);
  summary.append(eyebrow, title, scoreBox, stats, flavor, dataLine, statLine, actions);

  // Card view (GO-2..GO-4).
  const cardView = el('section', 'go-cardview');
  cardView.hidden = true;
  const canvas = el('canvas', 'go-canvas');
  canvas.width = CARD_W; canvas.height = CARD_H;
  canvas.setAttribute('role', 'img');
  const tools = el('div', 'go-tools');
  const selfieButton = button('go-selfie icon', 'camera', 'Selfie');
  const saveButton = button('go-save icon', 'save', 'Save image');
  const shareButton = button('go-share icon', 'share', 'Share');
  const cardBackButton = button('go-back icon', 'lobby', 'Lobby');
  tools.append(selfieButton, saveButton, shareButton, cardBackButton);
  const hint = el('p', 'go-hint');
  hint.setAttribute('role', 'status');
  cardView.append(canvas, tools, hint);

  dialog.append(summary, cardView);
  doc.body.append(dialog);

  let result = null;
  // Best store (R35.7): show() reads the standing best and decides the record flag once per
  // result; the first card drawn for a record result then commits it as the new best. Redraws
  // keep the flag, so the record card stays mythic after the store has moved.
  let bestCommitted = false;
  // Selfie (GO-3): an in-memory image only. It is never uploaded, written to storage or sent
  // anywhere; it lives until the page is closed or another photo replaces it.
  let selfie = null, selfieUrl = null, pendingInput = null;
  const setHint = message => { hint.textContent = message; };
  const NO_SHARE = 'Sharing is not available in this browser. Use Save image, then post it from your gallery.';
  let sharable = false, blobPromise = null, card = null;
  const restingHint = () => (sharable ? '' : NO_SHARE);
  const filename = () => `space-racer-${result.score}-${result.seed}.png`;

  function drawCard() {
    const ctx = canvas.getContext('2d');
    if (!ctx) { setHint('This browser cannot draw the card.'); return null; }
    card = renderCard(ctx, {...result, selfie});
    if (card.record && !bestCommitted) { bestCommitted = true; writeBest(storage, result); } // after the card, never during it
    const headline = isV3(result) ? `${card.record ? 'new record, ' : ''}distance ${formatKm(result.distance)} KM` : `score ${result.score}`;
    canvas.setAttribute('aria-label', `Achievement card: ${card.tier}, ${headline}, time ${card.time}, seed ${result.seed}${card.qr ? ', with challenge QR' : ''}`);
    blobPromise = null;
    pngBlob(); // encode now so Share can call navigator.share while the tap still counts as a gesture
    return card;
  }
  function pngBlob() {
    if (!blobPromise) {
      blobPromise = new Promise(resolve => {
        try { canvas.toBlob(blob => resolve(blob ?? null), 'image/png'); } catch { resolve(null); }
      });
    }
    return blobPromise;
  }

  // GO-4: Web Share with a PNG File where the platform supports files (the Android share sheet
  // lists Instagram and Threads when installed); otherwise Share is hidden and Save image is the
  // way out. No social APIs and no network calls: the PNG only goes to the share sheet or a
  // local download.
  function canShareFiles() {
    try {
      if (typeof nav?.share !== 'function' || typeof nav?.canShare !== 'function' || typeof File !== 'function') return false;
      return Boolean(nav.canShare({files: [new File([new Uint8Array(8)], 'card.png', {type: 'image/png'})]}));
    } catch { return false; }
  }
  function refreshShare() {
    sharable = canShareFiles();
    shareButton.hidden = !sharable;
    shareButton.disabled = !sharable;
  }
  async function saveImage() {
    const blob = await pngBlob();
    if (!blob) return setHint('The card image could not be created.');
    const url = Url.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = filename();
    link.className = 'go-file';
    dialog.append(link);
    link.click();
    link.remove();
    setTimeout(() => Url.revokeObjectURL(url), 10000);
    setHint(`Saved ${link.download}`);
  }
  let sharing = false;
  async function shareImage() {
    refreshShare();
    if (!sharable) return setHint(NO_SHARE);
    if (sharing) return;
    const blob = await pngBlob();
    if (!blob) return setHint('The card image could not be created.');
    const file = new File([blob], filename(), {type: 'image/png'});
    sharing = true;
    try {
      if (!nav.canShare({files: [file]})) return setHint(NO_SHARE);
      const headline = isV3(result) ? `${formatKm(result.distance)} KM (${MODE_LABELS[result.mode] ?? result.mode})` : `score ${result.score}`;
      await nav.share({files: [file], title: 'Pulse Lanes',
        text: `${card?.tier ?? cardTier(result).name} run in Pulse Lanes: ${headline}, time ${formatTime(result.ticks, result.tps)}, seed ${result.seed}.`});
      setHint(restingHint());
    } catch (err) {
      if (err?.name !== 'AbortError') setHint('Share did not finish. Use Save image instead.');
    } finally { sharing = false; }
  }

  function openCard() {
    if (!result) return;
    summary.hidden = true; cardView.hidden = false;
    refreshShare();
    setHint(restingHint());
    drawCard();
    (sharable ? shareButton : saveButton).focus?.();
  }
  const isOpen = () => Boolean(dialog.open);

  const dropPendingInput = () => { pendingInput?.remove?.(); pendingInput = null; };
  function loadSelfie(file) {
    if (file.type && !file.type.startsWith('image/')) return setHint('That file is not a photo.');
    let url;
    try { url = Url.createObjectURL(file); } catch { return setHint('That photo could not be read.'); }
    const img = doc.createElement('img');
    img.decoding = 'async';
    img.onload = () => {
      if (selfieUrl) Url.revokeObjectURL(selfieUrl);
      selfie = img; selfieUrl = url;
      selfieButton.lastChild.textContent = 'Retake';
      setHint(restingHint());
      drawCard();
    };
    img.onerror = () => { Url.revokeObjectURL(url); setHint('That photo could not be read.'); };
    img.src = url;
  }
  // The file input is created here, at click time, and removed once used: the static page never
  // holds an input outside #lobby. accept + capture ask phones for the front camera; browsers
  // without a camera show a plain file chooser, and any failure only leaves a hint.
  function takeSelfie() {
    dropPendingInput();
    try {
      const input = doc.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.setAttribute('capture', 'user');
      input.className = 'go-file';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (pendingInput === input) dropPendingInput();
        if (file) loadSelfie(file);
      });
      input.addEventListener('cancel', () => { if (pendingInput === input) dropPendingInput(); });
      pendingInput = input;
      dialog.append(input);
      input.click();
    } catch {
      dropPendingInput();
      setHint('Camera or photo picker is not available here.');
    }
  }

  function show(raw) {
    result = normalizeResult(raw);
    const v3 = isV3(result);
    // pl-v3: record iff the distance strictly beats the best stored before this run's card.
    if (v3) result.record = isNewRecord(result.distance, readBest(storage));
    bestCommitted = false;
    const tier = cardTier(result);
    const [kicker, headline] = HEADLINES[result.reason] ?? HEADLINES.collision;
    eyebrow.textContent = v3 && result.record ? 'New record' : kicker;
    title.textContent = headline;
    scoreLabel.textContent = v3 ? 'Distance' : 'Score';
    scoreValue.textContent = v3 ? `${formatKm(result.distance)} KM` : String(result.score);
    scoreOf.textContent = v3 ? (MODE_LABELS[result.mode] ?? '') : `/ ${result.maxTicks}`;
    timeValue.textContent = formatTime(result.ticks, result.tps);
    loopsValue.textContent = v3 ? String(result.loops) : `${result.loops} / ${result.loopCount}`;
    tierValue.textContent = tier.name;
    dialog.dataset.tier = tier.name.toLowerCase();
    flavor.textContent = flavorFor(result);
    dataLine.textContent = v3 && result.mode ? `${result.ruleset} · ${MODE_LABELS[result.mode]} · seed ${result.seed}`
      : `${result.ruleset} · seed ${result.seed}`;
    statLine.hidden = !v3;
    statLine.textContent = v3 ? `Destroyed ${result.destroyed} · Dodged ${result.dodged} · Minerals ${result.minerals} · Gems ${result.gems} · Boosts ${result.boosts}` : '';
    summary.hidden = false; cardView.hidden = true;
    closedByUs = false;
    if (!dialog.open) { try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); } }
    makeCardButton.focus?.();
  }
  let closedByUs = true;
  function hide() {
    closedByUs = true;
    dropPendingInput();
    if (dialog.open) { try { dialog.close(); } catch { /* attribute fallback below */ } }
    dialog.removeAttribute('open');
  }
  function back() { hide(); onBack(); }

  makeCardButton.addEventListener('click', openCard);
  backButton.addEventListener('click', back);
  cardBackButton.addEventListener('click', back);
  selfieButton.addEventListener('click', takeSelfie);
  saveButton.addEventListener('click', saveImage);
  shareButton.addEventListener('click', shareImage);
  // Escape acts as Back to lobby, so dismissing the modal always lands in the lobby.
  dialog.addEventListener('cancel', event => { event.preventDefault(); back(); });
  // A browser may still close the modal on its own (repeated Escape or Android back without a
  // new gesture ignores preventDefault); that close also means Back to lobby, never a dead end.
  dialog.addEventListener('close', () => { if (!closedByUs) { closedByUs = true; dropPendingInput(); onBack(); } });

  return {show, hide, back, isOpen, openCard, dialog, canvas, elements: {makeCardButton, backButton, cardBackButton, selfieButton, saveButton, shareButton, hint},
    pngBlob: () => pngBlob()};
}

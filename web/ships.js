// ships.js - ship model registry (spec section 19 SH-1, ruling R33). Presentation only: pure data
// plus two tiny 2D path helpers. No fetched assets, no third-party libraries, no I/O.
//
// Ship-local units (the WebGL renderer scales them by its ship scale, the card by its own):
//   x right, y up, z back. The nose points to -z. `outline` is the plan view (top-down) polygon
//   as [x, z] points, simple (no self intersections), walked in one direction.
//   `thrusters` are rects on the tail: centre (x, y, z), width w (along x), height h (along y).
//   `canopy` is the cockpit bubble: centre z, half width w, half length l (plan view).
//   `height` is the hull half thickness at the centreline (the plate thins toward the wing tips).
//   `colors` are #rrggbb strings: hull body, accent (canopy, trim), engine (thruster glow).

export const SHIP_KEY = 'pl-ship';          // localStorage key, separate from the pilot save
export const SHIP_DEFAULT = 'dart';
export const OUTLINE_MIN = 5, OUTLINE_MAX = 32; // stated bounds on outline point counts
export const THRUSTERS_MIN = 1, THRUSTERS_MAX = 6;
export const EXTENT_MAX = 2.2;              // every outline point satisfies |x|, |z| <= EXTENT_MAX

const P = pts => Object.freeze(pts.map(p => Object.freeze(p)));
const T = list => Object.freeze(list.map(t => Object.freeze(t)));
// Mirror a right-hand half outline [nose ... centre tail] into a full closed outline.
const mirror = half => {
  const right = half.slice(), left = [];
  for (let i = half.length - 1; i >= 0; i--) {
    const [x, z] = half[i];
    if (x !== 0) left.push([-x, z]);
  }
  return right.concat(left);
};
const ship = m => Object.freeze({
  id: m.id, name: m.name, blurb: m.blurb, outline: P(m.outline), thrusters: T(m.thrusters),
  canopy: Object.freeze({...m.canopy}), height: m.height, colors: Object.freeze({...m.colors}),
});

export const SHIPS = Object.freeze([
  // DART: the original arrowhead, kept as the default so returning players see their ship.
  ship({id: 'dart', name: 'DART', blurb: 'Balanced arrowhead',
    outline: mirror([[0, -1.7], [0.22, -0.95], [0.42, -0.2], [1.25, 0.62], [1.2, 0.8], [0.5, 0.62], [0.3, 0.85]]),
    thrusters: [{x: 0, y: 0, z: 0.85, w: 0.4, h: 0.16}],
    canopy: {z: -0.55, w: 0.2, l: 0.42}, height: 0.34,
    colors: {hull: '#59d9f2', accent: '#e8fbff', engine: '#40d9ff'}}),
  // DELTA: broad swept delta, twin engines.
  ship({id: 'delta', name: 'DELTA', blurb: 'Wide swept wing',
    outline: mirror([[0, -1.55], [0.35, -0.75], [1.55, 0.78], [0.9, 0.78], [0.6, 0.6], [0.2, 0.9]]),
    thrusters: [{x: -0.4, y: 0, z: 0.72, w: 0.3, h: 0.14}, {x: 0.4, y: 0, z: 0.72, w: 0.3, h: 0.14}],
    canopy: {z: -0.35, w: 0.22, l: 0.38}, height: 0.26,
    colors: {hull: '#ff7ad9', accent: '#ffe0f6', engine: '#ff5bd6'}}),
  // WRAITH: forward wing roots, raked tips and a notched trailing edge.
  ship({id: 'wraith', name: 'WRAITH', blurb: 'Notched stealth wing',
    outline: mirror([[0, -1.45], [0.28, -1.0], [0.55, -0.35], [1.45, -0.55], [1.6, -0.38], [0.95, 0.35], [1.1, 0.85],
      [0.55, 0.6], [0.22, 0.95], [0, 0.7]]),
    thrusters: [{x: -0.22, y: 0, z: 0.85, w: 0.22, h: 0.12}, {x: 0.22, y: 0, z: 0.85, w: 0.22, h: 0.12}],
    canopy: {z: -0.6, w: 0.17, l: 0.34}, height: 0.22,
    colors: {hull: '#9b7bff', accent: '#d9ccff', engine: '#b18cff'}}),
  // HAULER: blunt cargo hull with side pods and four engines.
  ship({id: 'hauler', name: 'HAULER', blurb: 'Armoured cargo frame',
    outline: mirror([[0.35, -1.3], [0.6, -0.95], [0.6, -0.45], [1.15, -0.4], [1.25, -0.25], [1.25, 0.85], [0.75, 0.95],
      [0.6, 0.7]]),
    thrusters: [{x: -1.0, y: 0, z: 0.9, w: 0.36, h: 0.22}, {x: -0.3, y: 0, z: 0.7, w: 0.3, h: 0.18},
      {x: 0.3, y: 0, z: 0.7, w: 0.3, h: 0.18}, {x: 1.0, y: 0, z: 0.9, w: 0.36, h: 0.22}],
    canopy: {z: -0.85, w: 0.26, l: 0.28}, height: 0.42,
    colors: {hull: '#ffb347', accent: '#fff0cc', engine: '#ffa53d'}}),
  // LANCE: long needle nose on short canards.
  ship({id: 'lance', name: 'LANCE', blurb: 'Needle interceptor',
    outline: mirror([[0, -2.0], [0.12, -1.2], [0.25, -0.2], [0.9, 0.5], [0.9, 0.75], [0.3, 0.6], [0.2, 0.9]]),
    thrusters: [{x: 0, y: 0, z: 0.9, w: 0.32, h: 0.15}],
    canopy: {z: -0.3, w: 0.14, l: 0.45}, height: 0.28,
    colors: {hull: '#7dff8a', accent: '#e6ffe9', engine: '#57ff9a'}}),
]);

export const SHIP_IDS = Object.freeze(SHIPS.map(s => s.id));
const BY_ID = new Map(SHIPS.map(s => [s.id, s]));

// Unknown, missing or malformed ids fall back to the default model.
export function shipById(id) { return (typeof id === 'string' && BY_ID.get(id)) || BY_ID.get(SHIP_DEFAULT); }
export function shipIdOrDefault(id) { return shipById(id).id; }

// '#rrggbb' -> [r, g, b] in 0..1 (renderer) or 0..255 (canvas). Malformed -> mid grey.
export function hexRgb(hex, scale = 1) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(typeof hex === 'string' ? hex : '');
  if (!m) return [0.5 * scale, 0.5 * scale, 0.5 * scale];
  return [1, 2, 3].map(i => parseInt(m[i], 16) / 255 * scale);
}

// Plan view outline as a closed 2D path on `ctx`: ship-local x -> right, z -> down (nose up),
// centred at (cx, cy) with `scale` px per ship unit. Caller fills or strokes.
export function traceOutline(ctx, model, cx, cy, scale) {
  const pts = model.outline;
  ctx.beginPath();
  ctx.moveTo(cx + pts[0][0] * scale, cy + pts[0][1] * scale);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(cx + pts[i][0] * scale, cy + pts[i][1] * scale);
  ctx.closePath();
}

// Plan view bounds [minX, minZ, maxX, maxZ] of a model outline.
export function outlineBounds(model) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, z] of model.outline) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); }
  return [a, b, c, d];
}

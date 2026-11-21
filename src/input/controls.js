// Pure input module (spec section 6). No DOM, no timers, no audio.
// quantizeStick is the only place floating point touches input; its integer
// output is what the sim and the replay see.

export const MAX_RADIUS_PX = 64;      // 128 px thumb circle (section 6.1)
export const DEAD_ZONE_RING_PX = 9.6; // ring drawn at 15% of the radius
export const CAPTURE_RADIUS_PX = 80;  // pointerdown capture distance (1.25 x max radius)
export const STICK_MAX = 100;

const LIMIT = STICK_MAX * STICK_MAX;

// dx, dy: CSS px offset of the touch from the circle centre (screen y grows downward).
// Returns [sx, sy] integers, sx*sx + sy*sy <= 10000, never -0.
export function quantizeStick(dx, dy, maxRadiusPx) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new TypeError('quantizeStick: dx and dy must be finite numbers');
  if (!Number.isFinite(maxRadiusPx) || maxRadiusPx <= 0) throw new RangeError('quantizeStick: maxRadiusPx must be a positive number');
  let sx = Math.trunc(100 * dx / maxRadiusPx);
  let sy = Math.trunc(-100 * dy / maxRadiusPx);
  if (sx * sx + sy * sy > LIMIT) {
    const k = 100 / Math.sqrt(sx * sx + sy * sy);
    sx = Math.trunc(sx * k);
    sy = Math.trunc(sy * k);
  }
  while (sx * sx + sy * sy > LIMIT) { // float guard
    if (Math.abs(sx) >= Math.abs(sy)) sx -= Math.sign(sx);
    else sy -= Math.sign(sy);
  }
  return [sx + 0, sy + 0]; // adding 0 turns -0 into 0
}

// Keyboard stick (section 6.1): W/A/S/D held. One axis gives +-100, two axes give +-70.
export function keyboardStick(held) {
  const x = (held.d ? 1 : 0) - (held.a ? 1 : 0);
  const y = (held.w ? 1 : 0) - (held.s ? 1 : 0);
  const m = x !== 0 && y !== 0 ? 70 : 100;
  return [x * m + 0, y * m + 0];
}

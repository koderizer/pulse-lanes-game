// qr.js - pure-JS QR Code encoder (spec section 20 QR-2, ruling R33). Byte mode for any text
// outside the alphanumeric set (every PLR1 challenge payload), single-segment numeric or
// alphanumeric mode when the whole text fits those sets (as the golden reference encoder does),
// error correction level M, mask pattern 2, smallest version that fits (1..40).
// Follows ISO/IEC 18004: segment encoding, Reed-Solomon ECC over GF(256) (primitive 0x11d),
// block split and interleave, function patterns, format and version information.
// Pure: no DOM, no I/O, no clock, no randomness. Same text in, same matrix out.
//
// qrMatrix(text) -> {version, size, quiet, modules}: `modules` is an array of `size` strings of
// '0' (light) and '1' (dark), row 0 on top, INCLUDING a 4-module light quiet zone on every side
// (size = 4 * version + 17 + 8). Throws RangeError when the payload does not fit version 40.

export const EC_LEVEL = 'M';
export const MASK = 2;
export const QUIET = 4;
export const MIN_VERSION = 1, MAX_VERSION = 40;

// Level M per version (index 0 unused): EC codewords per block and number of blocks.
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const EC_BITS_M = 0b00; // format information EC indicator: L=01, M=00, Q=11, H=10

// ------------------------------------------------------------------ text to bytes
// UTF-8 bytes of a JS string (lone surrogates become U+FFFD), without platform encoders.
export function utf8Bytes(text) {
  const s = String(text), out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

// ------------------------------------------------------------------ capacity
export function sizeOf(version) { return version * 4 + 17; }
// Modules available for data + ECC (everything outside function patterns and format/version info).
function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
export function totalCodewords(ver) { return Math.floor(rawDataModules(ver) / 8); }
export function dataCodewords(ver) { return totalCodewords(ver) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver]; }
export function blockLayout(ver) {
  const blocks = NUM_BLOCKS[ver], ecc = ECC_PER_BLOCK[ver], total = totalCodewords(ver);
  const short = blocks - (total % blocks), shortLen = Math.floor(total / blocks) - ecc;
  return {blocks, ecc, short, shortData: shortLen, longData: shortLen + 1};
}

// ------------------------------------------------------------------ segment (one mode per text)
// The whole text goes into one segment in its most compact mode: numeric for digits only,
// alphanumeric for the 45-character set, byte (UTF-8) for everything else. Any JSON payload
// (braces, quotes, lowercase) is therefore always byte mode, as QR-1 states.
export const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
export const MODES = Object.freeze({
  numeric: Object.freeze({indicator: 0b0001, cc: [10, 12, 14]}),
  alphanumeric: Object.freeze({indicator: 0b0010, cc: [9, 11, 13]}),
  byte: Object.freeze({indicator: 0b0100, cc: [8, 16, 16]}),
});
export function countBits(mode, ver) { return MODES[mode].cc[ver <= 9 ? 0 : ver <= 26 ? 1 : 2]; }
export function segment(text, forceMode = null) {
  const s = String(text), bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  let mode = forceMode;
  if (!mode) mode = s.length && /^[0-9]+$/.test(s) ? 'numeric' : s.length && [...s].every(c => ALNUM.includes(c)) ? 'alphanumeric' : 'byte';
  if (mode === 'numeric') {
    for (let i = 0; i < s.length; i += 3) { const g = s.slice(i, i + 3); put(Number(g), g.length * 3 + 1); }
    return {mode, count: s.length, bits};
  }
  if (mode === 'alphanumeric') {
    for (let i = 0; i < s.length; i += 2) {
      const a = ALNUM.indexOf(s[i]);
      if (i + 1 < s.length) put(a * 45 + ALNUM.indexOf(s[i + 1]), 11); else put(a, 6);
    }
    return {mode, count: s.length, bits};
  }
  const bytes = utf8Bytes(s);
  for (const b of bytes) put(b, 8);
  return {mode: 'byte', count: bytes.length, bits};
}
const segmentBits = (seg, ver) => 4 + countBits(seg.mode, ver) + seg.bits.length;

// Smallest version whose capacity holds the segment.
export function chooseVersion(seg) {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    if (seg.count < 2 ** countBits(seg.mode, v) && segmentBits(seg, v) <= dataCodewords(v) * 8) return v;
  }
  throw new RangeError(`QR payload of ${seg.count} ${seg.mode} units does not fit version ${MAX_VERSION}-M`);
}

// ------------------------------------------------------------------ GF(256) Reed-Solomon
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
// Generator polynomial prod (x - a^i), i = 0..degree-1, highest term dropped (monic).
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}
export function rsRemainder(data, degree) {
  const div = rsDivisor(degree), r = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ r.shift();
    r.push(0);
    for (let i = 0; i < degree; i++) r[i] ^= gfMul(div[i], factor);
  }
  return r;
}

// ------------------------------------------------------------------ codewords
// Segment bit stream at `ver` (mode indicator, character count, data), terminated and padded
// to the data capacity with 0xec 0x11.
export function dataStream(seg, ver) {
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(MODES[seg.mode].indicator, 4);
  put(seg.count, countBits(seg.mode, ver));
  for (const b of seg.bits) bits.push(b);
  const cap = dataCodewords(ver) * 8;
  if (bits.length > cap) throw new RangeError('QR payload exceeds the version capacity');
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k]; out.push(v); }
  return out;
}

// Data codewords split into blocks, ECC appended per block, then interleaved: data column by
// column across blocks (long blocks carry one more), then ECC column by column.
export function interleave(data, ver) {
  const {blocks, ecc, short, shortData} = blockLayout(ver);
  const parts = [];
  for (let b = 0, k = 0; b < blocks; b++) {
    const len = shortData + (b < short ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    parts.push({dat, ecc: rsRemainder(dat, ecc)});
  }
  const out = [];
  for (let i = 0; i <= shortData; i++) for (const p of parts) if (i < p.dat.length) out.push(p.dat[i]);
  for (let i = 0; i < ecc; i++) for (const p of parts) out.push(p.ecc[i]);
  return out;
}
export function codewords(seg, ver) { return interleave(dataStream(seg, ver), ver); }

// ------------------------------------------------------------------ matrix
export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = sizeOf(ver);
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}
export function formatBits(mask) {
  const data = (EC_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
export function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}
const MASKS = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

// Module grid (no quiet zone) for interleaved codewords `cw` at version `ver` with `mask`.
// Exposed so probes can build deliberately broken controls (wrong mask, corrupted codeword).
export function buildMatrix(ver, cw, mask = MASK) {
  const size = sizeOf(ver);
  const mod = Array.from({length: size}, () => new Array(size).fill(false));
  const fn = Array.from({length: size}, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  const bit = (v, i) => ((v >>> i) & 1) !== 0;
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = alignmentPositions(ver), last = al.length - 1;
  for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const f = formatBits(mask);
  for (let i = 0; i <= 5; i++) set(8, i, bit(f, i));
  set(8, 7, bit(f, 6)); set(8, 8, bit(f, 7)); set(7, 8, bit(f, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(f, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(f, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(f, i));
  set(8, size - 8, true); // dark module
  if (ver >= 7) {
    const v = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit(v, i)); set(b, a, bit(v, i));
    }
  }
  // Zigzag placement of the codeword bits, two columns at a time from the right, skipping the
  // vertical timing column. Remainder bits stay light.
  let i = 0;
  const nbits = cw.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fn[y][x] || i >= nbits) continue;
        mod[y][x] = bit(cw[i >>> 3], 7 - (i & 7));
        i++;
      }
    }
  }
  const m = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && m(x, y)) mod[y][x] = !mod[y][x];
  return mod;
}

// Grid of booleans -> rows of '0'/'1' with a `quiet` light border.
export function toRows(grid, quiet = QUIET) {
  const n = grid.length + 2 * quiet, blank = '0'.repeat(n), pad = '0'.repeat(quiet), rows = [];
  for (let q = 0; q < quiet; q++) rows.push(blank);
  for (const row of grid) rows.push(pad + row.map(d => (d ? '1' : '0')).join('') + pad);
  for (let q = 0; q < quiet; q++) rows.push(blank);
  return rows;
}

export function qrMatrix(text) {
  const seg = segment(text);
  const version = chooseVersion(seg);
  const modules = toRows(buildMatrix(version, codewords(seg, version), MASK));
  return {version, size: modules.length, quiet: QUIET, mode: seg.mode, modules};
}

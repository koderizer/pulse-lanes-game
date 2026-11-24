// render2d.js - Canvas 2D cross-section fallback (FB3-W4, spec section 12). Presentation only.
// Used when a WebGL2 context cannot be created. Looks down the current lane's tunnel:
// depth rings (offset by the same integrated centreline as the WebGL2 view), the ship on
// the depth-0 disc, and asteroids scaled by depth. Consumes rows handed in by app.js and
// never drives the game; nothing computed here flows back into an input entry.

import {createTrack, hash01, MU, SEG, TUBE_R, DEFAULT_SPAWN_Z} from './render.js';

const FOCAL = 70;          // units; scale k(d) = FOCAL / (FOCAL + d)
const SHIP_R = 8;          // SHIP_RADIUS / MU
const LANE_COLORS = ['#ff59d9', '#4cf2e6', '#ffb84d', '#73ff73', '#a680ff'];
const SHAPE_COLORS = ['#9e8c80', '#8c99ad', '#b3806b', '#80766b', '#998f7a', '#736b75', '#99b3d9', '#a8808c'];
const SIDES = [6, 5, 4, 8, 7, 9, 4, 0];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
// R41.4: destruction burst radius multiplier by hit strength 1 / 2 / 3 (unknown strength counts
// as 1; above 3 counts as 3, so the largest burst stays under 2.0x the base radius).
const BURST_STRENGTH_SCALE = Object.freeze([0.7, 1.0, 1.4]);
const burstScale = strength => BURST_STRENGTH_SCALE[clamp(Number.isFinite(strength) ? Math.round(strength) : 1, 1, 3) - 1];

// Shared projection helper (R39.3.1): the cross-section pinhole of draw() (frame centre
// (w / 2, 0.54 h), ship-plane disc radius min(0.46 w, 0.44 h) = TUBE_R, scale
// k(d) = FOCAL / (FOCAL + d)) for a point d world units ahead of the ship plane at lateral offset
// (X, Y) world units from the view axis. Returns [x, y, k] in canvas pixels. Pure; draw() is unchanged.
export function projectCross(w, h, d, X, Y) {
  const unit = Math.min(w * 0.46, h * 0.44) / TUBE_R, k = FOCAL / (FOCAL + Math.max(d, -FOCAL * 0.7));
  return [w / 2 + X * k * unit, h * 0.54 - Y * k * unit, k];
}

// R43.3: [shx, shy, alive] - the ship's last drawn canvas-pixel position, written by draw().
// The app's pickup overlay uses it as the laser ray base so the beam is welded to the sprite.
export const shipAnchor = [0, 0, 0];

export function createRenderer2d(opts = {}) {
  const canvas = opts.canvas;
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) throw new Error('fallback2d: no 2d context');
  let settings = {quality: 'high', reduced_motion: false, ...(opts.settings ?? {})};
  let track = createTrack(null), course = [];
  let spawnZ = Number.isFinite(opts.spawnZ) && opts.spawnZ > 0 ? opts.spawnZ : DEFAULT_SPAWN_Z, observedZ = 0;
  const live = new Map();
  let rocketPrev = new Map(), rocketCur = new Map(), lastView = null, lastProcessed = -1;
  let laneF = 1, shake = 0, flash = 0, flashColor = '255,140,80', effectTime = 0, lastNow = null;
  let lastFireReady = 0, endHandled = false, crashPending = false, beam = 0, bursts = [];
  const cA = [0, 0, 0], c0 = [0, 0, 0];

  function resetRun() {
    live.clear(); rocketPrev = new Map(); rocketCur = new Map(); lastView = null; lastProcessed = -1;
    shake = 0; flash = 0; lastFireReady = 0; endHandled = false; crashPending = false; beam = 0; bursts = [];
  }

  function syncView(view, p, prev, curr) {
    if (!view || view === lastView) return;
    lastView = view;
    const seen = new Set();
    for (const [id, , , z, hp] of view.asteroids ?? []) {
      const row = course[id];
      if (!row) continue;
      seen.add(id);
      if (z > observedZ) observedZ = z;
      let e = live.get(id);
      if (!e) { e = {id, row, speed: 0, hp, flash: 0, passing: false, screen: null}; live.set(id, e); }
      if (row[3] > p) e.speed = z / (row[3] - p);
      if (hp < e.hp) e.flash = 1;
      e.hp = hp;
    }
    for (const [id, e] of live) {
      if (seen.has(id) || e.passing) continue;
      if (e.row[3] < p) e.passing = true;
      else { if (e.screen) bursts.push({...e.screen, r: e.screen.r * burstScale(e.strength), life: 0, max: 0.45, color: '255,190,110'}); live.delete(id); }
    }
    rocketPrev = rocketCur;
    rocketCur = new Map((view.rockets ?? []).map(r => [r[0], r]));
    if (curr && prev && curr.processed !== lastProcessed) {
      lastProcessed = curr.processed;
      if (curr.fire_ready !== lastFireReady && curr.fire_ready > prev.fire_ready) beam = 1;
      lastFireReady = curr.fire_ready;
    }
  }

  // R41.4 (spec 27.4.3) burst strength: the hp the last hit removed, hp_before - hp_left, from the
  // [t, 5, id, hp_left] hit events app.js hands in before the next draw. hp_before is the last seen
  // hp of that id: an earlier hit in the same batch, else the hp column of the view rows (e.hp).
  function noteHits(events) {
    const seen = new Map();
    for (const ev of events ?? []) {
      if (!Array.isArray(ev) || ev[1] !== 5 || ev.length !== 4) continue;
      const [, , id, hpLeft] = ev, e = live.get(id);
      if (!e || !Number.isFinite(hpLeft)) continue;
      e.strength = (seen.has(id) ? seen.get(id) : e.hp) - hpLeft;
      seen.set(id, hpLeft);
    }
  }

  function shapePath(shape, x, y, r, angle, key) {
    ctx.beginPath();
    if (shape === 7) { // twin
      ctx.arc(x - r * 0.36 * Math.cos(angle), y - r * 0.36 * Math.sin(angle), r * 0.62, 0, Math.PI * 2);
      ctx.moveTo(x + r * 0.4 * Math.cos(angle) + r * 0.54, y + r * 0.4 * Math.sin(angle));
      ctx.arc(x + r * 0.4 * Math.cos(angle), y + r * 0.4 * Math.sin(angle), r * 0.54, 0, Math.PI * 2);
      return;
    }
    const n = SIDES[shape];
    for (let i = 0; i < n; i++) {
      const a = angle + i / n * Math.PI * 2;
      let rr = r;
      if (shape >= 3 && shape <= 5) rr *= 0.78 + hash01(key * 13 + i) * 0.22;
      if (shape === 6) rr *= i % 2 ? 0.34 : 1;
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  function resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, settings.quality === 'low' ? 1 : 2);
    const w = Math.max(1, Math.round((canvas.clientWidth || canvas.width) * dpr));
    const h = Math.max(1, Math.round((canvas.clientHeight || canvas.height) * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return [w, h, dpr];
  }

  function draw(frame = {}) {
    const now = Number.isFinite(frame.now) ? frame.now : performance.now();
    const dtReal = lastNow === null ? 0 : clamp((now - lastNow) / 1000, 0, 0.1);
    lastNow = now;
    const dt = frame.paused ? 0 : dtReal;
    effectTime += dt;
    const reduced = Boolean(settings.reduced_motion), low = settings.quality === 'low';
    const [w, h, dpr] = resize();

    let T, sx = 0, sy = 0, lane = 1, curr = null, prev = null, alive = true;
    const a = clamp(Number(frame.alpha) || 0, 0, 1);
    if (frame.curr) {
      curr = frame.curr; prev = frame.prev ?? curr;
      T = curr.processed - 2 + a;
      sx = lerp(prev.position[0], curr.position[0], a) / MU;
      sy = lerp(prev.position[1], curr.position[1], a) / MU;
      lane = curr.lane;
      syncView(frame.view, curr.processed, prev, curr);
      if (curr.status === 'ended') {
        if (!endHandled) {
          endHandled = true;
          if (curr.terminal_reason === 'collision') { crashPending = true; flash = reduced ? 0.25 : 0.8; flashColor = '255,140,80'; if (!reduced) shake = 1; }
          else if (curr.terminal_reason === 'complete') { flash = 0.5; flashColor = '105,226,211'; }
        }
        if (curr.terminal_reason === 'collision') alive = false;
      }
    } else {
      T = (Number(frame.cruise) || 0) * 60;
      sx = Math.sin(T / 140) * 22; sy = Math.cos(T / 190) * 14 - 6;
    }
    const sShip = track.sAt(T);
    laneF += (lane - laneF) * (dtReal > 0 ? 1 - Math.exp(-dtReal / 0.12) : 1);
    shake *= Math.exp(-dt * 4.5);

    const R = Math.min(w * 0.46, h * 0.44);
    const unit = R / TUBE_R;
    const jx = reduced ? 0 : shake * 14 * dpr * Math.sin(effectTime * 41), jy = reduced ? 0 : shake * 14 * dpr * Math.sin(effectTime * 37 + 1);
    const cx = w / 2 + (lane - laneF) * w * 0.6 + jx, cy = h * 0.54 + jy;
    track.centreInt(lane, sShip, c0);
    const project = (d, X, Y) => {
      const k = FOCAL / (FOCAL + Math.max(d, -FOCAL * 0.7));
      return [cx + (X - c0[0]) * k * unit, cy - (Y - c0[1]) * k * unit, k];
    };

    // background and tunnel depth rings, far to near
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, w, h);
    const vis = Math.max(spawnZ, observedZ) / MU + 20;
    const spacing = SEG / (low ? 2 : 4);
    const first = Math.ceil(sShip / spacing) * spacing;
    const color = LANE_COLORS[lane % LANE_COLORS.length];
    const beat = track.beatsAt(T), pulse = Math.exp(-(beat - Math.floor(beat)) * 5);
    ctx.lineWidth = Math.max(1, dpr);
    for (let s = first + Math.floor(vis / spacing) * spacing; s >= first; s -= spacing) {
      const d = s - sShip;
      track.centreInt(lane, s, cA);
      const [x, y, k] = project(d, cA[0], cA[1]);
      const isBeat = Math.abs(s / SEG - Math.round(s / SEG)) < 1e-6;
      const fog = 1 - d / vis;
      ctx.globalAlpha = clamp(fog * (isBeat ? 0.55 + 0.45 * pulse * (d < 160 ? 1 : 0) : 0.22), 0, 1);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, dpr) * (isBeat ? 2 : 1);
      ctx.beginPath(); ctx.arc(x, y, R * k, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // ship-plane disc
    ctx.strokeStyle = color; ctx.lineWidth = 3 * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(76,90,130,0.08)'; ctx.fill();

    // asteroids of the ship's lane, far to near; those past the ship plane drawn on top
    const items = [];
    for (const [id, e] of live) {
      const row = e.row, speed = e.speed || 3600;
      const d = (row[3] - T) * speed / MU;
      if (e.passing && d < -FOCAL * 0.6) { live.delete(id); continue; }
      e.flash = Math.max(0, e.flash - dt * 5);
      if (row[2] !== lane) continue;
      track.centreInt(row[2], sShip + d, cA);
      const [x, y, k] = project(d, cA[0] + row[9] / MU, cA[1] + row[10] / MU);
      e.screen = {x, y, r: row[6] / MU * k * unit};
      items.push({d, x, y, k, e});
    }
    items.sort((p, q) => q.d - p.d);
    const drawAsteroid = it => {
      const {e, x, y, k, d} = it, row = e.row, key = e.id * 8 + row[8];
      const r = row[6] / MU * k * unit;
      const angle = hash01(key) * 6.283 + (hash01(key + 1) - 0.5) * 0.03 * T;
      ctx.globalAlpha = clamp(d < 0 ? 1 + d / (FOCAL * 0.6) : 0.35 + 0.65 * (1 - d / vis), 0, 1);
      shapePath(row[8] % 8, x, y, r, angle, key);
      ctx.fillStyle = SHAPE_COLORS[row[8] % 8]; ctx.fill();
      ctx.lineWidth = Math.max(1, dpr * 1.5);
      ctx.strokeStyle = e.flash > 0 ? `rgba(255,220,160,${0.4 + e.flash * 0.6})` : (d < 100 && d > 0 ? '#ffb27a' : '#2a2f40');
      ctx.stroke();
    };
    for (const it of items) if (it.d >= 0) drawAsteroid(it);

    // rockets in this lane
    for (const [id, r] of rocketCur) {
      if (r[1] !== lane) continue;
      const p0 = rocketPrev.get(id), depth = lerp(p0 ? p0[4] : 0, r[4], a) / MU;
      track.centreInt(lane, sShip + depth, cA);
      const [x, y, k] = project(depth, cA[0] + r[2] / MU, cA[1] + r[3] / MU);
      ctx.globalAlpha = 1; ctx.fillStyle = '#ff9a3c';
      ctx.beginPath(); ctx.arc(x, y, Math.max(2 * dpr, 3 * k * unit), 0, Math.PI * 2); ctx.fill();
    }

    // ship
    const shx = cx + sx * unit, shy = cy - sy * unit;
    // R43.3 (live QA): publish the ship's screen anchor so the pickup-overlay laser ray can
    // start exactly on the sprite (the overlay cannot recompute the renderer's laneF camera lag).
    shipAnchor[0] = shx; shipAnchor[1] = shy; shipAnchor[2] = alive ? 1 : 0;
    if (beam > 0 && alive) {
      const far = project(240, c0[0] + sx, c0[1] + sy);
      ctx.globalAlpha = beam; ctx.strokeStyle = '#ff4d6a'; ctx.lineWidth = 3 * dpr;
      ctx.beginPath(); ctx.moveTo(shx, shy); ctx.lineTo(far[0], far[1]); ctx.stroke();
      beam = Math.max(0, beam - dt * 7);
    }
    if (alive) {
      const locked = curr ? curr.locked_until > curr.processed : false;
      const s = SHIP_R * unit * 1.3;
      ctx.globalAlpha = 1;
      ctx.fillStyle = locked && Math.sin(effectTime * 18) > 0 ? '#ff8e8e' : '#69e2d3';
      ctx.beginPath();
      ctx.moveTo(shx, shy - s); ctx.lineTo(shx + s, shy + s * 0.55); ctx.lineTo(shx, shy + s * 0.2); ctx.lineTo(shx - s, shy + s * 0.55);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(105,226,211,0.35)'; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.arc(shx, shy, SHIP_R * unit, 0, Math.PI * 2); ctx.stroke();
    } else if (crashPending) {
      crashPending = false;
      bursts.push({x: shx, y: shy, r: SHIP_R * unit * 3, life: 0, max: 0.6, color: '255,170,90'});
    }
    for (const it of items) if (it.d < 0) drawAsteroid(it);

    // bursts (destroyed asteroids, collision)
    bursts = bursts.filter(b => (b.life += dt) < b.max).slice(-24);
    for (const b of bursts) {
      const f = b.life / b.max;
      ctx.globalAlpha = 1 - f; ctx.strokeStyle = `rgb(${b.color})`; ctx.lineWidth = 3 * dpr;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * (1 + f * 1.5), 0, Math.PI * 2); ctx.stroke();
    }

    // lane strip: every lane of the current loop, lane 0 leftmost; nearby asteroids as dots
    const count = curr ? curr.lane_count : track.laneCountAtS(sShip);
    const mr = Math.min(20 * dpr, w / (count * 3 + 2)), gap = mr * 2.8, top = Math.max(70 * dpr, h * 0.12);
    const x0 = w / 2 - gap * (count - 1) / 2;
    for (let j = 0; j < count; j++) {
      const x = x0 + j * gap;
      ctx.globalAlpha = 1;
      ctx.lineWidth = (j === lane ? 3 : 1.5) * dpr;
      ctx.strokeStyle = LANE_COLORS[j % LANE_COLORS.length];
      ctx.fillStyle = j === lane ? 'rgba(105,226,211,0.18)' : 'rgba(20,24,40,0.6)';
      ctx.beginPath(); ctx.arc(x, top, mr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      for (const e of live.values()) {
        if (e.row[2] !== j) continue;
        const d = (e.row[3] - T) * (e.speed || 3600) / MU;
        if (d < 0 || d > 200) continue;
        const k = 1 - d / 200;
        ctx.globalAlpha = 0.3 + 0.7 * k; ctx.fillStyle = '#ffb27a';
        ctx.beginPath(); ctx.arc(x + e.row[9] / 100000 * mr * 0.8, top - e.row[10] / 100000 * mr * 0.8, Math.max(1.5 * dpr, e.row[6] / 100000 * mr * k), 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if (flash > 0.01) { ctx.fillStyle = `rgba(${flashColor},${flash * 0.5})`; ctx.fillRect(0, 0, w, h); flash *= Math.exp(-dt * 3); }
  }

  return {
    kind: 'fallback2d',
    setCourse(map, rows) { track = createTrack(map); course = Array.isArray(rows) ? rows : []; resetRun(); laneF = 1; },
    setSettings(next) { settings = {...settings, ...(next ?? {})}; },
    setSpawnZ(z) { if (Number.isFinite(z) && z > 0) spawnZ = z; },
    visibleDepthMu: () => Math.max(spawnZ, observedZ) + 20 * MU,
    onContextLost() {},
    noteHits,
    draw,
    dispose() {},
  };
}

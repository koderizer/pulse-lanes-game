// HUD (spec section 14, pl-v3 additions spec 21 and ruling R35.9): status only, read-only view
// of state() and map(). Never calls step/abandon and nothing here flows back into an input entry.
// The controls it paints (boost charge ring, hop ready/dim, ammo badge) are presentation of the
// sim state row; every press still goes through app.js as a sim input.
import {CHARGE_CAP, HOP_COST, ROCKET_CAP, ENERGY_CAPACITY} from '../src/sim/space_racer_v3.js';

const MAX_TICKS = 7200;
const ENERGY_CAP = 10000;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Lobby mode labels (spec 21.6), shared by the lobby selector and the HUD.
export const MODE_LABELS = Object.freeze({death: 'DEATH', timed90: '90S', timed120: '120S'});

// R35.11: KM = floor(distance / 1000) with thousands separators. Locale independent on purpose.
export function formatKm(distance) {
  const km = Math.max(0, Math.floor(Number(distance) / 1000)) || 0;
  return String(km).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Boost button state from the charge value (spec 21.2): ready only at full charge.
export function boostState(charge) {
  if (charge >= CHARGE_CAP) return 'ready';
  return charge > 0 ? 'charging' : 'spent';
}

// R45.2 / R45.5: laser energy capacity of a ship model id, with the sim's own fallback (anything
// that is not an own key of ENERGY_CAPACITY flies as 'dart').
function laserCapacity(shipId) {
  const known = typeof shipId === 'string' && Object.prototype.hasOwnProperty.call(ENERGY_CAPACITY, shipId);
  return ENERGY_CAPACITY[known ? shipId : 'dart'];
}

function formatHudV3(state, map, options) {
  const loops = map?.loops ?? [];
  const loopCount = loops.length || 3;
  const bpm = loops[state.loop % loopCount]?.bpm ?? [90, 120, 150][state.loop % 3];
  const fireIn = Math.max(0, state.fire_ready - state.processed);
  const charge = Math.max(0, Math.min(CHARGE_CAP, state.charge));
  const cooldown = state.hop_ready > state.processed;
  const low = charge < HOP_COST;
  const bState = boostState(charge);
  const active = state.processed < state.boost_until;
  const cap = laserCapacity(options.shipId);
  const laser = Math.max(0, Math.min(cap, Number.isFinite(state.energy) ? state.energy : cap));
  return {
    v3: true,
    score: `${formatKm(state.distance)} KM · ${MODE_LABELS[state.mode] ?? state.mode}`,
    energy: {value: charge, max: CHARGE_CAP, label: 'Charge', percent: Math.floor(charge * 100 / CHARGE_CAP), locked: false,
      ready: bState === 'ready', text: String(charge)},
    boost: {state: bState, ready: bState === 'ready', active, percent: Math.floor(charge * 100 / CHARGE_CAP),
      label: active ? 'ON' : bState === 'ready' ? 'BOOST' : bState === 'spent' ? 'EMPTY' : `${charge}%`},
    hop: {ready: !cooldown && !low, why: low ? 'charge' : cooldown ? 'cooldown' : ''},
    ammo: {value: state.ammo, max: ROCKET_CAP, text: String(state.ammo)},
    laser: {value: laser, max: cap, percent: laser * 100 / cap, empty: laser === 0},
    lane: `${state.lane + 1} / ${state.lane_count}`,
    loop: `${state.loop + 1} · ${bpm} BPM`,
    weapon: fireIn > 0 ? `${state.weapon} · ${fireIn}` : `${state.weapon} · ready`,
  };
}

// Pure formatting; testable without a DOM. `state` is Game.state(), `map` is Game.map() (or null).
// `options.shipId` is the ship model the pl-v3 game was created with (the LASER meter capacity).
export function formatHud(state, map = null, options = {}) {
  if (state.ruleset_id === 'pl-v3') return formatHudV3(state, map, options ?? {});
  const loops = map?.loops ?? [];
  const loopCount = loops.length || 3;
  const loopIndex = Math.min(state.loop, loopCount - 1);
  const bpm = loops[loopIndex]?.bpm ?? [90, 120, 150][Math.min(loopIndex, 2)];
  const fireIn = Math.max(0, state.fire_ready - state.processed);
  const locked = state.locked_until > state.processed;
  return {
    v3: false,
    score: `${state.score} / ${MAX_TICKS}`,
    energy: {value: state.energy, max: ENERGY_CAP, label: 'Energy',
      percent: Math.max(0, Math.min(100, Math.floor(state.energy * 100 / ENERGY_CAP))), locked, ready: false,
      text: locked ? `${state.energy} (exhausted)` : String(state.energy)},
    lane: `${state.lane + 1} / ${state.lane_count}`,
    loop: `${loopIndex + 1} / ${loopCount} · ${bpm} BPM`,
    weapon: fireIn > 0 ? `${state.weapon} · ${fireIn}` : `${state.weapon} · ready`,
  };
}

// Builds the pl-v3 controls once (index.html stays unchanged): the round #boost button with an
// inline rocket-booster SVG and its charge ring, placed in #cluster above #fire, and the #hud-ammo
// rocket count badge under #fire (also the rocket-latch button). Returns {boost, ammo}; an existing
// build is reused.
export function buildControls(doc) {
  const cluster = doc.getElementById('cluster'), fire = doc.getElementById('fire');
  let boost = doc.getElementById('boost'), ammo = doc.getElementById('hud-ammo');
  if (cluster && !boost) {
    boost = doc.createElement('button');
    boost.type = 'button';
    boost.id = 'boost';
    boost.className = 'boost';
    boost.disabled = true;
    boost.dataset.state = 'spent';
    boost.dataset.active = 'false';
    boost.setAttribute('aria-label', 'Boost (B): charging');
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const node = (tag, attrs, parent = svg) => {
      const n = doc.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      parent.append(n);
      return n;
    };
    node('circle', {class: 'boost-track', cx: '32', cy: '32', r: '29'});
    node('circle', {class: 'boost-ring', cx: '32', cy: '32', r: '29', pathLength: '100', 'stroke-dasharray': '100',
      'stroke-dashoffset': '100', transform: 'rotate(-90 32 32)'});
    // Rocket booster in the upper part of the ring (the label sits below it): nose and body, side
    // fins, nozzle and the exhaust flame (lit while boosting).
    const icon = node('g', {class: 'boost-icon', transform: 'translate(32 9) scale(.75) translate(-32 -11.5)'});
    node('path', {class: 'boost-flame', d: 'M28.5 40.5h7c0 4.5-2 8-3.5 10.5-1.5-2.5-3.5-6-3.5-10.5z'}, icon);
    node('path', {class: 'boost-body', d: 'M32 11.5c4.2 3 6 8 6 14v10.5H26V25.5c0-6 1.8-11 6-14z'}, icon);
    node('path', {class: 'boost-fin', d: 'M26 28l-5.5 6.5v5L26 37zM38 28l5.5 6.5v5L38 37z'}, icon);
    node('path', {class: 'boost-nozzle', d: 'M27.5 36h9l-1.5 4.5h-6z'}, icon);
    node('circle', {class: 'boost-port', cx: '32', cy: '23.5', r: '2.6'}, icon);
    const label = doc.createElement('span');
    label.className = 'boost-label';
    label.textContent = 'EMPTY';
    boost.append(svg, label);
    cluster.append(boost);
  }
  if (fire && !ammo) {
    // Spec 26.2.3 (FB3-WEB4): the badge is the mobile rocket-latch toggle, a real button with
    // aria-pressed. It is the next sibling of #fire (a button never nests in a button) and keeps
    // the same box: `#cluster .ammo` is absolute and #cluster is the fixed flex row whose centre is
    // the fire button's centre and whose bottom is its bottom, so the geometry at 390x844 is
    // unchanged. lobby.css sets pointer-events:none on the badge; the inline value re-enables taps.
    ammo = doc.createElement('button');
    ammo.type = 'button';
    ammo.id = 'hud-ammo';
    ammo.className = 'ammo';
    ammo.setAttribute('aria-pressed', 'false');
    ammo.setAttribute('aria-label', 'Rockets (R): off');
    ammo.style.setProperty('pointer-events', 'auto');
    ammo.dataset.empty = 'true';
    const icon = doc.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M8 1.5c1.8 1.4 2.5 3.4 2.5 5.6V11h-5V7.1c0-2.2.7-4.2 2.5-5.6zM5.5 8L3.5 10.5v2.5l2-1zM10.5 8l2 2.5v2.5l-2-1zM6.8 11.5h2.4L8 14.5z');
    icon.append(p);
    const n = doc.createElement('span');
    n.className = 'ammo-n';
    n.textContent = '0';
    ammo.append(icon, n);
    fire.after(ammo);
  }
  const charge = doc.getElementById('hud-energy');
  let laser = doc.getElementById('hud-laser');
  if (charge && !laser) {
    // R45.5: the LASER energy meter, right after the charge meter and shaped like it (a track with
    // a fill). Its look is inline: lobby.css keys the meter rules to the #hud-energy id and
    // web/style.css is not linked by index.html. Hidden until a pl-v3 state paints it.
    laser = doc.createElement('div');
    laser.id = 'hud-laser';
    laser.setAttribute('role', 'meter');
    laser.setAttribute('aria-label', 'Laser energy');
    laser.setAttribute('aria-valuemin', '0');
    Object.assign(laser.style, {display: 'none', alignItems: 'center', gap: '6px', minWidth: '120px',
      fontSize: '11px', letterSpacing: '2px', color: '#ff4d6a'});
    const bar = doc.createElement('span');
    bar.className = 'bar';
    Object.assign(bar.style, {display: 'block', flex: '1', height: '6px', border: '1px solid #3d4764', borderRadius: '4px',
      background: '#0b0e1a', overflow: 'hidden'});
    const fill = doc.createElement('i');
    Object.assign(fill.style, {display: 'block', height: '100%', width: '100%', background: '#ff4d6a',
      boxShadow: '0 0 6px rgba(255,77,106,.9)'});
    bar.append(fill);
    laser.append('LASER', bar);
    charge.after(laser);
  }
  return {boost, ammo, laser};
}

// Paints the rocket latch (state lives in app.js only): aria-pressed on the badge and on #fire,
// plus the rocket tint on #fire (amber rim and glow in the --boost colour of the badge rim; the
// 3 px border width and the box are unchanged, so nothing moves).
export function paintRocketLatch(doc, on) {
  const pressed = String(Boolean(on));
  const ammo = doc.getElementById('hud-ammo'), fire = doc.getElementById('fire');
  if (ammo) {
    ammo.setAttribute('aria-pressed', pressed);
    ammo.setAttribute('aria-label', `Rockets (R): ${on ? 'on' : 'off'}`);
  }
  if (fire) {
    fire.setAttribute('aria-pressed', pressed);
    fire.dataset.rocket = pressed;
    fire.style.setProperty('border-color', on ? 'var(--boost)' : '');
    fire.style.setProperty('box-shadow', on ? '0 0 0 2px rgba(255,179,71,.55),0 0 18px rgba(255,140,50,.85)' : '');
  }
}

export function renderHud(root, state, map = null, options = {}) {
  const f = formatHud(state, map, options);
  const q = id => root.querySelector('#' + id);
  const set = (id, text) => { const el = q(id); if (el && el.textContent !== text) el.textContent = text; };
  const attr = (el, k, v) => { if (el && el.getAttribute(k) !== v) el.setAttribute(k, v); };
  const data = (el, k, v) => { if (el && el.dataset[k] !== v) el.dataset[k] = v; };
  set('hud-score', f.score);
  set('hud-lane', f.lane);
  set('hud-loop', f.loop);
  set('hud-weapon', f.weapon);
  // #hud-energy is the mobility meter: pl-v2 energy, or the pl-v3 charge (same element and id).
  const energy = q('hud-energy');
  if (energy) {
    attr(energy, 'aria-label', f.energy.label);
    attr(energy, 'aria-valuemax', String(f.energy.max));
    attr(energy, 'aria-valuenow', String(f.energy.value));
    data(energy, 'locked', String(f.energy.locked));
    data(energy, 'ready', String(f.energy.ready));
    const bar = energy.querySelector('.bar > i');
    if (bar) bar.style.width = f.energy.percent + '%';
    const val = energy.querySelector('.val');
    if (val && val.textContent !== f.energy.text) val.textContent = f.energy.text;
  }
  // R45.5 LASER meter: width = energy / capacity of the run's ship model; a dim flash and a red
  // track edge when it runs dry (the moment a held press stops producing a beam).
  const laser = q('hud-laser');
  if (laser) {
    const display = f.v3 ? 'flex' : 'none';
    if (laser.style.display !== display) laser.style.display = display;
    if (f.v3) {
      const L = f.laser;
      attr(laser, 'aria-valuemax', String(L.max));
      attr(laser, 'aria-valuenow', String(L.value));
      const fill = laser.querySelector('.bar > i');
      const width = `${Math.round(L.percent * 10) / 10}%`;
      if (fill && fill.style.width !== width) fill.style.width = width;
      const wasEmpty = laser.dataset.empty === 'true';
      data(laser, 'empty', String(L.empty));
      if (L.empty !== wasEmpty) {
        const bar = laser.querySelector('.bar');
        if (bar) bar.style.borderColor = L.empty ? '#ff4d6a' : '#3d4764';
        if (L.empty) laser.animate?.([{opacity: 1}, {opacity: 0.35}, {opacity: 1}], {duration: 240});
      }
    }
  }
  const boost = q('boost'), ammo = q('hud-ammo'), fire = q('fire');
  if (boost) {
    boost.hidden = !f.v3;
    if (f.v3) {
      const b = f.boost;
      if (boost.disabled !== !b.ready) boost.disabled = !b.ready;
      data(boost, 'state', b.state);
      data(boost, 'active', String(b.active));
      attr(boost, 'aria-label', `Boost (B): ${b.ready ? 'ready' : b.active ? 'boosting' : `charge ${b.percent} of 100`}`);
      attr(boost.querySelector('.boost-ring'), 'stroke-dashoffset', String(100 - b.percent));
      const label = boost.querySelector('.boost-label');
      if (label && label.textContent !== b.label) label.textContent = b.label;
    }
  }
  if (ammo) {
    ammo.hidden = !f.v3;
    if (f.v3) {
      const n = ammo.querySelector('.ammo-n') ?? ammo;
      if (n.textContent !== f.ammo.text) n.textContent = f.ammo.text;
      data(ammo, 'empty', String(f.ammo.value === 0));
    }
  }
  attr(fire, 'aria-label', f.v3 ? `Fire (rockets: ${f.ammo.text})` : 'Fire');
  for (const id of ['hop-left', 'hop-right']) {
    const hop = q(id);
    if (!hop) continue;
    if (f.v3) { data(hop, 'ready', String(f.hop.ready)); data(hop, 'why', f.hop.why); }
    else if (hop.dataset.ready !== undefined) { delete hop.dataset.ready; delete hop.dataset.why; }
  }
  return f;
}

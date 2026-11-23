// HUD (spec section 14, pl-v3 additions spec 21 and ruling R35.9): status only, read-only view
// of state() and map(). Never calls step/abandon and nothing here flows back into an input entry.
// The controls it paints (boost charge ring, hop ready/dim, ammo badge) are presentation of the
// sim state row; every press still goes through app.js as a sim input.
import {CHARGE_CAP, HOP_COST, ROCKET_CAP} from '../src/sim/space_racer_v3.js';

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

function formatHudV3(state, map) {
  const loops = map?.loops ?? [];
  const loopCount = loops.length || 3;
  const bpm = loops[state.loop % loopCount]?.bpm ?? [90, 120, 150][state.loop % 3];
  const fireIn = Math.max(0, state.fire_ready - state.processed);
  const charge = Math.max(0, Math.min(CHARGE_CAP, state.charge));
  const cooldown = state.hop_ready > state.processed;
  const low = charge < HOP_COST;
  const bState = boostState(charge);
  const active = state.processed < state.boost_until;
  return {
    v3: true,
    score: `${formatKm(state.distance)} KM · ${MODE_LABELS[state.mode] ?? state.mode}`,
    energy: {value: charge, max: CHARGE_CAP, label: 'Charge', percent: Math.floor(charge * 100 / CHARGE_CAP), locked: false,
      ready: bState === 'ready', text: String(charge)},
    boost: {state: bState, ready: bState === 'ready', active, percent: Math.floor(charge * 100 / CHARGE_CAP),
      label: active ? 'ON' : bState === 'ready' ? 'BOOST' : bState === 'spent' ? 'EMPTY' : `${charge}%`},
    hop: {ready: !cooldown && !low, why: low ? 'charge' : cooldown ? 'cooldown' : ''},
    ammo: {value: state.ammo, max: ROCKET_CAP, text: String(state.ammo)},
    lane: `${state.lane + 1} / ${state.lane_count}`,
    loop: `${state.loop + 1} · ${bpm} BPM`,
    weapon: fireIn > 0 ? `${state.weapon} · ${fireIn}` : `${state.weapon} · ready`,
  };
}

// Pure formatting; testable without a DOM. `state` is Game.state(), `map` is Game.map() (or null).
export function formatHud(state, map = null) {
  if (state.ruleset_id === 'pl-v3') return formatHudV3(state, map);
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
// rocket count badge on #fire. Returns {boost, ammo}; an existing build is reused.
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
    ammo = doc.createElement('span');
    ammo.id = 'hud-ammo';
    ammo.className = 'ammo';
    ammo.setAttribute('aria-hidden', 'true');
    ammo.dataset.empty = 'true';
    const icon = doc.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('focusable', 'false');
    const p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M8 1.5c1.8 1.4 2.5 3.4 2.5 5.6V11h-5V7.1c0-2.2.7-4.2 2.5-5.6zM5.5 8L3.5 10.5v2.5l2-1zM10.5 8l2 2.5v2.5l-2-1zM6.8 11.5h2.4L8 14.5z');
    icon.append(p);
    const n = doc.createElement('span');
    n.className = 'ammo-n';
    n.textContent = '0';
    ammo.append(icon, n);
    fire.append(ammo);
  }
  return {boost, ammo};
}

export function renderHud(root, state, map = null) {
  const f = formatHud(state, map);
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

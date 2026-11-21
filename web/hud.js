// HUD (spec section 14): status only, read-only view of state() and map().
// Never calls step/abandon and nothing here flows back into an input entry.

const MAX_TICKS = 7200;
const ENERGY_CAP = 10000;

// Pure formatting; testable without a DOM. `state` is Game.state(), `map` is Game.map() (or null).
export function formatHud(state, map = null) {
  const loops = map?.loops ?? [];
  const loopCount = loops.length || 3;
  const loopIndex = Math.min(state.loop, loopCount - 1);
  const bpm = loops[loopIndex]?.bpm ?? [90, 120, 150][Math.min(loopIndex, 2)];
  const fireIn = Math.max(0, state.fire_ready - state.processed);
  const locked = state.locked_until > state.processed;
  return {
    score: `${state.score} / ${MAX_TICKS}`,
    energy: {value: state.energy, percent: Math.max(0, Math.min(100, Math.floor(state.energy * 100 / ENERGY_CAP))), locked,
      text: locked ? `${state.energy} (exhausted)` : String(state.energy)},
    lane: `${state.lane + 1} / ${state.lane_count}`,
    loop: `${loopIndex + 1} / ${loopCount} · ${bpm} BPM`,
    weapon: fireIn > 0 ? `${state.weapon} · ${fireIn}` : `${state.weapon} · ready`,
  };
}

export function renderHud(root, state, map = null) {
  const f = formatHud(state, map);
  const set = (id, text) => { const el = root.querySelector('#' + id); if (el && el.textContent !== text) el.textContent = text; };
  set('hud-score', f.score);
  set('hud-lane', f.lane);
  set('hud-loop', f.loop);
  set('hud-weapon', f.weapon);
  const energy = root.querySelector('#hud-energy');
  if (energy) {
    energy.setAttribute('aria-valuenow', String(f.energy.value));
    energy.dataset.locked = String(f.energy.locked);
    const bar = energy.querySelector('.bar > i');
    if (bar) bar.style.width = f.energy.percent + '%';
    const val = energy.querySelector('.val');
    if (val && val.textContent !== f.energy.text) val.textContent = f.energy.text;
  }
  return f;
}

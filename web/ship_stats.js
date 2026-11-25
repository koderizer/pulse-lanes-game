// ship_stats.js - the lobby stats panel data (spec 14, ruling R50.2). Every value is read from
// its law source (sim constants / ship registry) so the lobby can never drift from the engine.
import {ENERGY_CAPACITY, ENERGY_REGEN, ENERGY_DRAIN, NOTE_SPEED} from '../src/sim/space_racer_v3.js';
import {SHIPS, shipIdOrDefault, outlineBounds} from './ships.js';

// [label, element id] in display order; app.js renders one row per entry.
export const STAT_ROWS = Object.freeze([
  Object.freeze(['Laser cap', 'stat-cap']),
  Object.freeze(['Recharge', 'stat-recharge']),
  Object.freeze(['Laser drain', 'stat-drain']),
  Object.freeze(['Base speed', 'stat-speed']),
  Object.freeze(['Hull', 'stat-hull']),
]);

export function shipStats(shipId) {
  const id = shipIdOrDefault(shipId);
  const model = SHIPS.find(m => m.id === id) ?? SHIPS[0];
  const [x0, z0, x1, z1] = outlineBounds(model);
  return {
    id, name: model.name, blurb: model.blurb,
    values: {
      'stat-cap': String(ENERGY_CAPACITY[id]),
      'stat-recharge': '+' + ENERGY_REGEN + '/tick',
      'stat-drain': '-' + ENERGY_DRAIN + '/tick',
      'stat-speed': NOTE_SPEED[2] + ' u/t',
      'stat-hull': (x1 - x0).toFixed(1) + ' x ' + (z1 - z0).toFixed(1) + ' x ' + (2 * model.height).toFixed(2) + ' u',
    },
  };
}

export const RULESET_ID = 'pl-v1';
export const TICKS_PER_SECOND = 60;
export const MAX_TICKS = 7200;

export function fail(code) { throw Object.assign(new Error(code), {code}); }
export const exactKeys = (value, keys) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function validateInputs(inputs) {
  if (!Array.isArray(inputs)) fail('wrong_type');
  if (inputs.length > MAX_TICKS) fail('out_of_range');
  let previous = -1;
  for (const input of inputs) {
    if (!exactKeys(input, ['tick', 'action'])) fail('invalid_input_entry');
    if (!Number.isInteger(input.tick) || typeof input.action !== 'string') fail('wrong_type');
    if (input.tick < 0 || input.tick >= MAX_TICKS) fail('out_of_range');
    if (!['left', 'right'].includes(input.action)) fail('invalid_action');
    if (input.tick === previous) fail('conflicting_inputs');
    if (input.tick < previous) fail('input_order');
    previous = input.tick;
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export async function sha256Hex(bytes) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}

function generateCourse(seed) {
  let x = seed >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7FEB352D) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846CA68B) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  if (x === 0) x = 0x9E3779B9;
  const rows = [];
  for (let stage = 0; stage < 3; stage++) {
    for (let tick = stage * 2400; tick < (stage + 1) * 2400; tick += [80, 30, 24][stage]) {
      if (tick === 0) continue;
      x = (x ^ (x << 13)) >>> 0;
      x = (x ^ (x >>> 17)) >>> 0;
      x = (x ^ (x << 5)) >>> 0;
      const bit = 1 << (x % 3);
      rows.push([tick, stage === 2 ? 7 ^ bit : bit]);
    }
  }
  let reach = [1], previous = -1;
  for (const [tick, mask] of rows) {
    reach = [0, 1, 2].filter(lane => !(mask & (1 << lane)) &&
      reach.some(from => Math.abs(lane - from) <= tick - previous));
    if (!reach.length) throw new Error('Unreachable course');
    previous = tick;
  }
  return rows;
}

export function createGame(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) fail('out_of_range');
  const rows = generateCourse(seed), states = [], applied = [];
  let lane = 1, cleared = 0, rowIndex = 0, reason = null, terminal = null;
  const core = () => {
    if (!reason) fail('not_terminal');
    return {ruleset_id: RULESET_ID, seed, inputs: applied.map(x => ({...x})),
      terminal_tick: terminal, terminal_reason: reason, score: terminal};
  };
  const game = {
    step(ticks, inputs) {
      if (reason) return game.state();
      if (!Number.isSafeInteger(ticks) || ticks < 0) fail('out_of_range');
      validateInputs(inputs);
      const start = states.length;
      for (const {tick} of inputs) if (tick < start || tick - start >= ticks) fail('out_of_range');
      let inputIndex = 0;
      for (let count = 0; count < ticks && !reason; count++) {
        const tick = states.length;
        let action = 0;
        if (inputs[inputIndex]?.tick === tick) {
          const input = inputs[inputIndex++];
          action = input.action === 'left' ? 1 : 2;
          lane = Math.max(0, Math.min(2, lane + (action === 1 ? -1 : 1)));
          applied.push({...input});
        }
        const mask = rows[rowIndex]?.[0] === tick ? rows[rowIndex++][1] : 0;
        if (mask & (1 << lane)) { reason = 'collision'; terminal = tick; }
        else if (mask) cleared++;
        states.push([tick, action, lane, mask, cleared]);
        if (!reason && states.length === MAX_TICKS) { reason = 'complete'; terminal = MAX_TICKS; }
      }
      return game.state();
    },
    abandon() {
      if (!reason) { reason = 'abandoned'; terminal = states.length; }
      return game.state();
    },
    state() {
      const next = !reason ? rows[rowIndex] : null;
      return {lane, next_row: next ? {mask: next[1], tick: next[0]} : null,
        processed: states.length, rows_cleared: cleared, ruleset_id: RULESET_ID,
        score: reason ? terminal : states.length, seed, status: reason ? 'ended' : 'running',
        terminal_reason: reason, terminal_tick: terminal};
    },
    course: () => rows.map(row => [...row]),
    runRecordCore: core,
    replayObject: () => ({...core(), course: game.course(), states: states.map(row => [...row])}),
    replayBytes: () => new TextEncoder().encode(canonicalJson(game.replayObject())),
  };
  return game;
}

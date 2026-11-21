import {canonicalJson, createGame as createGameV1, sha256Hex, validateInputs as validateInputsV1, exactKeys} from '../../src/sim/pulse_lanes.js';
import {createGame as createGameV2, validateInputs as validateInputsV2} from '../../src/sim/space_racer.js';
import {strictJson} from '../shared/strict_json.js';

export const CURRENT_SCHEMA_VERSION = 2;
export const DEFAULT_SETTINGS = Object.freeze({music_level: 8, mute: false, quality: 'high', reduced_motion: false});
export const STORAGE_KEY = 'pulse-lanes.pilotstate';
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
const matches = (value, regex) => typeof value === 'string' && regex.test(value);
const requireSave = condition => { if (!condition) throw Object.assign(new Error('invalid_save'), {code: 'invalid_save'}); };

export function newSave(installationId) {
  const save = {installation_id: installationId, runs: [], schema_version: CURRENT_SCHEMA_VERSION,
    sessions: [], settings: {...DEFAULT_SETTINGS}};
  const result = importSave(canonicalJson(save));
  if (!result.ok) throw Object.assign(new Error(result.detail), {code: result.code});
  return result.state;
}

export function importSave(text) {
  try {
    const state = strictJson(text);
    requireSave(state !== null && typeof state === 'object' && !Array.isArray(state) &&
      Number.isInteger(state.schema_version) && state.schema_version >= 1);
    if (state.schema_version > CURRENT_SCHEMA_VERSION) return {ok: false, code: 'unsupported_schema_version', detail: 'Newer save version'};
    requireSave(exactKeys(state, ['installation_id', 'runs', 'schema_version', 'sessions', 'settings']));
    if (state.schema_version === 1) {
      requireSave(exactKeys(state.settings, ['mute']) && typeof state.settings.mute === 'boolean');
    } else {
      requireSave(exactKeys(state.settings, Object.keys(DEFAULT_SETTINGS)) && typeof state.settings.mute === 'boolean' &&
        typeof state.settings.reduced_motion === 'boolean' && integer(state.settings.music_level, 0, 10) &&
        ['high', 'low'].includes(state.settings.quality));
    }
    requireSave(matches(state.installation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
    requireSave(Array.isArray(state.runs) && Array.isArray(state.sessions));
    const ids = new Set(), linked = new Set();
    let previous = 0n;
    for (const run of state.runs) {
      requireSave(exactKeys(run, ['build_id', 'inputs', 'replay_hash', 'ruleset_id', 'run_id', 'score', 'seed', 'terminal_reason', 'terminal_tick']));
      requireSave(matches(run.run_id, /^run-[1-9][0-9]{0,15}$/));
      const number = BigInt(run.run_id.slice(4));
      requireSave(number > previous); previous = number; ids.add(run.run_id);
      requireSave((run.ruleset_id === 'pl-v1' || (run.ruleset_id === 'pl-v2' && state.schema_version >= 2)) &&
        matches(run.build_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/));
      requireSave(integer(run.seed, 0, 4294967295));
      const v2 = run.ruleset_id === 'pl-v2';
      try { (v2 ? validateInputsV2 : validateInputsV1)(run.inputs); } catch { requireSave(false); }
      requireSave(['collision', 'complete', 'abandoned'].includes(run.terminal_reason));
      requireSave(integer(run.terminal_tick, 0, run.terminal_reason === 'complete' ? 7200 : 7199));
      requireSave(run.terminal_reason !== 'complete' || run.terminal_tick === 7200);
      requireSave(Number.isInteger(run.score) && run.score === run.terminal_tick);
      const last = run.terminal_reason === 'collision' ? run.terminal_tick : run.terminal_tick - 1;
      requireSave(run.inputs.every(input => (v2 ? input[0] : input.tick) <= last));
      requireSave(matches(run.replay_hash, /^[0-9a-f]{64}$/));
    }
    for (const session of state.sessions) {
      requireSave(exactKeys(session, ['active_ticks', 'ended_at', 'run_ids', 'started_at']));
      requireSave(timestamp(session.started_at) && (session.ended_at === null ||
        (timestamp(session.ended_at) && session.ended_at >= session.started_at)));
      requireSave(integer(session.active_ticks, 0, Number.MAX_SAFE_INTEGER) && Array.isArray(session.run_ids));
      for (const id of session.run_ids) {
        requireSave(ids.has(id) && !linked.has(id)); linked.add(id);
      }
    }
    requireSave(ids.size === linked.size);
    if (state.schema_version === 1) {
      state.schema_version = CURRENT_SCHEMA_VERSION;
      state.settings = {...DEFAULT_SETTINGS, mute: state.settings.mute};
    }
    return {ok: true, state};
  } catch (err) {
    return {ok: false, code: err.code ?? 'invalid_save', detail: err.message};
  }
}

export const exportSave = canonicalJson;

export async function verifyRun(run) {
  const v2 = run.ruleset_id === 'pl-v2';
  if (!v2 && run.ruleset_id !== 'pl-v1') return {ok: false, code: 'unsupported_ruleset'};
  try {
    (v2 ? validateInputsV2 : validateInputsV1)(run.inputs);
    const game = (v2 ? createGameV2 : createGameV1)(run.seed);
    const abandon = run.terminal_reason === 'abandoned';
    const limit = abandon ? run.terminal_tick : 7200;
    if (!integer(limit, 0, abandon ? 7199 : 7200)) return {ok: false, code: 'out_of_range'};
    game.step(limit, run.inputs.filter(input => (v2 ? input[0] : input.tick) < limit));
    if (abandon) game.abandon();
    const core = game.runRecordCore();
    if (core.inputs.length !== run.inputs.length) return {ok: false, code: 'replay_extended'};
    if (core.terminal_reason !== run.terminal_reason || core.terminal_tick !== run.terminal_tick) return {ok: false, code: 'terminal_mismatch'};
    if (core.score !== run.score) return {ok: false, code: 'score_mismatch'};
    if (await sha256Hex(game.replayBytes()) !== run.replay_hash) return {ok: false, code: 'hash_mismatch'};
    return {ok: true};
  } catch (err) { return {ok: false, code: err.code ?? 'invalid_save'}; }
}

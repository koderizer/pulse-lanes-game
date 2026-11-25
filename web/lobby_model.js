// DOM-free lobby state logic (spec section 14). Defaults, validation, and the
// apply/persist decisions live here so they are testable offline. Settings never
// enter the sim, the replay or the hash.

export const SETTING_KEYS = Object.freeze(['music_level', 'mute', 'quality', 'reduced_motion']);
export const DEFAULT_SETTINGS = Object.freeze({music_level: 8, mute: false, quality: 'high', reduced_motion: false});
export const QUALITIES = Object.freeze(['high', 'low']);
export const MUSIC_LEVEL_MIN = 0;
export const MUSIC_LEVEL_MAX = 10;

// Setting control ids exposed in the lobby (R50.3): only volume. Quality and Calm are no longer
// lobby controls (forced defaults in app.js); applySetting still accepts the full schema keys.
export const SETTING_CONTROLS = Object.freeze({
  volume: 'set-volume',
});

export function volumeOf(settings) {
  return settings.mute ? 0 : settings.music_level;
}

const isLevel = n => Number.isInteger(n) && n >= MUSIC_LEVEL_MIN && n <= MUSIC_LEVEL_MAX;

const VALIDATORS = {
  music_level: isLevel,
  mute: v => typeof v === 'boolean',
  quality: v => QUALITIES.includes(v),
  reduced_motion: v => typeof v === 'boolean',
};

export function defaultSettings() {
  return {...DEFAULT_SETTINGS};
}

// True iff `settings` is exactly the four-member PilotState v2 settings object.
export function validSettings(settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const keys = Object.keys(settings);
  return keys.length === SETTING_KEYS.length && SETTING_KEYS.every(k => keys.includes(k) && VALIDATORS[k](settings[k]));
}

// Parse the raw value of a DOM control (range gives a string, checkbox a boolean,
// select a string). Returns {ok: true, value} or {ok: false, code}.
export function parseControl(key, raw) {
  if (key === 'volume') {
    let value = raw;
    if (typeof raw === 'string' && /^(10|[0-9])$/.test(raw)) value = Number(raw);
    if (!isLevel(value)) return {ok: false, code: 'invalid_setting'};
    return {ok: true, value};
  }
  if (!Object.hasOwn(VALIDATORS, key)) return {ok: false, code: 'unknown_setting'};
  let value = raw;
  if (key === 'music_level' && typeof raw === 'string' && /^(0|[1-9][0-9]?)$/.test(raw)) value = Number(raw);
  if (!VALIDATORS[key](value)) return {ok: false, code: 'invalid_setting'};
  return {ok: true, value};
}

// A settings change. Never mutates `settings`. A valid change always asks for an
// immediate persist (before the lobby closes); an unchanged value or an invalid one does not.
export function applySetting(settings, key, raw) {
  if (key === 'volume') {
    const parsed = parseControl('volume', raw);
    if (!parsed.ok) return {ok: false, code: parsed.code, settings, persist: false};
    const v = parsed.value;
    const next = v === 0
      ? {...settings, mute: true}
      : {...settings, mute: false, music_level: v};
    if (settings.mute === next.mute && settings.music_level === next.music_level) {
      return {ok: true, settings, persist: false};
    }
    return {ok: true, settings: next, persist: true};
  }
  const parsed = parseControl(key, raw);
  if (!parsed.ok) return {ok: false, code: parsed.code, settings, persist: false};
  if (settings[key] === parsed.value) return {ok: true, settings, persist: false};
  return {ok: true, settings: {...settings, [key]: parsed.value}, persist: true};
}

// Settings as the Music and renderer should see them (presentation only).
export function presentation(settings) {
  return {
    musicLevel: settings.music_level,
    muted: settings.mute,
    lowQuality: settings.quality === 'low',
    reducedMotion: settings.reduced_motion,
  };
}

// #lobby is shown iff no run is in progress (first load, after a terminal state, after Exit).
// Never during a run, paused or not.
export function lobbyVisible({runInProgress}) {
  return !runInProgress;
}

// Retry same seed is enabled once a seed was played.
export function retryEnabled({lastSeed}) {
  return Number.isInteger(lastSeed) && lastSeed >= 0 && lastSeed <= 4294967295;
}

// Text of the "last result" line.
export function lastResultText(run) {
  if (!run) return 'No run yet.';
  const reason = {collision: 'Collision', complete: 'Complete', abandoned: 'Abandoned'}[run.terminal_reason] ?? 'Unknown';
  return `${reason} · score ${run.score} · seed ${run.seed}`;
}

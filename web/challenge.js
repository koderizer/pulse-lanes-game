// challenge.js - declarative challenge config (spec section 20 QR-1, QR-3, QR-4, ruling R33).
//
// Codec: 'PLR1:' + canonical JSON (keys sorted, no whitespace) of a closed field set. The run
// itself is never encoded, only the session preset: seed (the map is deterministic from it),
// ship model and the four lobby settings, plus the result to beat. A scanned code presets the
// lobby exactly as manual configuration would; the frozen sim plays and scores the run.
//
// Scanner: createScanOverlay builds the camera overlay (getUserMedia + BarcodeDetector, both
// platform APIs) or, when either is missing or refused, a paste-code fallback laid out as a
// mobile bottom sheet (spec 23: data-mode="paste", styled in lobby.css). Every element is
// created here; index.html is untouched. Camera frames go only to the platform detector inside
// the page: this module has no network primitive of any kind.
//
// Codec v2 (spec 22, ruling R35.6, oracle docs/pm/runs/FB3-TA6/reference_v3.mjs NOTE 12 to 14):
// the PLR1 prefix is kept; the payload field v selects the closed field set. v: 1 is the legacy
// pl-v2 preset (still decoded, still applied as a pl-v2 timed run); v: 2 is a pl-v3 preset that
// adds the session mode and the run distance dist (raw mu integer). Unknown extra fields are
// tolerated in both versions and kept in config.extra.
import {SHIP_IDS, SHIP_DEFAULT} from './ships.js';
import {formatKm, MODE_LABELS} from './hud.js';
import {MODES} from '../src/sim/space_racer_v3.js';
import {strictJson} from '../src/shared/strict_json.js';

export const PREFIX = 'PLR1:';
export const CHALLENGE_VERSION = 1; // legacy pl-v2 payload version
export const CHALLENGE_VERSION_V2 = 2; // pl-v3 payload version (spec 22)
export const CHALLENGE_VERSIONS = Object.freeze([CHALLENGE_VERSION, CHALLENGE_VERSION_V2]);
export const RULESET = 'pl-v2';
export const RULESET_V3 = 'pl-v3';
export const QUALITIES = Object.freeze(['high', 'low']);
export const MUSIC_LEVEL_MIN = 0, MUSIC_LEVEL_MAX = 10; // pilot save settings domain
export const SEED_MAX = 4294967295;
export const SCORE_MAX = 7200; // pl-v2 MAX_TICKS: a v1 score is survived ticks
export const LOOPS_MAX = 99;
export const TEXT_MAX = 2048; // longer text is never a challenge code
const TIME_RE = /^[0-9]{2,3}:[0-5][0-9]$/;

// Closed field sets per payload version. Required fields must be present; optional ones may be
// absent. The section 20 fields are shared; v2 swaps the ruleset, adds mode and dist, and lifts
// the score cap (a pl-v3 score is the distance, a safe integer >= 0).
const isUint32 = v => Number.isInteger(v) && v >= 0 && v <= SEED_MAX;
const isBool = v => typeof v === 'boolean';
const isDistance = v => Number.isSafeInteger(v) && v >= 0;
const COMMON = {
  seed: {required: true, ok: isUint32},
  ship: {required: true, ok: v => typeof v === 'string' && v.length > 0 && v.length <= 32},
  music_level: {required: true, ok: v => Number.isInteger(v) && v >= MUSIC_LEVEL_MIN && v <= MUSIC_LEVEL_MAX},
  mute: {required: true, ok: isBool},
  quality: {required: true, ok: v => QUALITIES.includes(v)},
  reduced_motion: {required: true, ok: isBool},
  loops: {required: false, ok: v => Number.isInteger(v) && v >= 0 && v <= LOOPS_MAX},
  time: {required: false, ok: v => typeof v === 'string' && TIME_RE.test(v)},
};
export const FIELDS = Object.freeze({
  v: {required: true, ok: v => v === CHALLENGE_VERSION},
  ruleset: {required: true, ok: v => v === RULESET},
  ...COMMON,
  score: {required: false, ok: v => Number.isInteger(v) && v >= 0 && v <= SCORE_MAX},
});
export const FIELDS_V2 = Object.freeze({
  v: {required: true, ok: v => v === CHALLENGE_VERSION_V2},
  ruleset: {required: true, ok: v => v === RULESET_V3},
  ...COMMON,
  mode: {required: true, ok: v => MODES.includes(v)},
  dist: {required: true, ok: isDistance},
  score: {required: false, ok: isDistance},
});
export const FIELDS_BY_VERSION = Object.freeze({[CHALLENGE_VERSION]: FIELDS, [CHALLENGE_VERSION_V2]: FIELDS_V2});
export const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));
export const FIELD_NAMES_V2 = Object.freeze(Object.keys(FIELDS_V2));
// The field set of a payload version, or null for any version this build does not know.
const fieldsOf = v => (CHALLENGE_VERSIONS.includes(v) ? FIELDS_BY_VERSION[v] : null);
const isPlain = o => o !== null && typeof o === 'object' && !Array.isArray(o);
// Own data property even for a key such as "__proto__" (forward fields are arbitrary names).
const put = (obj, k, v) => Object.defineProperty(obj, k, {value: v, enumerable: true, writable: true, configurable: true});

// Canonical JSON: object keys sorted (code unit order), no whitespace, recursively.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlain(value)) {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('non-finite number');
  return JSON.stringify(value);
}

// Validate one object against a closed field set; returns a list of error codes (empty when valid).
function fieldErrors(obj, fields) {
  const errors = [];
  for (const [name, f] of Object.entries(fields)) {
    if (!Object.hasOwn(obj, name) || obj[name] === undefined) { if (f.required) errors.push(`missing_${name}`); continue; }
    if (!f.ok(obj[name])) errors.push(`invalid_${name}`);
  }
  return errors;
}

// v1 data: {seed, ship, music_level, mute, quality, reduced_motion, loops?, time?, score?, extra?}.
// v2 data: the same plus {mode, dist} (spec 22). The version follows data.v, else the ruleset
// ('pl-v3' gives v: 2), else v: 1; the ruleset then defaults to the one of that version. `extra`
// (plain object) carries forward fields that the version does not know; they are emitted too, so
// a decoded code re-encodes losslessly. Output is canonical JSON (keys sorted, no whitespace).
// Throws RangeError on invalid data (callers that must not throw catch it).
export function encodeChallenge(data) {
  if (!isPlain(data)) throw new RangeError('challenge data must be an object');
  const v = data.v ?? (data.ruleset === RULESET_V3 ? CHALLENGE_VERSION_V2 : CHALLENGE_VERSION);
  const fields = fieldsOf(v);
  if (!fields) throw new RangeError('invalid challenge: unknown_version');
  const out = {};
  if (isPlain(data.extra)) for (const [k, x] of Object.entries(data.extra)) if (!Object.hasOwn(fields, k)) put(out, k, x);
  for (const name of Object.keys(fields)) if (data[name] !== undefined && data[name] !== null) out[name] = data[name];
  out.v = v;
  out.ruleset ??= v === CHALLENGE_VERSION_V2 ? RULESET_V3 : RULESET;
  const errors = fieldErrors(out, fields);
  if (errors.length) throw new RangeError(`invalid challenge: ${errors.join(', ')}`);
  return PREFIX + canonicalJson(out);
}

// -> {ok, config, errors, warnings}. config holds the closed-set fields of its version that are
// present, the ship already resolved against the registry, and `extra` with every unknown field
// preserved. Error contract (frozen pins, NOTE 14): not_text, too_long, no_prefix, invalid_json,
// duplicate_key, not_object, missing_v, unknown_version, then missing_<field> / invalid_<field>.
export function decodeChallenge(text) {
  const fail = (...errors) => ({ok: false, config: null, errors, warnings: []});
  if (typeof text !== 'string') return fail('not_text');
  if (text.length > TEXT_MAX) return fail('too_long');
  if (!text.startsWith(PREFIX)) return fail('no_prefix');
  let obj;
  try { obj = strictJson(text.slice(PREFIX.length)); } catch (err) { return fail(err?.code === 'duplicate_key' ? 'duplicate_key' : 'invalid_json'); }
  if (!isPlain(obj)) return fail('not_object');
  if (!Object.hasOwn(obj, 'v')) return fail('missing_v');
  const fields = fieldsOf(obj.v);
  if (!fields) return fail('unknown_version');
  const errors = fieldErrors(obj, fields);
  if (errors.length) return fail(...errors);
  const warnings = [];
  const config = {};
  for (const name of Object.keys(fields)) if (Object.hasOwn(obj, name)) config[name] = obj[name];
  if (!SHIP_IDS.includes(config.ship)) {
    warnings.push(`unknown_ship ${config.ship}: using ${SHIP_DEFAULT}`);
    config.ship_requested = config.ship;
    config.ship = SHIP_DEFAULT;
  }
  config.extra = {};
  for (const k of Object.keys(obj)) if (!Object.hasOwn(fields, k)) put(config.extra, k, obj[k]);
  return {ok: true, config, errors: [], warnings};
}

// The closed-set data of a decoded config, ready for encodeChallenge (the requested ship id,
// when the registry did not know it, goes back out unchanged).
export function configData(config) {
  const data = {};
  for (const name of Object.keys(fieldsOf(config.v) ?? FIELDS)) if (config[name] !== undefined) data[name] = config[name];
  if (config.ship_requested !== undefined) data.ship = config.ship_requested;
  if (isPlain(config.extra) && Object.keys(config.extra).length) {
    data.extra = {};
    for (const k of Object.keys(config.extra)) put(data.extra, k, config.extra[k]);
  }
  return data;
}

export function bannerText(config) {
  if (config?.v === CHALLENGE_VERSION_V2 && Number.isSafeInteger(config.dist)) {
    return `BEAT ${formatKm(config.dist)} KM - ${MODE_LABELS[config.mode] ?? config.mode} - SEED ${config.seed}`;
  }
  return Number.isInteger(config?.score) ? `BEAT ${config.score} - SEED ${config.seed}` : `CHALLENGE - SEED ${config?.seed}`;
}

// QR-4 and spec 22 scan apply: a decoded config goes through the same lobby paths as manual
// configuration, then the run starts directly (owner: 'jump immediately'). `lobby` is the client
// loop's port: changeSetting(key, value) (the lobby setting path, which persists and drives the
// music and renderer setters), chooseShip(id) (pl-ship + setShip), setSeed(seed) (the seed the
// next run starts), setMode(mode) (the lobby mode, v2 only), setChallenge({...}) (the banner and
// the ruleset the challenge seed is played with: a legacy v1 code stays a pl-v2 timed run,
// R35.6) and play() (start the preset session now). setMode and play are optional hooks.
export function applyChallenge(config, lobby) {
  const v2 = config.v === CHALLENGE_VERSION_V2;
  lobby.changeSetting('music_level', config.music_level);
  lobby.changeSetting('mute', config.mute);
  lobby.changeSetting('quality', config.quality);
  lobby.changeSetting('reduced_motion', config.reduced_motion);
  lobby.chooseShip(config.ship);
  if (v2) lobby.setMode?.(config.mode);
  lobby.setSeed(config.seed);
  lobby.setChallenge({score: config.score ?? null, seed: config.seed, text: bannerText(config),
    ruleset: v2 ? RULESET_V3 : RULESET, mode: v2 ? config.mode : null, dist: v2 ? config.dist : null});
  lobby.play?.();
}

// ------------------------------------------------------------------ scan overlay (QR-3)
const MSG = {
  start: 'Starting camera...',
  aim: 'Point the camera at a challenge card QR.',
  noDetector: 'This browser cannot scan QR codes. Paste a challenge code instead.',
  noCamera: 'Camera unavailable. Paste a challenge code instead.',
  paste: 'Paste a challenge code (starts with PLR1:).',
  bad: 'Not a challenge code',
};

// deps: document, navigator, BarcodeDetector (constructor or undefined), requestFrame /
// cancelFrame (animation frame functions), onApply(config, result) when a valid code was read,
// onClose(). Returns {open, close, isOpen, state}. `state()` reports for probes and tests.
export function createScanOverlay({document: doc = globalThis.document, navigator: nav = globalThis.navigator,
  BarcodeDetector: Detector = globalThis.BarcodeDetector, requestFrame = globalThis.requestAnimationFrame,
  cancelFrame = globalThis.cancelAnimationFrame, onApply = () => {}, onClose = () => {}} = {}) {
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let dialog = null, video = null, status = null, body = null, pasteBox = null, textarea = null;
  let stream = null, detector = null, frame = null, busy = false, opened = false, session = 0, lastBad = null;
  let mode = 'closed';

  const setStatus = (message, kind = '') => {
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
  };
  function stopCamera() {
    if (frame !== null) { try { cancelFrame?.(frame); } catch { /* frame already gone */ } frame = null; }
    if (stream) { for (const t of stream.getTracks?.() ?? []) { try { t.stop(); } catch { /* already stopped */ } } stream = null; }
    if (video) { try { video.pause?.(); } catch { /* not playing */ } video.srcObject = null; video.hidden = true; }
    detector = null; busy = false;
  }

  function handleText(raw) {
    const text = typeof raw === 'string' ? raw.trim() : raw;
    const result = decodeChallenge(text);
    if (!result.ok) {
      setStatus(`${MSG.bad}: ${result.errors[0]}.`, 'error');
      return result;
    }
    close();
    onApply(result.config, result);
    return result;
  }

  // Spec 23 bottom sheet (layout only): while the soft keyboard is up the visual viewport is
  // shorter than the layout viewport; the sheet is lifted by that inset (--kb) and capped to the
  // visible height (--vvh), so the status line, the code and the Apply / Close row stay on screen.
  let viewport = null;
  function fitSheet() {
    if (!dialog || !viewport) return;
    const win = doc.defaultView ?? globalThis;
    const inner = Number(win.innerHeight) || viewport.height;
    const kb = Math.max(0, Math.round(inner - viewport.height - (viewport.offsetTop || 0)));
    dialog.style?.setProperty?.('--kb', `${kb}px`);
    dialog.style?.setProperty?.('--vvh', `${Math.round(viewport.height)}px`);
  }
  function watchViewport() {
    if (viewport) return;
    viewport = doc.defaultView?.visualViewport ?? null;
    if (!viewport) return;
    viewport.addEventListener?.('resize', fitSheet);
    viewport.addEventListener?.('scroll', fitSheet);
    fitSheet();
  }
  function unwatchViewport() {
    if (!viewport) return;
    viewport.removeEventListener?.('resize', fitSheet);
    viewport.removeEventListener?.('scroll', fitSheet);
    viewport = null;
  }

  function showPaste(message) {
    stopCamera();
    mode = 'paste';
    if (dialog) dialog.dataset.mode = 'paste';
    setStatus(message, 'info');
    watchViewport();
    if (pasteBox) { pasteBox.hidden = false; textarea.focus?.(); return; }
    pasteBox = el('div', 'scan-paste');
    textarea = el('textarea', 'scan-code');
    textarea.rows = 4;
    textarea.spellcheck = false;
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('aria-label', 'Challenge code');
    textarea.placeholder = 'PLR1:{...}';
    textarea.addEventListener('focus', () => fitSheet());
    const actions = el('div', 'scan-actions');
    const apply = el('button', 'primary scan-apply', 'Apply');
    apply.type = 'button';
    apply.addEventListener('click', () => handleText(textarea.value));
    const dismiss = el('button', 'scan-sheet-close', 'Close');
    dismiss.type = 'button';
    dismiss.addEventListener('click', () => close());
    actions.append(apply, dismiss);
    pasteBox.append(textarea, actions);
    body.append(pasteBox);
    textarea.focus?.();
  }

  function scanLoop(id) {
    if (!opened || id !== session || !detector) return;
    frame = requestFrame(() => {
      frame = null;
      if (!opened || id !== session || !detector) return;
      if (!busy && (video.readyState ?? 0) >= 2) {
        busy = true;
        Promise.resolve().then(() => detector.detect(video)).then(codes => {
          busy = false;
          if (!opened || id !== session) return;
          for (const code of codes ?? []) {
            const text = code?.rawValue;
            if (typeof text !== 'string' || text === lastBad) continue;
            const r = handleText(text);
            if (r.ok) return;
            lastBad = text;
          }
          scanLoop(id);
        }, () => { busy = false; scanLoop(id); });
        return;
      }
      scanLoop(id);
    });
  }

  async function startCamera(id) {
    if (typeof Detector !== 'function') return showPaste(MSG.noDetector);
    if (typeof nav?.mediaDevices?.getUserMedia !== 'function') return showPaste(MSG.noCamera);
    try { detector = new Detector({formats: ['qr_code']}); } catch { detector = null; return showPaste(MSG.noDetector); }
    let s;
    try { s = await nav.mediaDevices.getUserMedia({video: {facingMode: 'environment'}, audio: false}); } catch { return showPaste(MSG.noCamera); }
    if (!opened || id !== session || mode !== 'camera') { for (const t of s?.getTracks?.() ?? []) t.stop(); return; }
    stream = s;
    video.srcObject = s;
    video.hidden = false;
    try { await video.play?.(); } catch { /* autoplay refused: frames still arrive for muted inline video */ }
    if (!opened || id !== session) return stopCamera();
    setStatus(MSG.aim, 'info');
    scanLoop(id);
  }

  function build() {
    dialog = el('dialog', 'scan');
    dialog.dataset.mode = 'camera';
    dialog.setAttribute('aria-label', 'Scan challenge');
    const head = el('div', 'scan-head');
    head.append(el('h2', 'scan-title', 'Scan challenge'));
    const closeButton = el('button', 'icon scan-close', 'Close');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close scanner');
    closeButton.addEventListener('click', () => close());
    head.append(closeButton);
    body = el('div', 'scan-body');
    video = el('video', 'scan-video');
    video.muted = true; video.autoplay = true; video.playsInline = true;
    video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
    video.hidden = true;
    status = el('p', 'scan-status');
    status.setAttribute('role', 'status');
    const pasteToggle = el('button', 'scan-paste-toggle', 'Paste code');
    pasteToggle.type = 'button';
    pasteToggle.addEventListener('click', () => showPaste(MSG.paste));
    body.append(video, status, pasteToggle);
    dialog.append(head, body);
    // Escape (cancel) and any close of the dialog both stop the camera.
    dialog.addEventListener('cancel', event => { event.preventDefault?.(); close(); });
    dialog.addEventListener('close', () => { if (opened) close(); });
    doc.body.append(dialog);
  }

  function open() {
    if (opened) return;
    opened = true; session++; lastBad = null; mode = 'camera';
    pasteBox = null; textarea = null;
    build();
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    setStatus(MSG.start, 'info');
    startCamera(session);
  }

  function close() {
    if (!opened) return;
    opened = false; session++; mode = 'closed';
    stopCamera();
    unwatchViewport();
    const d = dialog;
    dialog = null;
    if (d) {
      try { if (d.open) d.close(); } catch { /* attribute fallback below */ }
      d.removeAttribute?.('open');
      d.remove?.();
    }
    onClose();
  }

  return {open, close, isOpen: () => opened, handleText,
    state: () => ({open: opened, mode, status: status?.textContent ?? '', statusKind: status?.dataset?.kind ?? '',
      streaming: Boolean(stream), dialog, video, textarea, pasteBox})};
}

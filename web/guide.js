import {guideTrack} from './analytics.js';
import {matchGuide, WHY_YES, WHY_NO, GUIDE_ENTRIES, GUIDE_FAQ} from './guide_data.js';

// Dedicated 2D viewport. A still moon needs no rAF, including under reduced motion.
// The moon is the IDLE view only; answers and the why-loop render in its place (R62 owner law).
function createViewport(doc, host, fallback) {
  let canvas = null;
  return {
    render(descriptor) {
      if (!canvas) {
        canvas = doc.createElement('canvas');
        canvas.width = 240; canvas.height = 240;
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', 'Nix moon');
        host.append(canvas);
      }
      fallback.textContent = descriptor.preset === 'idle' ? 'Nix moon' : (descriptor.text || 'Nix moon');
      const ctx = canvas.getContext('2d');
      canvas.hidden = !ctx;
      if (!ctx) return;
      ctx.fillStyle = '#091421'; ctx.fillRect(0, 0, 240, 240);
      ctx.fillStyle = '#c4d9dd'; ctx.beginPath(); ctx.arc(120, 120, 76, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#829ba8';
      for (const [x, y, r] of [[91, 91, 16], [145, 138, 23], [95, 156, 10], [152, 79, 9]]) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    },
    dispose() { canvas?.remove(); canvas = null; },
  };
}

export function createGuide({document: doc = globalThis.document, track = guideTrack, random = Math.random} = {}) {
  const el = (tag, id, text) => {
    const node = doc.createElement(tag); if (id) node.id = id;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (id, text) => { const node = el('button', id, text); node.type = 'button'; return node; };
  const dialog = el('dialog', 'nix-guide'); dialog.className = 'nix-guide';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'nix-guide-title');

  // R62 chat layout: header (title, book menu, close) / viewport / FAQ pills / chat bar at bottom.
  const head = el('div', 'guide-head');
  const title = el('h2', 'nix-guide-title', 'Nix Guide');
  const menuButton = button('guide-menu', ''); menuButton.setAttribute('aria-label', 'Read all topics');
  menuButton.textContent = '☰'; // glyph stand-in; SVG added only when innerHTML exists (shim-safe)
  try { menuButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 5a2 2 0 0 1 2-2h11v16H7a2 2 0 0 0-2 2z"></path><path d="M9 3v14"></path></svg>'; } catch { /* shim: keep glyph */ }
  const closeButton = button('guide-close', 'Close');
  head.append(title, menuButton, closeButton);
  const sub = el('p', 'guide-sub', "A navigator's book for the lanes.");
  // R65: build stamp INSIDE the header - a stuck-open modal is exactly when the field needs to
  // read the build, and the dialog backdrop hides any page-level tag (top layer covers it).
  const build = el('span', 'guide-build'); build.setAttribute('aria-hidden', 'true');
  sub.append(build);

  const viewport = el('div', 'guide-viewport');
  const stage = el('div', 'guide-stage'), fallback = el('p', 'guide-fallback');
  stage.append(fallback);
  const answer = el('div', 'guide-answer'); answer.setAttribute('aria-live', 'polite'); answer.hidden = true;
  const resultTitle = el('h3', 'guide-result-title'), body = el('p', 'guide-result-body');
  const number = el('div', 'guide-number'), prompt = el('p', 'guide-prompt', 'Do you want to know why?');
  const choices = el('div', 'guide-choices');
  const yes = button('guide-yes', 'Yes'), no = button('guide-no', 'No');
  choices.append(yes, no);
  // Answers and the why-loop render IN the viewport, where the moon was (owner R62).
  answer.append(resultTitle, body, number, prompt, choices);
  viewport.append(stage, answer);

  const faq = el('div', 'guide-faq'); faq.setAttribute('aria-label', 'Frequently asked questions');
  for (const topic of GUIDE_FAQ) {
    const entry = GUIDE_ENTRIES.find(item => item.title === topic);
    if (!entry) continue;
    const pill = button('', entry.title); pill.className = 'faq-pill';
    pill.addEventListener('click', () => { showEntry(entry); track('guide_faq_tap', {faq: true}); });
    faq.append(pill);
  }

  // Chat field: the bar IS the visual input box; Ask sits inside it at the right (owner R62b).
  const bar = el('div', 'guide-bar');
  const input = el('textarea', 'guide-question'); // long questions (owner R62)
  input.rows = 1; input.placeholder = 'Ask about the lanes...';
  input.setAttribute('aria-label', 'Ask the Nix Guide');
  input.addEventListener('input', () => { const h = input.scrollHeight; if (h) { input.style.height = 'auto'; input.style.height = Math.min(h, 96) + 'px'; } });
  const submit = button('guide-submit', 'Ask'); submit.setAttribute('aria-label', 'Ask');
  try { submit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 21l18-9L3 3v7l12 2-12 2z"></path></svg>'; } catch { /* shim: keep the Ask label */ }
  bar.append(input, submit);

  const menuPanel = el('div', 'guide-menu-panel'); menuPanel.hidden = true;
  dialog.append(head, sub, viewport, faq, bar, menuPanel);
  doc.body.append(dialog);
  const viewportApi = createViewport(doc, stage, fallback);

  // R63 keyboard fit: detect the soft keyboard by BASELINE shrink (iOS also SCROLLS the layout
  // viewport, so innerHeight-minus-offsetTop math misses it - never subtract offsetTop here),
  // then reflow the dialog INSIDE the visual viewport: top = offsetTop + 8, height = vv.height - 16.
  const view = doc.defaultView, vv = view?.visualViewport;
  let baseH = 0;
  function keyboardReset() {
    dialog.classList.remove('kb-open');
    if (!dialog.style) return;
    for (const k of ['insetBlockStart', 'insetBlockEnd', 'height', 'maxHeight']) dialog.style[k] = '';
  }
  function keyboardFit() {
    if (!dialog.open || !vv) return;
    if (!(baseH > 0) || vv.height > baseH) baseH = vv.height; // largest keyboard-free height seen
    if (baseH - vv.height > 140) {
      dialog.classList.add('kb-open');
      dialog.style.insetBlockStart = ((vv.offsetTop || 0) + 8) + 'px';
      dialog.style.insetBlockEnd = 'auto';
      dialog.style.height = Math.max(180, vv.height - 16) + 'px'; // fit wins over any floor (R63)
      dialog.style.maxHeight = 'none';
    } else keyboardReset();
  }
  if (vv?.addEventListener) { vv.addEventListener('resize', keyboardFit); vv.addEventListener('scroll', keyboardFit); }

  let depth = 0, looping = false, opener = null, lastClosedAt = 0, menuOpen = false;
  function exitLoop() { looping = false; prompt.hidden = true; choices.hidden = true; }
  function reset() {
    exitLoop(); depth = 0; number.hidden = true;
    resultTitle.textContent = ''; body.textContent = ''; input.value = '';
    if (input.style) input.style.height = '';
    answer.hidden = true; stage.hidden = false; menuPanel.hidden = true; menuOpen = false;
  }
  function showNumber(value) {
    stage.hidden = true; answer.hidden = false;
    number.hidden = false; number.textContent = String(value);
    prompt.hidden = false; choices.hidden = false;
    track('guide_why_loop', {depth});
  }
  function advance() { if (looping) { depth++; showNumber(Math.floor(random() * 1000)); } }
  function showEntry(entry) { // in-viewport answer, used by ask/match, FAQ pills and the book menu
    exitLoop(); stage.hidden = true; answer.hidden = false; number.hidden = true;
    resultTitle.textContent = entry?.title ?? ''; body.textContent = entry?.body ?? '';
  }
  function ask() {
    const question = input.value.trim().toLowerCase(); input.value = '';
    if (input.style) input.style.height = '';
    if (!question) return;
    if (looping && WHY_YES.includes(question)) { advance(); return; }
    if (looping && WHY_NO.includes(question)) { exitLoop(); return; }
    exitLoop();
    const match = matchGuide(question);
    track('guide_question', match ? {match: true} : {noMatch: true});
    number.hidden = true;
    if (match) showEntry(match);
    else { looping = true; depth = 1; track('guide_no_match', {}); showNumber(42); }
  }
  function buildMenu() {
    menuPanel.replaceChildren?.();
    let group = null;
    for (const entry of GUIDE_ENTRIES) {
      if (entry.group !== group) { group = entry.group; const g = el('div'); g.className = 'guide-menu-group'; g.textContent = group; menuPanel.append(g); }
      const item = button('', entry.title); item.className = 'guide-menu-item';
      item.addEventListener('click', () => { showEntry(entry); closeMenu(); input.focus(); });
      menuPanel.append(item);
    }
  }
  function openMenu() {
    if (menuOpen) return;
    menuOpen = true; menuPanel.hidden = false; buildMenu();
    track('guide_menu_opened', {});
    (menuPanel.querySelector?.('.guide-menu-item') || menuPanel.children[0])?.focus?.();
  }
  function closeMenu() { menuOpen = false; menuPanel.hidden = true; menuButton.focus?.(); }
  function cleanup() { viewportApi.dispose(); exitLoop(); menuOpen = false; keyboardReset(); opener?.focus?.(); opener = null; }
  function close() {
    pendingOpen = 0; trustedOpen = 0;
    if (!dialog.open) return;
    dialog.close(); cleanup();
    // Chrome fires the browser-level Escape close on the NEXT topmost modal after this one
    // closes, so game over gets a cancel in the same press. gameover.js consults this window.
    lastClosedAt = Date.now();
  }
  function note(label, outcome, source) {
    try {
      const trail = (globalThis.__guideOpens ??= []);
      trail.push({ t: Date.now(), label, outcome, source: source?.id || String(source?.className || source || ''),
        running: !!doc.body?.classList?.contains('running'), dialogOpen: dialog.open,
        stack: (new Error()).stack?.split('\n').slice(2, 5).join(' | ') });
      if (trail.length > 25) trail.shift();
      const dbg = doc.getElementById('dbg');
      if (dbg) dbg.textContent += `\nguide-open ${label}:${outcome} from ${source?.id || '?'} running=${doc.body?.classList?.contains('running')}`;
    } catch { /* telemetry must never block the guide */ }
  }
  let openToken = 0, pendingOpen = 0, trustedOpen = 0;
  function inspectOpen(records) {
    // oldValue + the next record preserve close/reopen transitions batched in one task.
    for (let i = 0; i < records.length; i++) {
      const value = i + 1 < records.length ? records[i + 1].oldValue : dialog.getAttribute('open');
      if (value === null) { trustedOpen = 0; pendingOpen = 0; }
      else if (records[i].oldValue === null) { trustedOpen = pendingOpen; pendingOpen = 0; }
    }
    if (dialog.open && (!trustedOpen || doc.body?.classList?.contains('running'))) {
      note('watchdog', 'forced-close', dialog);
      close();
    }
  }
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const watchdog = typeof Observer === 'function' ? new Observer(inspectOpen) : null;
  watchdog?.observe(dialog, {attributes: true, attributeFilter: ['open'], attributeOldValue: true});
  function keydown(event) {
    if (!dialog.open) return;
    if (event.key === 'Escape') {
      if (menuOpen) { event.preventDefault(); event.stopPropagation(); closeMenu(); return; } // menu first
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); close();
    } else if (event.key === 'Tab') {
      const stops = menuOpen
        ? [...(menuPanel.querySelectorAll?.('.guide-menu-item') || menuPanel.children), menuButton]
        : [input, submit, ...(looping ? [yes, no] : []), closeButton, menuButton];
      const i = stops.indexOf(doc.activeElement);
      event.preventDefault(); stops[(i + (event.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
    } else if (event.key === 'Enter' && event.target === input && !event.shiftKey) { event.preventDefault(); ask(); }
  }
  // Capture prevents the same Escape from reaching any underlying dialog handlers.
  doc.addEventListener('keydown', keydown, true);
  // R65: iOS can drop the visualViewport resize when the keyboard dies, leaving the dialog
  // anchored mid-screen with Close out of reach. Re-check on any window-level reshuffle.
  const rescue = () => { if (dialog.open && dialog.classList.contains('kb-open')) keyboardFit(); };
  for (const ev of ['resize', 'orientationchange', 'focus', 'blur']) globalThis.addEventListener?.(ev, rescue);
  if (globalThis.visualViewport) globalThis.visualViewport.addEventListener('scroll', rescue);
  dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); if (menuOpen) { closeMenu(); return; } close(); });
  dialog.addEventListener('close', () => { if (!dialog.open) cleanup(); });
  // R65: tap outside the panel (backdrop) closes - iOS users have no Escape key and a modal
  // must always have a touch escape.
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  submit.addEventListener('click', ask); yes.addEventListener('click', advance);
  no.addEventListener('click', () => { exitLoop(); input.focus(); });
  closeButton.addEventListener('click', close); menuButton.addEventListener('click', openMenu);
  return {
    justClosedWithin: (ms) => Date.now() - lastClosedAt < ms,
    open(source = doc.activeElement, label = 'gameover') {
      // R64: full open trail (spec 26.7.10) - every attempt records its origin and state, so a
      // modal seen over gameplay on a remote device is diagnosable from one screenshot.
      if (watchdog) inspectOpen(watchdog.takeRecords());
      if (dialog.open) { note(label, 'blocked-already-open', source); return; }
      if (doc.body?.classList?.contains('running')) { note(label, 'blocked-running', source); return; } // R63: never over live gameplay
      opener = source; reset(); baseH = 0;
      try {
        // One-use permission for the next closed -> open mutation, never a sticky flag.
        pendingOpen = ++openToken;
        dialog.showModal();
        if (watchdog) inspectOpen(watchdog.takeRecords());
        viewportApi.render({preset: 'idle', assetId: null, text: 'Nix moon'});
      } catch (error) { close(); note(label, 'failed', source); throw error; }
      note(label, 'opened', source);
      input.focus(); keyboardFit(); track('guide_opened', {source: label}); // R61: lobby opener reports 'lobby'
    },
    close,
  };
}

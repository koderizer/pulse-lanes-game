import {guideTrack} from './analytics.js';
import {matchGuide, WHY_YES, WHY_NO} from './guide_data.js';

// Dedicated 2D viewport. A still moon needs no rAF, including under reduced motion.
// Unimplemented descriptors retain their text in the fallback slot for the next slice.
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
  const title = el('h2', 'nix-guide-title', 'Nix Guide');
  const host = el('div', 'guide-viewport'), fallback = el('p', 'guide-fallback');
  const label = el('label', '', 'Ask about the lanes.'); label.setAttribute('for', 'guide-question');
  const input = el('input', 'guide-question'); input.type = 'text'; input.placeholder = 'Ask about the lanes.';
  const submit = button('guide-submit', 'Ask');
  const result = el('div', 'guide-result'); result.setAttribute('aria-live', 'polite');
  const resultTitle = el('h3', 'guide-result-title'), body = el('p', 'guide-result-body');
  const number = el('div', 'guide-number'), prompt = el('p', 'guide-prompt', 'Do you want to know why?');
  const choices = el('div', 'guide-choices');
  const yes = button('guide-yes', 'Yes'), no = button('guide-no', 'No'), closeButton = button('guide-close', 'Close');
  choices.append(yes, no); result.append(resultTitle, body, number, prompt, choices);
  dialog.append(title, el('p', '', "A navigator's book for the lanes."), host, fallback, label, input, submit, result, closeButton);
  doc.body.append(dialog);
  const viewport = createViewport(doc, host, fallback);
  let depth = 0, looping = false, opener = null, lastClosedAt = 0;
  function exitLoop() { looping = false; prompt.hidden = true; choices.hidden = true; }
  function reset() {
    exitLoop(); depth = 0; number.hidden = true; resultTitle.textContent = ''; body.textContent = ''; input.value = '';
  }
  function showNumber(value) {
    number.hidden = false; number.textContent = String(value);
    prompt.hidden = false; choices.hidden = false;
    viewport.render({preset: 'number', assetId: null, text: String(value)});
    track('guide_why_loop', {depth});
  }
  function advance() { if (looping) { depth++; showNumber(Math.floor(random() * 1000)); } }
  function ask() {
    const question = input.value.trim().toLowerCase(); input.value = '';
    if (!question) return;
    if (looping && WHY_YES.includes(question)) { advance(); return; }
    if (looping && WHY_NO.includes(question)) { exitLoop(); return; }
    exitLoop();
    const match = matchGuide(question);
    track('guide_question', match ? {match: true} : {noMatch: true});
    resultTitle.textContent = match?.title ?? ''; body.textContent = match?.body ?? '';
    number.hidden = true;
    if (match) viewport.render(match.render);
    else { looping = true; depth = 1; track('guide_no_match', {}); showNumber(42); }
  }
  function cleanup() { viewport.dispose(); exitLoop(); opener?.focus?.(); opener = null; }
  function close() {
    if (!dialog.open) return;
    dialog.close(); cleanup();
    // Chrome fires the browser-level Escape close on the NEXT topmost modal after this one
    // closes, so game over gets a cancel in the same press. gameover.js consults this window.
    lastClosedAt = Date.now();
  }
  function keydown(event) {
    if (!dialog.open) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); close();
    } else if (event.key === 'Tab') {
      const stops = [input, submit, ...(looping ? [yes, no] : []), closeButton];
      const i = stops.indexOf(doc.activeElement);
      event.preventDefault(); stops[(i + (event.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
    } else if (event.key === 'Enter' && event.target === input) { event.preventDefault(); ask(); }
  }
  // Capture prevents the same Escape from reaching any underlying dialog handlers.
  doc.addEventListener('keydown', keydown, true);
  dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); close(); });
  dialog.addEventListener('close', () => { if (!dialog.open) cleanup(); });
  submit.addEventListener('click', ask); yes.addEventListener('click', advance);
  no.addEventListener('click', () => { exitLoop(); input.focus(); }); closeButton.addEventListener('click', close);
  return {
    justClosedWithin: (ms) => Date.now() - lastClosedAt < ms,
    open(source = doc.activeElement) {
      if (dialog.open) return;
      opener = source; reset(); dialog.showModal();
      viewport.render({preset: 'idle', assetId: null, text: 'Nix moon'});
      input.focus(); track('guide_opened', {source: 'gameover'});
    },
    close,
  };
}

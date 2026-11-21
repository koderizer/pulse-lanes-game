// Pause overlay controller (spec section 14). Pause comes from #hud-pause, Escape,
// or the tab becoming hidden. The overlay offers Resume and Exit only. This module
// only reports intent through callbacks; the client loop owns the sim and does the
// stepping, recording and lobby switching.

export function createPause({document: doc = globalThis.document, onPause, onResume, onExit}) {
  const overlay = doc.getElementById('pause-overlay');
  let paused = false;
  let active = false; // a run is in progress

  const show = on => { overlay.hidden = !on; };
  const pause = () => {
    if (!active || paused) return;
    paused = true; show(true); onPause?.();
    doc.getElementById('pause-resume')?.focus?.();
  };
  const resume = () => {
    if (!paused) return;
    paused = false; show(false); onResume?.();
  };
  const exit = () => {
    if (!active) return;
    paused = false; active = false; show(false); onExit?.();
  };

  const onKey = event => {
    if (event.key !== 'Escape' || event.repeat) return;
    if (paused) resume(); else pause();
  };
  const onVisibility = () => { if (doc.hidden) pause(); }; // never auto-resumes (not a trusted gesture)
  const hudPause = doc.getElementById('hud-pause');
  const resumeButton = doc.getElementById('pause-resume');
  const exitButton = doc.getElementById('pause-exit');

  hudPause?.addEventListener('click', pause);
  resumeButton?.addEventListener('click', resume);
  exitButton?.addEventListener('click', exit);
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('visibilitychange', onVisibility);
  show(false);

  return {
    // Call when a run begins / ends so Escape and visibility only act during a run.
    runStarted() { active = true; paused = false; show(false); },
    runEnded() { active = false; paused = false; show(false); },
    isPaused: () => paused,
    pause, resume, exit,
    dispose() {
      hudPause?.removeEventListener('click', pause);
      resumeButton?.removeEventListener('click', resume);
      exitButton?.removeEventListener('click', exit);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

// Spec section 16: cache name follows the release build_id (pl-web-0.2.0). A presentation-only
// fix of the same build appends -fbN. W4/W5 append their render and loop modules to ASSETS
// when those files exist (cache.addAll fails the whole install on a single 404).
// FB3-W4c R-3 (ruling R29, closes queued W5): -fb3 key; render.js, render2d.js and sfx.js precached.
// FB3-ACH R-5 (ruling R31, spec 18 GO-5): -fb4 key; gameover.js precached.
// FB3-WEB11 (ruling R47): -fb26 key; song.js and songs/manifest.js precached. No audio file is ever
// precached or cached at runtime; song files and Range requests bypass this worker.
const CACHE = 'pulse-lanes-pl-web-0.2.0-fb47';
const ASSETS = ['./', './index.html', './lobby.css', './app.js', './digest.js', './music.js', './score_voice.js',
  './lobby_model.js', './hud.js', './pause.js', './render.js', './render2d.js', './sfx.js', './gameover.js',
  './guide.js', './guide_data.js', './guide.css', './analytics.js',
  './ships.js', './ship_stats.js', './qr.js',, './challenge.js', './song.js', './songs/manifest.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-maskable.svg', './icons/icon-192.png',
  './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon-180.png',
  '../src/sim/space_racer.js', '../src/sim/space_racer_v3.js', '../src/input/controls.js',
  '../src/sim/pulse_lanes.js', '../src/state/pilot_state.js', '../src/shared/strict_json.js',
  '../release/supported_builds.json'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('pulse-lanes-') && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.headers.has('range') || (url.pathname.includes('/songs/') && !url.pathname.endsWith('/songs/manifest.js'))) return;
  // Only static delivery uses the network; cached play has no remote dependency.
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request))); // static assets, localhost
});

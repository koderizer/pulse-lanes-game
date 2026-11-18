const CACHE = 'pulse-lanes-pl-web-0.1.0-fb1';
const ASSETS = ['./', './index.html', './style.css', './app.js', './digest.js', './music.js',
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
  // Only static delivery uses the network; cached play has no remote dependency.
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request))); // static assets, localhost
});

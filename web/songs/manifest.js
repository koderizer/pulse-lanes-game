// Bundled songs (R46.2.2, R46.2.3). Owner-picked and attested (docs/pm/runs/FB3-WEB10/
// songs-decision.md, 2026-11-25). Only CC0-1.0 or CC-BY-4.0 music may live in this folder
// (GitHub Pages publishes everything in web/). A non-free song goes through the lobby
// "From this device" file picker, never into this folder.
// See README.md for the owner workflow and ATTRIBUTION.md for the per-track credit.
//
// One entry looks like this (all fields required; `file` sits flat in web/songs/):
//   {
//     id: 'example-track',                 // ^[a-z0-9-]{1,32}$, unique
//     title: 'Example Track',              // 1..60 characters
//     artist: 'Example Artist',            // 1..60 characters
//     license: 'CC-BY-4.0',                // CC0-1.0 or CC-BY-4.0 only
//     source: 'https://example.org/track', // https URL of the original
//     file: 'example-track.mp3',           // lowercase letters, digits, hyphens, then .mp3
//     bytes: 3840000,                      // file size, at most 4194304
//     seconds: 240,                        // duration, 30..300
//     sha256: '<64 lowercase hex characters of the file>',
//   }
export const SONGS = Object.freeze([
  {
    id: 'jellyfish-in-space',
    title: 'Jellyfish in Space',
    artist: 'Kevin MacLeod (incompetech.com)',
    license: 'CC-BY-4.0',
    source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1500030',
    file: 'jellyfish-in-space.mp3',
    bytes: 4081490,
    seconds: 255,
    sha256: '921358ce3ae88244d4b1a493b45c99e698d222191f9885bec8bbc4d7c0df9e5e',
  },
  {
    id: 'floating-cities',
    title: 'Floating Cities',
    artist: 'Kevin MacLeod (incompetech.com)',
    license: 'CC-BY-4.0',
    source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1600018',
    file: 'floating-cities.mp3',
    bytes: 2946281,
    seconds: 184,
    sha256: 'ae7c51ecac7c73a6bc38551f55eadfd18082719f40612c8dfa247a2806f7e483',
  },
  {
    id: 'outer-space-loop',
    title: 'Outer Space Loop',
    artist: 'wipics (opengameart.org)',
    license: 'CC0-1.0',
    source: 'https://opengameart.org/content/outer-space-loop',
    file: 'outer-space-loop.mp3',
    bytes: 1119618,
    seconds: 69,
    sha256: '0add929c041c40d5a3edb105a4f0637dc24d51af1d04085d223bb916e205ba22',
  },
]);

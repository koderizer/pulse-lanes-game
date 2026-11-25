# Song attribution

Every bundled track in this folder needs an entry here and a matching entry in `manifest.js`
(ruling R46.2.2). Only tracks under **CC0-1.0** or **CC-BY-4.0** may be bundled: GitHub Pages
publishes everything in `web/`, so a bundled file is a public redistribution. The lobby shows
the credit line (`Title by Artist (CC BY 4.0)`) while the track is selected.

The song probe (`docs/pm/runs/FB3-WEB10/probes/song_probe.mjs`) checks that each manifest entry's
title, artist and license appear in this file.

Three tracks are bundled, owner-picked and attested on 2026-11-25
(docs/pm/runs/FB3-WEB10/songs-decision.md).

## Entry template

Copy this block once per track, directly under the "Tracks" heading.

```
### <Title>

- Title: <Title as in manifest.js>
- Artist: <Artist as in manifest.js>
- License: <CC0-1.0 | CC-BY-4.0> (<license URL>)
- Source: <https URL of the original>
- File: <file name in this folder>
- Changes: <for example "transcoded to MP3 128 kbps", or "none">
```

## Tracks

### Jellyfish in Space

- Title: Jellyfish in Space
- Artist: Kevin MacLeod (incompetech.com)
- License: CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)
- Source: https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1500030
- File: jellyfish-in-space.mp3
- Changes: trimmed 391s to 255s, transcoded to MP3 128 kbps CBR 44.1 kHz stereo

Credit line (CC BY 4.0 requires visible attribution):
"Jellyfish in Space" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By
Attribution 4.0 https://creativecommons.org/licenses/by/4.0/

### Floating Cities

- Title: Floating Cities
- Artist: Kevin MacLeod (incompetech.com)
- License: CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)
- Source: https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1600018
- File: floating-cities.mp3
- Changes: transcoded to MP3 128 kbps CBR 44.1 kHz stereo

Credit line (CC BY 4.0 requires visible attribution):
"Floating Cities" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By
Attribution 4.0 https://creativecommons.org/licenses/by/4.0/

### Outer Space Loop

- Title: Outer Space Loop
- Artist: wipics (opengameart.org)
- License: CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/)
- Source: https://opengameart.org/content/outer-space-loop
- File: outer-space-loop.mp3
- Changes: transcoded to MP3 128 kbps CBR 44.1 kHz stereo

CC0: public domain, attribution not required; credited here voluntarily.

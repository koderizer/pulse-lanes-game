# Bundled songs: owner workflow

`SONGS` in `manifest.js` ships empty. Real music for the game is an owner decision (ruling R46.2.2);
neither the builder nor the reviewer picks it. This file is how to add a track.

## Rule 1: license allowlist

Only **CC0-1.0** or **CC-BY-4.0** tracks may be placed in this folder. GitHub Pages publishes
everything in `web/`, so a file here is a public redistribution. For CC-BY-4.0 keep the credit line.

**A non-free song (commercial, NC, ND or unknown license) must never go into this folder.** The
owner's or a player's own music goes through the lobby picker (Song, then "From this device...").
That file is played from the browser's own object URL, never uploaded, never stored, never cached
and never committed.

## Rule 2: format and budget (R46.2.3)

| Item | Limit |
|---|---|
| Format | MP3 (MPEG-1 Layer III), 44.1 or 48 kHz, mono or stereo, at most 128 kbps (CBR, or VBR averaging 128 kbps or less) |
| Per track | 30 to 300 seconds, at most 4 194 304 bytes (4 MiB) |
| Total | at most 8 tracks and 16 777 216 bytes (16 MiB) |
| File name | `^[a-z0-9][a-z0-9-]{0,40}\.mp3$`, flat in this folder (no subfolders, no `..`) |
| Orphans | no audio file in this folder without a manifest entry |

## Steps to add a track

1. Transcode to the budget, for example:

   ```
   ffmpeg -i in.wav -codec:a libmp3lame -b:a 128k -ar 44100 out.mp3
   ```

2. Name it (`my-track.mp3`) and move it into `web/songs/`.
3. Compute the three numbers for the manifest, from the repository root:

   ```
   stat -c %s web/songs/my-track.mp3        # bytes
   sha256sum web/songs/my-track.mp3         # sha256 (64 lowercase hex characters)
   ffprobe -v error -show_entries format=duration -of csv=p=0 web/songs/my-track.mp3   # seconds, round to an integer
   ```

4. Add one entry to `SONGS` in `manifest.js` (the example entry in that file shows every field:
   `id`, `title`, `artist`, `license`, `source`, `file`, `bytes`, `seconds`, `sha256`).
5. Add the matching block to `ATTRIBUTION.md` (title, artist, license with its URL, source URL,
   and the changes you made, such as "transcoded to MP3 128 kbps").
6. Run the song probe from the repository root. It validates the manifest, then checks each file
   exists, its size equals `bytes`, its sha256 matches, `ATTRIBUTION.md` names it, and that no
   audio file sits here without an entry:

   ```
   node docs/pm/runs/FB3-WEB10/probes/song_probe.mjs
   ```

   It must end with `song_probe: PASS (n ok, 0 failed)`.
7. Bump the service worker cache key in `web/sw.js` (the `-fbN` suffix) only if your release process
   needs one. Song files are never precached or cached by the worker (they and Range requests go
   straight to the network); offline, a bundled song falls back to the synth score.

## Behavior to know

- The synth score stays the default. A selected song replaces the synth beat pulse and score voice
  only while it is actually audible; sound effects always play.
- Any failure (404, undecodable file, offline, blocked autoplay, a stall) falls back to the synth
  with no error shown except the lobby line "Song unavailable - playing the synth score.".
- The song never drives the simulation, spawning, replay or hashes.

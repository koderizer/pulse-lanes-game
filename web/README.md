# Pulse Lanes local build

No build step or downloaded dependencies are needed. From the repository root,
run `python3 -m http.server 8080 --bind 127.0.0.1` and open
`http://127.0.0.1:8080/web/`. The service worker caches the page and its source
modules on the first visit. Wait for the offline-cache message before stopping
the static server. Browser storage and WebAudio work on localhost.

Press Play, then use the left/right arrow keys or on-screen buttons. Pause
stops simulation ticks. Retry reuses the seed; New seed obtains a fresh u32
from the browser's cryptographic generator. Exit, retry, new seed and page
close record unfinished runs as abandoned. A hidden tab processes no ticks.
Sessions end on Exit, page close, or five minutes without active play.

Save and Load use `localStorage["pulse-lanes.pilotstate"]`. Export save and
Import save use that exact PilotState document. Export replay downloads the
canonical bytes of the latest terminal run. An interrupted session without
an end record remains valid but incomplete evidence. Browser storage errors
are displayed; export remains available when local storage is full.

The separate local leaderboard service runs with:

```sh
python3 -m server.app --host 127.0.0.1 --port 8081 --db /tmp/pulse-lanes.db --builds release/supported_builds.json
```

It serves only the contract's API. The page plays and saves entirely locally;
it does not submit run history automatically. API clients submit the nine
contract fields to `/api/leaderboard`; abandoned runs are not ranked.

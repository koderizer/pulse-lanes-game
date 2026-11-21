# M3-18-BUILD handoff

Identity verified: `/home/akelv/pilot/pulse-lanes`, branch `build`, starting
HEAD `5e66b9348dd9caaa70fed65b0dbbadd2eab50438`. No push or branch change.

Implementation follows the frozen contract: integer simulation and canonical
replay hashing; structural PilotState imports with independent replay
verification; two Node CLIs; an independent Python simulator and ordered
submission validator; atomic SQLite deduplication and top-20 ordering; a
playable browser page with synthesized music, local saving and offline cache.
All request bytes, headers, input sequences, versions, identifiers and claimed
results are attacker controlled. Admission uses configured supported builds
and server-recomputed replay results. Client score, terminal state and hash
are compared only after recomputation.

## Acceptance

Requested acceptance text (verbatim):

`.venv/bin/python -m pytest tests/ -q
-p no:cacheprovider` from the pilot repo root -> 34 passed, 0 skipped

Actual full-suite command:

```sh
/home/akelv/github/dual-loop-rsi/.venv/bin/python -m pytest tests/ -q -p no:cacheprovider
```

Full output before the final web/release commit:

```text
....................................                                     [100%]
36 passed in 18.75s
```

The suite includes the two R4 regression tests. There are zero skips.
PM question: may the written acceptance count be corrected from 34 to 36
to match the frozen suite, preserving every existing test?

The standalone T1 invocation uses the contract's actual CLI (there is no
`--impl js` option):

```sh
PYTHONDONTWRITEBYTECODE=1 /home/akelv/github/dual-loop-rsi/.venv/bin/python scripts/check_t1.py --manifest evidence/replay/manifest.json --expected evidence/replay/expected.json --out release/verification/t1 --candidate-cmd 'node=node tools/replay_cli.mjs' --candidate-cmd 'python=/home/akelv/github/dual-loop-rsi/.venv/bin/python -m server.verifier replay'
```

```text
T1 PASS: 2 candidate(s), 0 mismatch(es) -> release/verification/t1/comparison.json
```

Both candidates passed 128 cases, two runs each. The machine-readable result
is `release/verification/t1/comparison.json`. The full pytest run also passes
the PilotState fixture checks and the adversarial HTTP leaderboard battery.
T2 remains UNKNOWN for a single release, as required.

## Browser verification

Local Chromium checks confirmed the cached page, pause with no tick advance,
resume, Exit, retry preserving seed, page navigation finalizing an abandoned
run, and successful save import plus independent verification of all four
recorded runs. Offline network emulation followed by reload successfully
loaded the cached page and recorded another run. No uncaught browser errors
were observed. Firefox loaded the page, played, exited, imported its save,
and independently verified the abandoned run. The synchronous page-close
hash matched WebCrypto for all three normative no-input replay vectors.

These are browser lifecycle smoke checks, not the full browser/variant T1
matrix described for operators in contract section 8.3. Node and Python ran
the complete frozen T1 matrix.

## Integrity and offline check

Run at the handoff commit:

```sh
git diff --name-only 5e66b9348dd9caaa70fed65b0dbbadd2eab50438..HEAD
git log --oneline 5e66b9348dd9caaa70fed65b0dbbadd2eab50438..HEAD
```

All committed changes are under `src/`, `tools/`, `server/`, `web/`, or
`release/`. There is one commit per contract component. Frozen tracked
artifacts are unchanged. The initial untracked `.venv` was left alone;
pytest generated untracked Python bytecode caches, which were not committed.

Prescribed offline command:

```sh
grep -rn "fetch(\|https://\|http://" game web tools server | grep -v "127.0.0.1\|localhost\|example\|comment"
```

Full output (stderr; stdout empty):

```text
grep: game: No such file or directory
```

The authorized-path equivalent produces no output:

```sh
grep -rn "fetch(\|https://\|http://" src web tools server release | grep -v "127.0.0.1\|localhost\|example\|comment"
```

The only application fetch is the service worker's same-origin static-asset
fallback. No external assets or provider calls are used.
PM question: may the obsolete `game` operand be replaced by `src` in the
written offline command, consistent with the binding R1 adjudication?

## Run locally

See `web/README.md` for the static page and leaderboard commands. No package
installation or build step is required. Browser and CLI use the same source
modules. The page saves locally; it does not automatically submit history to
the leaderboard.

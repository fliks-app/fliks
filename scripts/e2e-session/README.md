# Account session end-to-end check

Drives two headless Chromium instances (separate profiles, debugging ports 9333 and 9334) against a running
dev stack (`docker-compose.dev.example.yml`, UI on :4500) and checks the account session: option off, strip,
"play here", transfer, parked and resume, audio queue control, kind scope. Node 24, no dependency.

```bash
FLIKS_E2E_MEDIA_ID=12 FLIKS_E2E_FILE_ID=34 FLIKS_E2E_TRACK_IDS=101,102,103 node scripts/e2e-session/run.mjs
node scripts/e2e-session/run.mjs --smoke        # login + two browsers + SSE targets only
node scripts/e2e-session/run.mjs --only=3,4     # a subset of the checks
```

Each check logs in again, stops what plays, deletes the session row, sets `sessionSync`/`sessionKinds` through
`PUT /api/users/:id` and reloads both tabs. Output is one PASS/FAIL line per check and a summary table; the exit
code is 1 when a check fails. Both browsers are closed and their profiles removed at the end.

| Variable (`FLIKS_E2E_` prefix) | Default | Meaning |
|---|---|---|
| `URL` | `http://localhost:4500` | UI base URL (it proxies `/api`) |
| `USER`, `PASSWORD` | `admin`, `password` | account used for the run (its preferences are changed) |
| `MEDIA_ID`, `FILE_ID`, `EPISODE_ID` | none, required | a video the engine can play: media, file, optional episode |
| `TRACK_IDS` | none, checks 6 and 7 | three music track item ids, comma separated |
| `LANG` | `en` | UI language; labels are read from `client/public/i18n/<lang>.json` |
| `PARK_WAIT_MS` | `90000` | how long check 5 waits for the presence TTL and the sweep |
| `PORT_A`, `PORT_B`, `CHROMIUM` | `9333`, `9334`, `chromium` | browser setup |

Chromium is a snap: the profiles live in its private `/tmp`, and the script removes them with
`snap run --shell chromium -c 'rm -rf ...'`. It kills nothing by pattern. Check 5 crashes the tab with
`Page.crash` (no stop, no pagehide) instead of a signal, which the snap confinement refuses.

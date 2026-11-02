# HTTP parity

Scenarios replayed against `fliks-server`. A behaviour change edits the `expect`s it affects. CI runs all of it (`parity` jobs of `.github/workflows/server.yml`, one per mode and shard, not required): `PGHOST` set makes `run-all.sh` and the runner use the local `psql` and the `PG*` environment.
Locally it needs docker (a PostgreSQL container, `fliks-postgres-1` unless `PARITY_PG` names another), ffmpeg, python3 and `FLIKS_ENGINE_FIXTURES` (default `~/Documents/clement/code/fliks-engine/fixtures/probe`).

## Run everything

```bash
CARGO_TARGET_DIR=$HOME/Documents/clement/code/fliks/server/target/<worktree> server/parity/run-all.sh [filter]
# PARITY_MODES limits the modes (provider scenarios are `engine: down`: `up0` alone leaves their `expect`s stale);
# PARITY_SHARD=<k>/<n> runs the k-th of n size-balanced shares of the groups (CI); PARITY_ENGINE_VERSION=<x.y.z> tests another engine release than engine.lock
```

It builds Rust (parity feature) once, downloads the engine pinned in `engine.lock`, creates its own
`pall_*` databases, starts every stub and its own engine, runs each scenario group in each mode it needs
(engine up/down without provider keys, engine stub for `markers`, engine up/down with provider keys), prints
one table and exits non-zero on any FAIL. Everything is torn down by process group on exit or
Ctrl-C; runtime dirs and logs are in `$CARGO_TARGET_DIR/run-all`. Needs docker (`fliks-postgres-1`), ffmpeg,
python3, node (the stubs). Reserved ports 4960-4999: 4960 arr stub, 4961 livetv fixture, 4962 emby stub, 4963 engine stub,
4964 provider stub (`stub.py`), 4965 engine, 4966 `fliks-server`. Media and fixtures live in
`$CARGO_TARGET_DIR/run-all/root` (`FLIKS_PARITY_ROOT`; the default `/tmp/fliks-parity` is what scenarios spell).

The sections below describe the pieces `run-all.sh` scripts, for debugging a single group or recording a new scenario.

```bash
./media-gen.sh      # tiny files under /tmp/fliks-parity (idempotent)
./seed/build.sh     # rebuilds template DB fliks_parity_tpl + seed/base.sql (drop the DBs freely); with PGHOST set it uses the local psql and writes no dump (CI)
# template from the committed dump only (no fixtures needed):
docker exec -i fliks-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -qd postgres -c "DROP DATABASE IF EXISTS fliks_parity_tpl WITH (FORCE)" -c "CREATE DATABASE fliks_parity_tpl" && psql -U "$POSTGRES_USER" -qd fliks_parity_tpl' < seed/base.sql
# then bring it to the current schema (base.sql is only rebuilt by seed/build.sh):
DB_HOST=<postgres ip> DB_USERNAME=... DB_PASSWORD=... DB_NAME=fliks_parity_tpl cargo run -p fliks-server -- migrate
python3 external/stub.py 4964 &              # every run: the idle wait probes it (PARITY_STUB)
python3 external/livetv/server.py 4961 &     # livetv scenarios: PARITY_LIVETV=http://127.0.0.1:4961
```

From `server/`, with the `CARGO_*` env of `CLAUDE.md`:

```bash
cargo test -p fliks-server --test it parity::parity -- --ignored --nocapture 2>&1 | tail -40   # replay on :4849; PARITY_FILTER=<substring> [<substring>...]
PARITY_RECORD=1 cargo test -p fliks-server --test it parity::parity -- --ignored --nocapture   # fills only the steps without `expect`
```

Target (`fliks-server` alone on :4849, a scratch database reset as in the template step above):

```bash
export DB_NAME=fliks_parity PORT=4849 JWT_SECRET=parity-secret FLIKS_PLUGINS_DISABLED=1 FLIKS_DISABLE_CRON=1 FLIKS_CONF_DIR=/tmp/fliks-parity/conf
export FLIKS_CAST_DIR=$PWD/public   # from server/
# engine up: also FLIKS_ENGINE_URL / FLIKS_ENGINE_TOKEN of the engine on :4860, and PARITY_HOST_TOKEN for the runner; engine down: neither
"$CARGO_TARGET_DIR"/debug/fliks-server
```

Record mode never overwrites an existing `expect`: edit it by hand in the PR that changes the behaviour.
Keys added to the contract after the recordings (additive keys, e.g. `trackMarkers`) are listed in
`ADDITIVE` (`crates/server/tests/it/parity.rs`) and never compared.

- Actors log in as `<name>` / `<name>-pass` (`admin user readonly other manager`); `engine` sends Bearer `PARITY_HOST_TOKEN`.
- Seed profiles: a scenario `"seed": "<name>"` other than `base` runs on `base` plus `seed/<name>.sql` (built once per run as `<tpl>_<name>`); `PARITY_DB` / `PARITY_TPL` rename the working and template databases so runs can be parallel. `media-query` adds 31 media, a `noread` actor and the catalog fixtures of `docs/spec/media-query.md`.
- Provider scenarios (any `"stub": true` step) need a target with `TMDB_API_KEY`/`TVDB_API_KEY`, the `FLIKS_TMDB_API_URL`/`FLIKS_TVDB_API_URL`/`FLIKS_TMDB_IMAGE_URL` stub URLs and `external/stub.py`; start the target with `TMDB_API_KEY=tmdb-parity` and `TVDB_API_KEY=tvdb-parity` (the recorded bodies carry that key) and run them with `PARITY_PROVIDERS=1` (only they run) and every other scenario on a target without keys but with the same stub URLs, so nothing leaves loopback (`stub.py` answers a keyless TMDB call with TMDB's 401, and serves fixtures with the absolute `image.tmdb.org` and `artworks.thetvdb.com` URLs pointing back at itself; the runner maps them back in response bodies). The target runs with `FLIKS_PLUGINS_DISABLED=1`, which also skips the catalog refresh.
- Step extras: `baseEnv` (the step goes to that env var's URL when it is set and non-empty, else to the target), `ignore` (step-level paths dropped from that step's body), `ignoreBody` (step-level: the body is not compared, e.g. an SSE step that only waits), `headers`, `auth` (`bearer|query`), `multipart` (`file`|`content`|`size` bytes, `filename`, `contentType`, `fields` text parts sent before the file), `sse` (`events`, `timeoutMs`, `after` sub-steps); scenario `unordered` (paths whose arrays are compared as sets).
- Scenario `fs`: rebuilds `/tmp/fliks-parity/<fsDir>` (default `s5-ingest/work`) before the steps (`{path, from}` copies a generated file, `{path, text}`, `{dir}`, `{link, to}`); `fsAfter` `{exists, absent}` checks the tree after them (write-path scenarios).
- `"engine": "up"|"down"|"stub"` on a scenario needs that engine state (`PARITY_ENGINE`, default `up`; others are skipped). `stub` is the markers detection: run `node parity/stubs/engine-stub.mjs 4963`, start the target with `FLIKS_ENGINE_URL=http://127.0.0.1:4963 FLIKS_ENGINE_TOKEN=stub` and `PARITY_ENGINE=stub PARITY_FILTER=scenarios/markers/`.
  Untagged scenarios must pass in both. `down`: the target without `FLIKS_ENGINE_URL`.
- Engine-up recordings use the dev-stack `engine` service via `docker compose run` (cargo watch on `../fliks-engine`),
  media mounted from `/tmp/fliks-parity`; `PARITY_HOST_TOKEN` is read from the engine's `GET /v1/config`.
- Sync points, never `sleepMs` for a wait: an SSE step whose `after` sub-steps cause the events; `retryMs` on a step (repeat it until its `expect` holds, at most that long, then fail on the last diff); `{"wait": "idle"|"busy"}`. Idle means: empty `GET /api/system/activity`, no stub request in flight (`/__inflight` of `PARITY_STUB` and of `PARITY_LIVETV` when set) and no running client query on the scenario DB, stable over two polls; an unreadable probe fails the run. Every run waits for idle before each reset, so no detached job reaches the next scenario's database; the reset also empties `<root>/data/backups`. `busy` is the same signal inverted (the two livetv `*-sync-409` scenarios rely on the fixture delay to keep it set). The remaining `sleepMs` are timers: `metadata/zz-breaker-open` (breaker cooldown), `livetv-live/livetv-zap` and `livetv-capacity-409` (channel idle plus slot release, see their `note`).
- Known limits: work that is invisible to every probe (e.g. an image resize in `spawn_blocking` between two awaits) can still outlive the idle wait; `after` sub-steps with `status: 0` or no `expect` (24 in `events/`, `importers/seerr-*`, `markers/detect-*`, `media-servers/import-*`, `provider-write/refresh-override-unresolvable`) are not checked, their expectations were never recorded (#1754).
- Only the DB is reset between scenarios: in-memory state (engine sessions, SSE, targets) persists, so scenarios close what they open.
- Subtitle scenarios (`scenarios/subtitles*`): generated media under `/tmp/fliks-parity/s6/subtitles-work` (scenario `fsDir`, seed `subtitles-work`). `scenarios/subtitles-provider/` needs the loopback stub (`PARITY_PROVIDERS=1`, `external/stub.py` serves a Subdl clone): the target is built with `--features parity` and gets `FLIKS_SUBTITLE_PROVIDERS_URL=<stub>`. Sync and OCR scenarios are `"engine": "up"`. The in-memory sync queue persists across scenarios: restart the target before a replay of `subtitles-provider`.
- Plugin scenarios (`scenarios/plugins/`, plugin-free only, `plugins.md` Vectors/parity): `FLIKS_PLUGINS_DISABLED=1`, `PARITY_ENGINE=up` (no engine is needed). The base seed carries catalog source #1, so the scenarios create and edit source #2; the refresh scenario points at `https://127.0.0.1:1` (`network-error`, no network).

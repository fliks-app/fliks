# HTTP parity

Scenarios recorded against Nest, replayed against any target (plan §5.3). Local only.
Needs docker (`fliks-postgres-1`), ffmpeg, python3 and `FLIKS_ENGINE_FIXTURES` (default `~/Documents/clement/code/fliks-engine/fixtures/probe`).

```bash
./media-gen.sh      # tiny files under /tmp/fliks-parity (idempotent)
./seed/build.sh     # rebuilds template DB fliks_parity_tpl + seed/base.sql (drop the DBs freely)
# template from the committed dump only (no fixtures needed):
docker exec -i fliks-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -qd postgres -c "DROP DATABASE IF EXISTS fliks_parity_tpl WITH (FORCE)" -c "CREATE DATABASE fliks_parity_tpl" && psql -U "$POSTGRES_USER" -qd fliks_parity_tpl' < seed/base.sql
```

From `server/`, with the `CARGO_*` env of `CLAUDE.md`:

```bash
# record: Nest on :4850 (DB_NAME=fliks_parity, fixed JWT_SECRET, FLIKS_PLUGINS_DISABLED=1, dirs in /tmp/fliks-parity)
PARITY_TARGET=http://127.0.0.1:4850 PARITY_RECORD=1 PARITY_ENGINE=up cargo test -p fliks-server --test parity -- --ignored --nocapture
cargo test -p fliks-server --test parity -- --ignored --nocapture 2>&1 | tail -40   # replay on :4849; PARITY_FILTER=<substring>
```

Replay target (Rust in front of Nest on :4849, run from `backend/` after `npm run build`; DB reset as in the template step above):

```bash
export DB_NAME=fliks_parity PORT=4849 JWT_SECRET=parity-secret FLIKS_PLUGINS_DISABLED=1 FLIKS_CONF_DIR=/tmp/fliks-parity/conf
export FLIKS_CAST_DIR=$PWD/../backend/public   # from server/; without it bootstrap-cast-receiver-static fails unless cwd has public/
# engine up: also FLIKS_ENGINE_URL / FLIKS_ENGINE_TOKEN of a running engine, and PARITY_HOST_TOKEN for the runner
(cd ../backend && exec "$CARGO_TARGET_DIR"/debug/fliks-server)
```

- Actors log in as `<name>` / `<name>-pass` (`admin user readonly other manager`); `engine` sends Bearer `PARITY_HOST_TOKEN`.
- Seed profiles: a scenario `"seed": "<name>"` other than `base` runs on `base` plus `seed/<name>.sql` (built once per run as `<tpl>_<name>`); `PARITY_DB` / `PARITY_TPL` rename the working and template databases so runs can be parallel. `media-query` adds 31 media, a `noread` actor and the catalog fixtures of `docs/spec/media-query.md`.
- Provider scenarios (any `"stub": true` step) need a target with `TMDB_API_KEY`/`TVDB_API_KEY`, the `FLIKS_TMDB_API_URL`/`FLIKS_TVDB_API_URL`/`FLIKS_TMDB_IMAGE_URL` stub URLs (Nest: `external/nest-external-mock.cjs`) and `external/stub.py`; run them with `PARITY_PROVIDERS=1` (only they run) and every other scenario on a target without keys.
- Step extras: `ignore` (step-level paths dropped from that step's body), `ignoreBody` (step-level: the body is not compared, e.g. an SSE step that only waits), `headers`, `auth` (`bearer|query`), `multipart` (`file`|`content`|`size` bytes, `filename`, `contentType`, `fields` text parts sent before the file), `sse` (`events`, `timeoutMs`, `after` sub-steps); scenario `unordered` (paths whose arrays are compared as sets).
- Scenario `fs`: rebuilds `/tmp/fliks-parity/<fsDir>` (default `s5-ingest/work`) before the steps (`{path, from}` copies a generated file, `{path, text}`, `{dir}`, `{link, to}`); `fsAfter` `{exists, absent}` checks the tree after them (write-path scenarios).
- `"engine": "up"|"down"|"stub"` on a scenario needs that engine state (`PARITY_ENGINE`, default `up`; others are skipped). `stub` is the markers detection: run `node parity/stubs/engine-stub.mjs 4881`, start the target with `FLIKS_ENGINE_URL=http://127.0.0.1:4881 FLIKS_ENGINE_TOKEN=stub` and `PARITY_ENGINE=stub PARITY_FILTER=scenarios/markers/`. Detection against the real engine is the S5 exit check (`docs/spec/markers.md`, Vectors/parity).
  Untagged scenarios must pass in both. `down`: Nest without `FLIKS_ENGINE_URL`; record each mode with its own Nest.
- Engine-up recordings use the dev-stack `engine` service via `docker compose run` (cargo watch on `../fliks-engine`),
  media mounted from `/tmp/fliks-parity`; `PARITY_HOST_TOKEN` is read from the engine's `GET /v1/config`.
- Only the DB is reset between scenarios: in-memory Nest/Rust state (engine sessions, SSE, targets) persists, so scenarios close what they open.
- `"deviation": "<row id of docs/README.md Deviations>"` (e.g. `F1`) + a hand-written `expect`; reported separately.
- Subtitle scenarios (`scenarios/subtitles*`): recorded against the Nest of commit `f246dfa7` (pre-S5 `main`, `npm run build`, `node dist/main`) behind the Rust front built from `6037f4af` (the S5 integration, before the S6 router: every subtitle route is forwarded to Nest), generated media under `/tmp/fliks-parity/s6/subtitles-work` (scenario `fsDir`, seed `subtitles-work`). `scenarios/subtitles-provider/` needs the loopback stub (`PARITY_PROVIDERS=1`, `external/stub.py` serves a Subdl clone): Nest gets `NODE_OPTIONS="--require external/nest-subtitle-mock.cjs"` (rewrites the OpenSubtitles and Subdl hosts of `fetch`), Rust gets `FLIKS_SUBTITLE_PROVIDERS_URL=<stub>`. Sync and OCR scenarios are `"engine": "up"`. The in-memory sync queue persists across scenarios: restart the target before a replay of `subtitles-provider`.

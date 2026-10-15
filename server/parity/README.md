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
- Step extras: `headers`, `auth` (`bearer|query`), `multipart`, `sse` (`events`, `timeoutMs`, `after` sub-steps); scenario `unordered` (paths whose arrays are compared as sets).
- `"engine": "up"|"down"` on a scenario needs that engine state (`PARITY_ENGINE`, default `up`; others are skipped).
  Untagged scenarios must pass in both. `down`: Nest without `FLIKS_ENGINE_URL`; record each mode with its own Nest.
- Engine-up recordings use the dev-stack `engine` service via `docker compose run` (cargo watch on `../fliks-engine`),
  media mounted from `/tmp/fliks-parity`; `PARITY_HOST_TOKEN` is read from the engine's `GET /v1/config`.
- Only the DB is reset between scenarios: in-memory Nest/Rust state (engine sessions, SSE, targets) persists, so scenarios close what they open.
- `"deviation": "<row id of docs/README.md Deviations>"` (e.g. `F1`) + a hand-written `expect`; reported separately.

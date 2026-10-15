# HTTP parity

Scenarios recorded against Nest, replayed against any target (plan §5.3). Local only.

Needs docker (container `fliks-postgres-1`), ffmpeg, python3, and the engine repo for probe fixtures
(`FLIKS_ENGINE_FIXTURES`, default `~/Documents/clement/code/fliks-engine/fixtures/probe`).

```bash
./media-gen.sh                 # tiny files under /tmp/fliks-parity (idempotent)
./seed/build.sh                # rebuilds template DB fliks_parity_tpl + seed/base.sql
```

Run (from `server/`, cargo under the usual `CARGO_*` env, see `CLAUDE.md`):

```bash
# record: Nest on :4850 with DB_NAME=fliks_parity, JWT_SECRET fixed, FLIKS_PLUGINS_DISABLED=1, dirs in /tmp/fliks-parity
PARITY_TARGET=http://127.0.0.1:4850 PARITY_RECORD=1 cargo test -p fliks-server --test parity -- --ignored --nocapture
# replay against fliks-server (default target http://127.0.0.1:4849); PARITY_FILTER=<substring> narrows files
cargo test -p fliks-server --test parity -- --ignored --nocapture 2>&1 | tail -40
```

Each scenario recreates `fliks_parity` from `fliks_parity_tpl`; seeded actors log in as `<name>` / `<name>-pass`
(`admin user readonly other manager`). Step extras: `headers`, `auth` (`bearer|query`), `multipart`, `sse`
(`events`, `timeoutMs`, `after` sub-steps), actor `engine` (Bearer `PARITY_HOST_TOKEN`). Databases are rebuilt by
`build.sh`; drop them freely.

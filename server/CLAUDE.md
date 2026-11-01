# fliks-server workspace

The Fliks HTTP server (Rust), run behind the `fliks-engine` supervisor.

## Crates

- `crates/domain` (`fliks_domain`): pure logic — serde, serde_json, chrono, regex, fancy-regex, regress, unicode-normalization, encoding_rs, quick-xml, url, percent-encoding only. No tokio, sqlx, fs, axum.
- `crates/server` (`fliks-server`): axum binary, sqlx, the `fliks-engine-core` git dependency, HTTP and DB.
- `crates/plugin-sdk`: the pluginApi 3 guest SDK.

## Rules

Spec first: change behaviour in `docs/spec/` first, then the code. No workarounds; stop and report if blocked. A behaviour change updates its spec, the parity `expect`s and the golden vectors (`BLESS=1`) in the same PR. Comments: one line, non-obvious why only. Commits: Conventional Commits, no `Co-Authored-By`, identity `clementdelestre@gmail.com`. Real media read-only; parity uses `/tmp/fliks-parity/`. Never read `docker-compose.yml` or `CHANGELOG.md`.

## Docs

- `docs/README.md` — spec index.
- `docs/spec/<domain>.md` — per-domain specs.

## Commands

From `server/`:

```bash
export CARGO_BUILD_JOBS=4
export CARGO_TARGET_DIR=$HOME/Documents/clement/code/fliks/server/target   # main checkout only; worktrees: see below
cargo test -p fliks_domain -- --test-threads=4 2>&1 | tail -30
../scripts/with-test-postgres.sh cargo test -p fliks-server -- --test-threads=4 2>&1 | tail -30
cargo clippy --all-targets -- -D warnings 2>&1 | tail -30
parity/run-all.sh   # full parity suite (parity/README.md)
```

DB tests run against a throwaway PostgreSQL (`scripts/with-test-postgres.sh`), so concurrent runs never share `#[sqlx::test]` databases. One Rust build at a time across agents (`fliks-heavy`). Quiet: pipe test/clippy output through `tail -30`.

`cargo sqlx prepare --workspace -- --all-targets` regenerates `.sqlx` (run it on a database migrated to HEAD after any `query!` or migration change). Never edit `.sqlx` by hand.

### Worktrees

An agent in a worktree builds into its own target inside the worktree, never the shared `server/target` (it left stale `fliks_domain` rlibs across worktrees):

```bash
export CARGO_TARGET_DIR=$PWD/target RUSTC_WRAPPER=sccache CARGO_INCREMENTAL=0   # PWD = the worktree's server/
```

`sccache` is `~/.cargo/bin/sccache`. Not in CI, not in a committed `.cargo/config.toml`. The main checkout keeps the shared `server/target` above.

## Before you open a PR

- A migration: update `parity/seed/build.sh`, and the per-group `parity/seed/<group>.sql` when it adds a required column or table; CI rebuilds the seeds, so a break fails there.
- Parity: don't run the full suite locally. The `parity` jobs of the Server workflow run it on every PR (all modes, sharded; not a required check): read the job summary for the failing scenarios and the `parity-*-logs` artifact. Run a group locally (`PARITY_MODES=up0 parity/run-all.sh <group>`, own slot, not under `fliks-heavy`) only to debug a CI failure or to record `expect`s for a changed behaviour. Provider scenarios are `engine: down`: `up0` alone leaves their `expect`s stale.
- A backfill (`UPDATE` in a migration) must not bump `updatedAt`: `ALTER TABLE t DISABLE TRIGGER set_updated_at` around it, then re-enable.
- Every FK gets a non-partial index led by its columns (`tests/it/migrations.rs` asserts it); a partial index is useless to the cascade.
- Wire bodies (`playlists/items.rs`): name the columns, never `to_jsonb(row)` of a whole table, so moving a column cannot move the wire.
- Concurrent writers to the same rows: take an advisory lock or a row lock, and test the race.
- `.sqlx` regenerated with `cargo sqlx prepare --workspace`, `openapi.json` and `BLESS=1` vectors current.
- No real media titles in fixtures or tests (placeholders), no literal em dash in source (use `\u2014` in data fixtures; CI greps added lines).
- fmt, clippy and the touched tests green through `fliks-heavy` before pushing.

## Layout

`migrations/` (sqlx; a 4.x database is adopted from its TypeORM ledger by `db/migrate.rs`), `parity/`, `fixtures/`, `public/` (emoji assets), `docs/spec/`.

# fliks-server workspace

The Fliks HTTP server (Rust), run behind the `fliks-engine` supervisor.

## Crates

- `crates/domain` (`fliks_domain`): pure logic — serde, serde_json, chrono, regex, fancy-regex, regress, unicode-normalization, encoding_rs, quick-xml, url, percent-encoding only. No tokio, sqlx, fs, axum.
- `crates/server` (`fliks-server`): axum binary, sqlx, the `fliks-engine-core` git dependency, HTTP and DB.
- `crates/plugin-sdk`: the pluginApi 2 guest SDK.

## Rules

Spec first: change behaviour in `docs/spec/` first, then the code. No workarounds; stop and report if blocked. Contract frozen: the allowed client-visible diffs are the `docs/README.md` Deviations rows. Golden vectors (`fixtures/`) and parity `expect`s were recorded from Nest and are never regenerated from Rust: a changed `expected`/`expect` lands only in a PR naming its F/C Deviations row (`fixtures/README.md`). Comments: one line, non-obvious why only. Commits: Conventional Commits, no `Co-Authored-By`, identity `clementdelestre@gmail.com`. Real media read-only; parity uses `/tmp/fliks-parity/`. Never read `docker-compose.yml` or `CHANGELOG.md`.

## Docs

- `docs/README.md` — spec index, tag legend (`[ts:]` tags resolve at git tag `nest-final`), deviations.
- `docs/spec/<domain>.md` — per-domain specs.

## Commands

From `server/`:

```bash
export CARGO_BUILD_JOBS=4
export CARGO_TARGET_DIR=$HOME/Documents/clement/code/fliks/server/target
cargo test -p fliks_domain -- --test-threads=4 2>&1 | tail -30
../scripts/with-test-postgres.sh cargo test -p fliks-server -- --test-threads=4 2>&1 | tail -30
cargo clippy --all-targets -- -D warnings 2>&1 | tail -30
parity/run-all.sh   # full parity suite (parity/README.md)
```

DB tests run against a throwaway PostgreSQL (`scripts/with-test-postgres.sh`), so concurrent runs never share `#[sqlx::test]` databases. One Rust build at a time across agents (shared `server/target`). Quiet: pipe test/clippy output through `tail -30`.

## Layout

`migrations/` (sqlx; a 4.x database is adopted from its TypeORM ledger by `db/migrate.rs`), `parity/`, `fixtures/`, `public/` (cast receiver page), `docs/spec/`.

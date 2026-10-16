# fliks-server workspace

Rust app replacing Nest (`backend/`). Plan: `~/Documents/clement/code/fliks-handoff/phase2-plan.md`.

## Crates

- `crates/domain` (`fliks_domain`): pure logic — serde, serde_json, chrono, regex, fancy-regex, regress, unicode-normalization only. No tokio, sqlx, fs, axum.
- `crates/server` (`fliks-server`): axum binary, sqlx, engine git deps, HTTP and DB.

## Rules (§0 condensed)

Spec first: port from `docs/spec/` + `fixtures/`; open TS only at `[ts:path:line]` tags (±40 lines). One source of truth — delete Nest when Rust owns a rule; bridges only per `docs/bridge.md`. No workarounds; stop and report if blocked. Contract frozen; allowed diffs only in `docs/README.md` Deviations. Comments: one line, non-obvious why only. Commits: Conventional Commits, no `Co-Authored-By`, identity `clementdelestre@gmail.com`. Real media read-only; parity uses `/tmp/fliks-parity/`. Never read `docker-compose.yml`, `backend/src/modules/engine/schema.d.ts`, or `CHANGELOG.md`.

## Docs

- `docs/README.md` — spec index, tag legend, deviations.
- `docs/bridge.md` — temporary Rust↔Nest endpoints.
- `docs/spec/<domain>.md` — per-domain specs (§12 template).

## Commands

From `server/`:

```bash
export CARGO_BUILD_JOBS=4
export CARGO_TARGET_DIR=$HOME/Documents/clement/code/fliks/server/target
cargo test -p fliks_domain -- --test-threads=4 2>&1 | tail -30
cargo test -p fliks-server -- --test-threads=4 2>&1 | tail -30
cargo clippy --all-targets -- -D warnings 2>&1 | tail -30
```

One Rust build at a time across agents (shared `server/target`). Quiet: pipe test/clippy output through `tail -30`.

## Layout (empty until later milestones)

`migrations/`, `contract/`, `parity/`, `fixtures/`, `docs/spec/` — see plan §4.1.

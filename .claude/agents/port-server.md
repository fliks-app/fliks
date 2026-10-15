# Port-server agent

**Default model:** Sonnet for mechanical ports; Opus when the plan assigns high-effort domains (auth, S2 realtime, disk writes, WASM).

**Plan:** `~/Documents/clement/code/fliks-handoff/phase2-plan.md` — read §0 and your milestone section first.

## Rules (§0)

Spec first, port second — from `server/docs/spec/<domain>.md` and `server/fixtures/`; never browse TS modules at large. Open TS only at `[ts:path:line]` (±40). Wrong spec → fix spec in the same PR, then port. One source of truth: delete Nest when Rust owns the rule; bridges only if listed in `server/docs/bridge.md`. No workarounds — stop and report. Contract frozen except `server/docs/README.md` Deviations. Comments: one line, non-obvious why. Commits: Conventional Commits, lowercase subject, no `Co-Authored-By`, `clementdelestre@gmail.com`. Real media read-only. Never read `docker-compose.yml`, `schema.d.ts`, `CHANGELOG.md`.

## Loop

1. Read the domain spec + fixtures.
2. Implement in `server/crates/` (pure logic → `domain`; HTTP/DB → `server`).
3. Add/update vectors and parity scenarios when the milestone requires it.
4. Delete corresponding Nest code in the same milestone unless `bridge.md` says otherwise.
5. Register any new bridge in `server/docs/bridge.md` before implementing.

## Commands

From `server/`: `CARGO_BUILD_JOBS=4`, shared `server/target`, **one Rust build at a time**.

```bash
cargo test -p <crate> <filter> -- --test-threads=4 2>&1 | tail -30
cargo clippy --all-targets -- -D warnings 2>&1 | tail -30
npx jest <path> 2>&1 | tail -30   # when Nest/client tests apply
```

`tools/sym NAME` at repo root for symbol lookup (±40 lines when reading).

## Report (≤ 25 lines)

Files changed, commands run (pass/fail), blocked items, bridge/spec updates. Finish the step before reporting.

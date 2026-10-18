# Spec: node-removal

Sources: repo state at `origin/main` ed47b977 (S4 merged; S5-S8 not yet), plan §0, §9.1-§9.3, §10 (S9, "Milestone gate", "Release gate"), §15; engine `origin/main` d4189ba (`Dockerfile`, `crates/engine/src/{slots,supervise,jobs/sync}.rs`); the TrueNAS catalog `ix-dev/community/fliks` on `truenas/apps` master (read 2026-10-16). Milestone: S9. No Nest `[ts:]` tags: this spec deletes code, it ports none. File:line citations are the tree at ed47b977; S5-S8 delete part of what is listed, so the S9 porter **re-greps every row** (section 11) and treats a row that is already gone as done.

**Release rule** (plan §0 rule 0, user): nothing is released between 4.x and the S9 result. The release gate below is the only user-facing gate, and the only upgrade path that must work is a real 4.x install to 5.0.0 (release-gate item 1). Intermediate milestone states never reached users, so S9 needs no compatibility with them: no shim, no migration and no bridge for a state between S0 and S8. Progress since this spec was written: S5-S7 are merged (`main` 6d41c5ed), S8 is PR #1753.

State at ed47b977 to size the work: `backend/` 1286 tracked files (191 `*.spec.ts`, 82 under `src/migrations`, 549 under `assets/prowlarr-definitions`); `server/contract/nest-routes.json` 222 routes; `server/docs/bridge.md` 30 data rows (19 bridges, 11 known gaps); the S-prep manifest (`85da4dc6`, 366 distinct non-`ALL` operations) minus `server/openapi.json` leaves 219.

## 1. Preconditions (entry gate of the S9 PR)

All must hold before the first deletion commit; each is a command, run from the repo root with `LC_ALL=C`.

1. S5, S6, S7, S8 merged to `main` (their PRs list their own "Deletes from Nest").
2. The manifest holds only the S9-owned Nest bridge: `jq -r '.[]|"\(.method) \(.path)"' server/contract/nest-routes.json` prints exactly `POST /internal/bridge/settings-changed` (its `BridgeController` leaves with `backend/` in this PR; 223 entries at ed47b977), and `(cd backend && npm ci && npm run dump-routes) && git diff --exit-code server/contract` is clean (`dump-routes` builds the module graph with `preview: true`, no database). The plan wording "`nest-routes.json` ⊂ Rust OpenAPI" is the wrong invariant: `server/crates/server/tests/routes.rs` (`no_openapi_operation_is_in_the_nest_manifest`) asserts the two are **disjoint**, so a non-empty manifest is the failure. See section 12.
3. Every route Nest ever served is Rust's. Normalised path parameters (`:id` and `{id}` both become `{}`), the S-prep manifest minus OpenAPI must print nothing, except the one `ALL /api/plugins/:pluginId/*splat` row, which `jq` drops below and the S8 spec routes through the plugin host (not in `openapi.json`):
   ```bash
   norm='gsub(":[A-Za-z0-9_]+";"{}")|gsub("\\{[^}]*\\}";"{}")'
   git show 85da4dc6:server/contract/nest-routes.json | jq -r ".[]|select(.method!=\"ALL\")|\"\(.method|ascii_downcase) \(.path|$norm)\"" | sort -u > /tmp/sprep.txt
   jq -r ".paths|to_entries[]|.key as \$p|.value|keys[]|\"\(.) \(\$p|$norm)\"" server/openapi.json | sort -u > /tmp/openapi.txt
   comm -23 /tmp/sprep.txt /tmp/openapi.txt        # must print nothing
   ```
   Verified at ed47b977: this prints 219 lines (the unported routes) and `comm -13` prints 0, so the command itself works; a route dropped on purpose is listed in a deviation row, not skipped here.
4. `bridge.md` holds only the six rows S9 removes (bridges `settings-changed`, `/internal/events`, `/internal/events/stream`, `/internal/activity`, `/internal/activity/claim`; the S9 known gap `GET /api/system/logs`): `grep -E '^\| ' server/docs/bridge.md | grep -vE '^\| (Endpoint|Until) \|' | grep -vE '\| S9 \|$|^\| S9 \|'` prints nothing (24 lines at ed47b977). The two "Engine change (S7 ships without)" gap rows are not S9's to delete: they close with an engine release pinned in `engine.lock` (precondition 6), or the gate fails. The file is deleted in commit 4 (section 11).
5. `grep -rn 'FLIKS_NEST\|FLIKS_BRIDGE\|FLIKS_NODE_BIN\|FLIKS_SERVER_URL' server/crates backend/src` only hits the code this PR deletes (Nest side and `config.rs`/`nest.rs`/`bridge.rs`), never a live feature.
6. Engine: `engine.lock`, `Dockerfile` `ENGINE_IMAGE` and `server/crates/server/Cargo.toml` all pin the same release (the `engine-schema.yml` first step checks only the Cargo tags today; `engine-lock.yml` adds the image, section 2.2), and that release ships `ffsubsync` (section 3, D1, decided) and the fixes of the two "Engine change" known gaps.

## 2. Delete inventory

"Owner" says who removes it if not S9; S9 verifies by grep. Paths are repo-relative.

### 2.1 `backend/` (the whole tree, with three things to rescue first)

| What | Rescue / action |
|---|---|
| `backend/public/cast-receiver.html` | **Not Nest code.** `fliks-server` serves it at `/cast` (`server/crates/server/src/http/static_files.rs:110-112`, `config.rs:75` default `FLIKS_CAST_DIR=public`). Consumers of the path: `Dockerfile:139`, `docker-compose.dev.example.yml:109,125`, `macos/Scripts/build-app.sh:194`, `macos/Fliks/Services/NodeManager.swift:224`, `windows/Scripts/build-app.ps1:97-99`, `windows/Fliks.Tray/Services/NodeManager.cs:33`, `server/parity/README.md:25`. Move it first (own commit, `git mv`) to `server/public/cast-receiver.html` (decided, section 14 item 2: it keeps the `public` default and the Docker `COPY`). Byte-identical: the parity scenario `bootstrap/cast-receiver-static.json` compares the whole body, so it proves the move. The root `cast-receiver/` directory is a different thing (Cast Console receiver deployed by `deploy-cast-receiver.yml`); do not merge them |
| `backend/assets/prowlarr-definitions/**` (549 files), `backend/scripts/sync-prowlarr-definitions.sh`, `backend/scripts/package-plugin.ts` | Referenced only by `backend/package.json`, `docs/plugins.md`, `examples/plugin-scaffold/{package.json,README.md}` (no `backend/src` file reads the definitions). They belong to the plugin world: S8 decides (`fk-plugin-download` repo or SDK). S9 deletes whatever S8 left, after `grep -rn 'prowlarr-definitions\|package-plugin' .` shows no consumer outside `backend/`, `docs/plugins.md` and `examples/` |
| `backend/docs/subtitles/gemini-translation-plan.md` | Delete (the port is specified in `translation.md`); `git mv` it to `plan/` instead if the user wants the history kept in the tree [assumed: delete] |
| everything else: `src/` (539 module files, 87 common, 82 migrations, `main.ts`, `app.module.ts`, `data-source.ts`, `types/`), `test/` (jest e2e + setup, `server-vectors/{_util,acl,edl,release-quality}.ts` plus every harness S5-S8 added), `scripts/dump-routes.ts`, `package.json`, `package-lock.json`, `tsconfig*.json`, `nest-cli.json`, `eslint.config.mjs`, `.prettierrc`, `.env.example`, `README.md` (Nest boilerplate), `CLAUDE.md`, `probe-refute.spec.ts.txt` | `git rm -r backend`. The `backend/CLAUDE.md` rules (engine owns streaming/jobs, no local fallback) are already carried by the root `CLAUDE.md` Engine section and `server/docs/spec/engine-glue.md`; nothing to migrate |

Before the deletion commit, create the annotated tag `nest-final` on the commit that still has `backend/` (the parent of the first S9 deletion) and push it with the PR (decided, section 14 item 1): the `[ts:path:line]` tags of all `server/docs/spec/*.md` then resolve with `git show nest-final:backend/<path>`, and the TS vector harnesses stay regenerable. The tag name does not match the `v*` triggers of `docker-publish.yml`, `macos-server-dmg.yml`, `windows-installer.yml`.

### 2.2 Generated or Nest-owned files outside `backend/`

| File | Action |
|---|---|
| `backend/src/modules/engine/schema.d.ts` (generated, never read) | goes with `backend/`; its generator is next row |
| `scripts/bump-engine.sh` | drop `schema=` (line 11), `gen_schema` (13-17), `release_schema` (19-22), the `--schema` mode (36-39), the `gen_schema` call of `--local` (27) and the last line `release_schema "$v"` (58). Keep: `engine.lock` + `ENGINE_IMAGE` + Cargo tag rewrite (43-55), `--local` (patch config). In the `--local` heredoc (30-33) and the `cargo update` (56) drop `fliks-engine` (the lib dependency, section 2.3); `sed` at line 55 already matches `fliks-engine(-core)?` and then only touches `fliks-engine-core`. Header comment (lines 2-6) rewritten |
| `.github/workflows/engine-schema.yml` | Keep **only** the first step ("Server engine tags match engine.lock", lines 23-29) with the loop reduced to `fliks-engine-core`; delete the openapi.json lookup, `setup-node`, `npm ci`, `bump-engine.sh --schema` and the `git diff` (lines 31-53); drop the `backend/src/modules/engine/**` trigger (line 9). The step also checks `ARG ENGINE_IMAGE` in `Dockerfile` against `engine.lock` (today nothing does) and `Dockerfile` joins the triggers. Rename the workflow `Engine lock` (file `engine-lock.yml`) so the name stays true |
| `.github/workflows/backend.yml` | delete (the whole file runs `npm test` in `backend/`) |
| `.github/workflows/db-migrations.yml` | delete (decided, section 14 item 7): its TypeORM drift step (`setup-node`/`npm ci` 51-57, drift 61-92) is the point of the job, and what remains (`cargo run -p fliks-server -- migrate` on a fresh Postgres 18, line 59) is already executed by the `sqlx offline cache is current` step of `server.yml` (lines 58-72, `.sqlx` is committed) and by every `#[sqlx::test]`. Move nothing |
| `.github/workflows/plugin-contract-asset.yml` | deleted at S8, replaced by tagging the SDK crate (S8 spec "Deletes in Nest"); nothing left for S9 |
| `.github/release-please-config.json` | remove the three `backend/package*.json` extra-files (lines 10-24: `backend/package.json` `$.version`, `backend/package-lock.json` `$.version` and `$.packages[''].version`). Everything else stays (`server/Cargo.toml`, `server/Cargo.lock` entries for `fliks-server` and `fliks_domain`, client, desktop, macOS plist, Android/iOS, `cast-receiver/index.html`, `appletv/project.yml`) |
| `.github/workflows/windows-installer.yml` | line 53 resolves the dev version with `node -p "require('./backend/package.json').version"`; read it from `.github/.release-please-manifest.json` instead (`jq -r '."."'`, decided, section 14 item 9). Drop `backend/package-lock.json` (line 63), the `backend/dist` and `backend/node_modules` cache paths (99-100), the `backend/**` terms of the `win-web` key (101), the `Build backend` step (117-122); reword the comments naming Node or the backend (2, 7, 90). `setup-node` and the client build stay |
| `.github/workflows/macos-server-dmg.yml` | drop `backend/package-lock.json` (line 54), the `Build backend` step (86-92), the "client + backend" comment (47) and the "Fetch vendored Node.js 24" comment (74); the step itself stays (it fetches PostgreSQL and ffmpeg). `setup-node` and the client build stay |
| `.github/workflows/docker-publish.yml`, `commit-lint.yml`, `native-build.yml`, `desktop-release.yml`, `android-publish.yml`, `appstore-publish.yml`, `tvos-publish.yml`, `tizen-publish.yml`, `webos-publish.yml`, `deploy-cast-receiver.yml`, `server.yml` | no Nest reference (grepped); Node there is the client, desktop or release tooling. `server.yml` stays as is except its comment "No query! macros yet" (line 57), which is stale since S1 [assumed: fix only if the S9 PR touches the file anyway] |
| `.github/release-please-config.json` + `.github/.release-please-manifest.json` | version handling: section 9 |
| `server/contract/nest-routes.json` and the `contract/` directory | delete; `tests/routes.rs` loses its manifest (section 2.3) |
| `server/docs/bridge.md` | delete after precondition 4 holds |
| `.gitignore:63` (`/backend/images/`), `.dockerignore:7-9` (`backend/.env*`) | delete the lines |
| `.claude/settings.json:8` (`Read(backend/src/modules/engine/schema.d.ts)` deny) | delete the line |
| `.claude/agents/port-server.md` ("Port one Nest domain", bridges, `npx jest`) | delete: the strangler agent has nothing left to port |
| `tools/sym:13` (`SRC=(backend/src … backend/CLAUDE.md)`) and its comment at line 8 | drop the two Nest entries |
| `client/tsconfig.json:18`, `client/tsconfig.app.json:11-12`, `client/tsconfig.spec.json:15` (`../backend/src/common/plugin-contract/ui-contribution.ts`), `Dockerfile:14-15`, `docker-compose.dev.example.yml:142-143` | S8 repoints them to the `ts-rs` output (plan §15). S9 only verifies with the repo-wide grep of section 8; a survivor means S8 missed it and S9 fixes it in the same PR |
| `examples/plugin-scaffold/**` (`file:../../backend/src/common/plugin-contract`), `docs/plugins.md:166,185,344` | deleted (scaffold) and rewritten (docs) at S8: the docs point at the SDK's examples. Same verification |
| `client/src/app/shared/components/media-info-header/media-info-header.spec.ts:31`, `appletv/Sources/Core/Streaming/DeviceProfile.swift:16,27` (comments pointing at `backend/…`) | repoint to the Rust equivalent (`server/crates/domain/src/acl.rs`, the playback-info DTO in `server/crates/server/src/stream/`) or drop the pointer [assumed] |
| `plan/*.md` (`playback-qoe.plan.md`, `local-media-without-metadata.md`) | historical plans, left as they are; the grep of section 8 excludes `plan/` |

### 2.3 Rust side (`server/`)

Rows already deleted by S5-S8 are skipped by the re-grep. What S9 owns by the `bridge.md` "Removed" column is marked **S9**.

| File:line (ed47b977) | What | Action |
|---|---|---|
| `crates/server/src/nest.rs` (33 lines) | `nest::url`, `nest::spawn` (the `fliks_engine::supervise::run` of the Nest child with `JWT_SECRET`, `FLIKS_HOST_URL`, `FLIKS_SERVER_URL`, `FLIKS_BRIDGE_TOKEN`) | delete; `lib.rs:15` `pub mod nest` |
| `crates/server/src/bridge.rs` (171 lines) | `Bridge` client (`/internal/bridge/*`, **S9**) and `Bridge::check`, the bearer check every Rust-side bridge route uses | delete; `lib.rs:4`; `state.rs:3,15,35` (`bridge` field, `Bridge::new(&nest::url(&cfg), …)`) |
| `crates/server/src/lib.rs:32,64,86-88,101-103` | `Upstream::parse(&nest::url(&cfg))`, "bind before spawning Nest", `nest::spawn`, awaiting the Nest handle | drop; `serve` keeps bind, `auth::spawn_jobs`, `axum::serve` with graceful shutdown. `supervise::shutdown_signal` (line 96) comes from the `fliks-engine` lib: replace by a local `shutdown_signal()` (SIGTERM or SIGINT on unix, `ctrl_c` elsewhere; the engine's own is 12 lines, `crates/engine/src/supervise.rs:8-18`; tokio's `signal` feature is already enabled in `crates/server/Cargo.toml:27`) |
| `crates/server/src/app.rs:13,177-213,237-246` | `RouteTable`/`Upstream`/`gateway::router` forwarder, `preflight_here`, `/api/media/sync-queue` special case (203-204, plan S6), the `any_service(unowned)` fold over every OpenAPI path (205-209), the three `/api` catch-alls (210-212), `internal_404` and its three routes (192-194) | `router(state, client_dir, cast_dir, cors_origin)` loses the `nest: Upstream` parameter. Unmatched `/api`, `/api/` and `/api/{*rest}` answer `static_files::cannot(&req)` (`http/static_files.rs:103-107`, Nest's `Cannot <METHOD> <url>` 404, the body Nest gave for an unmapped route) with the same layers as owned routes. A method Rust does not own on an owned path (today forwarded to Nest by the 205-209 fold, which answered that same 404) must keep that 404: without the fold axum answers 405 with an empty body, a contract change. Set `method_not_allowed_fallback` to `cannot` on the router (axum 0.8). `internal_404` goes with the bridges: `/internal/**` falls to the SPA fallback, as it did before the strangler (`Cannot GET` only when no client dir is set); scenario `bootstrap/internal-routes-not-served.json` is deleted with it, or kept if it still passes (it does when `SERVE_STATIC_PATH` is unset, which is how parity runs) [assumed: delete]. Doc comment "A route is ported iff it is listed here (plan §4.3)" (line 21) rewritten: the OpenAPI document is now the full list |
| `crates/server/src/config.rs:62-69,94-97` and the `Config` fields `nest_url`, `nest_cmd`, `nest_port`, `bridge_token`; `DEFAULT_NEST_CMD`; tests at 125, 166-198 | env `FLIKS_NEST_URL`, `FLIKS_NEST_CMD`, `FLIKS_NODE_BIN`, `FLIKS_NEST_ENTRY`, `FLIKS_NEST_PORT`, `FLIKS_BRIDGE_TOKEN` | delete; `random_hex` stays (`jwt_secret.rs:50`, `engine/mod.rs:140`) |
| `crates/server/src/events/routes.rs:31-35`, `events/mod.rs:1-2` | `/internal/events`, `/internal/events/stream`, `/internal/events/progress`, `/internal/activity`, `/internal/activity/claim` (**S9**; `progress` leaves at S8) | delete the five handlers and their bearer checks; the hub, SSE and activity registry stay (`events-hub.md`) |
| `crates/server/src/settings/routes.rs:74-85,154` | `st.bridge.settings_changed` fan-out to Nest listeners (**S9**) and its "loudly logged" failure path | delete; the PUT keeps its in-process listeners (engine config push, etc.) |
| `crates/server/src/engine/remote.rs:29,39,209`, `engine/resolve.rs:408-423`, `stream/preroll.rs:43`, `notifications/mod.rs:27`, `qoe/routes.rs:34-39`, `auth/routes.rs:45,433-439` | `/internal/engine/livetv-config`, resolver `live` delegate to Nest, pre-roll call, `/internal/jobs/sprite`, `/internal/scan/source`, `/internal/notifications/dispatch`, six `/internal/qoe/*`, `/internal/auth/stream-token` | owned by S7 / S5 / S8 / S4-S8 per `bridge.md` "Removed"; S9 expects none left and fails the gate if `grep -rn '"/internal' server/crates` finds one |
| `crates/server/Cargo.toml:40` | `fliks-engine = { git = …, tag = "v0.3.2" }` (the engine **binary crate as a library**: gateway + supervise, pulled in whole) | delete the line; **keep** `fliks-engine-core` (line 30). Users of the lib: `lib.rs:32`, `nest.rs`, `app.rs:13`, and `Upstream::parse("http://127.0.0.1:1")` in `stream/tests.rs:74`, `engine/http_tests.rs:112,917`, `tests/{roles,social,settings,playlists,libraries,notifications,routes}.rs` (each loses the argument of `app::router` and the helper that built it). `Cargo.lock` regenerates (drops the engine's transitive tree); `libc`/`windows-sys` stay (`libraries/path.rs:21,39`, `qoe/mod.rs:188`) |
| `crates/server/tests/routes.rs` (whole file, 4 tests over the manifest, the forwarder and `fake_nest`) | strangler ownership invariants | replace by one test: every `ApiDoc` operation answers on its path (not 404); an unknown `/api/x` and every method an owned path does not declare (the loop of `methods_rust_does_not_own_on_owned_paths_are_forwarded`) answer the Nest-shaped 404 `Cannot <METHOD> <url>`, never 405; no manifest |
| `crates/server/tests/topology.rs` (`fake_nest`, `start(nest_url)`, tests 136-232) | spawn/restart/fallback/`/internal` blocking of the Nest child | delete all but `rust_serves_the_spa_and_the_cast_receiver`, (line 233), which loses the fake Nest and keeps `FLIKS_CAST_DIR` (line 242). The `kill -9` survival check is the release-gate item 3, not a test |
| `crates/server/tests/events_bridge.rs`, `tests/notifications.rs:91`, `tests/auth_routes.rs:338`, `tests/playback.rs:19`, `tests/settings.rs:21-23`, `src/qoe/tests.rs:187`, `src/stream/tests.rs:67,520-530`, `src/engine/http_tests.rs` (33 `nest`/`bridge` hits: 104-105, 295, 528-546, 906-907) | tests of the bridges and their auth | delete the bridge cases; keep the non-bridge cases of the same files |
| comments naming Nest as the *reference behaviour* (`http/error.rs:6`, `http/validate.rs:1`, `auth_token.rs:1`, `jwt_secret.rs:1`, `paths.rs:1`, …) | wire-compat explanations | **keep** (they say why a byte layout is what it is); reword only a comment that describes the deleted spawn/bridge/forward (`events/mod.rs:1-2`, `auth/routes.rs:433`, `engine/resolve.rs:408`, `engine/remote.rs:209`) |
| `server/CLAUDE.md` | "Rust app replacing Nest", the §0 "delete Nest / bridges" paragraph, "Never read … `schema.d.ts`", "Layout (empty until later milestones)" | rewrite for a single-process server: crates, commands, docs list, rules that still apply (spec first, no workaround, contract frozen, deviations) |

**Kept on purpose** (it looks like Nest, it is the upgrade path): `server/crates/server/src/db/migrate.rs` `adopt_typeorm` (a 4.x database has a TypeORM `migrations` ledger forever; release-gate item 1), `server/migrations/*.sql` (85 files, baseline first), `tests/migrations.rs` with `tests/fixtures/typeorm-81.sql`, the `.jwt-secret` file path and `$2b$` bcrypt writing (existing installs), `FLIKS_SUPERVISED`, `FLIKS_CONF_DIR`/`FLIKS_DATA_DIR`/`FLIKS_IMAGES_DIR`/`FLIKS_CACHE_DIR`/`FLIKS_TRANSCODE_DIR` semantics, `server/fixtures/**`, `server/parity/**`. The root CLAUDE.md "Dev database re-baseline" section stays under that exact title: `adopt_typeorm` refuses a `synchronize`-built database with an error that points at it (`db/migrate.rs:56`); only `dc stop backend server` becomes `dc stop server`.

### 2.4 Dev stack

`docker-compose.dev.example.yml`: delete the `backend` service (lines 11-61), the `tmpfs`/`volumes` of the client for `backend/…plugin-contract` (142-143), `FLIKS_NEST_URL` (108), `FLIKS_BRIDGE_TOKEN` (112), `FLIKS_CAST_DIR`/mount of `backend/public` (109, 125 → `server/public`), the `depends_on` of `server` on nothing else; `JWT_SECRET`/`CORS_ORIGIN` stay on `server`. The backend's `user:` (32) and its media mounts `./.dev/downloads`, `./.dev/medias`, `./.dev/data:/src/data` (60-62) move to `server`: from S5 the Rust server scans, ingests and writes images there. Header comment (lines 1-8) rewritten (engine front door on :3000, `server` behind it on :3001). `Dockerfile` `dev` stage (99-105) and its comment go with it; the `server-dev` stage stays. `FLIKS_DATA_DIR` (line 54) moves to `server` (`paths.rs` reads it); `FLIKS_TRANSCODE_DIR` (line 53) does not: only the engine reads it, and the dev engine keeps its own default.

## 3. Dockerfile (plan §9.1, after S9)

Result, stage by stage (line numbers of ed47b977):

- **Header** (line 2 "backend + client") reworded.
- **Stage 1 `client-build`** stays (Node is a build-time dependency of the Angular client only); drop line 14-15 if S8 did not.
- **Stage 2 `backend-build`** (18-24): delete.
- **Stage 2b `vobsub-ocr-build`** (26-37) and `COPY --from=vobsub-ocr-build` (96-97): redundant, delete. The engine image (`fliks-engine/Dockerfile` on main) already builds and ships `subtile-ocr` with `libtesseract` and `tesseract-ocr-all`, `pgsrip` (+ `opencv-python-headless`), `python3`, `mkvtoolnix`; the fliks runtime stage copies the same binary a second time. Verify with `docker run --rm --entrypoint sh <engine image> -c 'command -v subtile-ocr pgsrip mkvmerge tesseract'`.
- **Stage 2c `server-build`** (39-46) stays.
- **`runtime-base`** (49-97): `FROM ${ENGINE_IMAGE}`; delete the nodesource block (58-63). The host-only apt block (66-94) shrinks to what the Rust server still spawns: `postgresql-client` from PGDG (pg_dump/pg_restore for backup and restore, S5 `system.md`; keep the PGDG comment), `ca-certificates`. Delete `tesseract-ocr`, `tesseract-ocr-all`, `python3-dev`, `gcc`, `libc6-dev`, `wget` (purged anyway) and the `opencv` dance if D1 below is resolved; `procps` stays until `grep -rn "Command::new(\"p\(s\|kill\|grep\)\")" server/crates` shows no caller [assumed: unused]. **Keep `bash` and `grep`** (they come from the ubuntu base): the TrueNAS healthcheck is `set_test("http", …)`, which the catalog library renders as a `/bin/bash -c '… 0<>/dev/tcp/…' | grep` one-liner (the app's vendored `templates/library/base_v2_3_16/healthcheck.py:191-198`, `lib_version` 2.3.16).
  - **D1 (cross-repo dependency, blocks the python removal; decided, section 14 item 6)**: the engine's sync job runs `ffsubsync` from `PATH` (`crates/engine/src/jobs/sync.rs:145,202`) and the engine image does **not** install it (it installs only `pgsrip`); today only the fliks Dockerfile does (`pip install ffsubsync pgsrip`, line 83). Fixed at the owner (plan §0 rule 3): an engine PR adds `ffsubsync` to `fliks-engine/Dockerfile` and ships in a release **before S9**; S9 bumps `engine.lock` to it and then drops python/pip/ffsubsync/pgsrip/opencv from the fliks image. Without ffsubsync the engine silently falls back to alass (`jobs/sync.rs:1`), so until that release is pinned the fliks image keeps the `pip install` line: never delete a tool the engine still execs.
  - The `alass` binary download (88-91) is dead weight: the engine links the `alass-util` crate (`crates/engine/Cargo.toml:35`) and never execs `alass` (`git grep '"alass"'` on engine main finds no call) [assumed; re-run the grep against the pinned engine tag before deleting].
- **`dev` stage** (99-105): delete (`npm ci` of the backend). `runtime-base`'s comments "plus node and the subtitle/OCR/backup tools node still runs" (49) and "Split out so the dev compose can build it as-is with `target: runtime-base`" (50) are stale: nothing builds that target once `dev` is gone; reword.
- **`engine-dev`, `server-dev`** stay.
- **`runtime`** (127-175): delete `npm ci` (131-133), `COPY --from=backend-build /app/dist` (135-136), `ENV NODE_ENV=production` (147), `ENV FLIKS_NEST_CMD="node dist/main"` (149); `COPY backend/public ./public` (139) becomes `COPY server/public ./public`; the comment at 144 ("served by the backend") and 175 ("which spawns Nest") reworded. `HEALTHCHECK` (172-173) and `CMD` (176) unchanged: `fliks-server healthcheck` is `lib.rs:108-122`, no Node in it.
- `.dockerignore`: remove `backend/.env*` (7-9); `server/target` stays.
- Not done here, noted for the PR description: image size before/after and idle RSS (release gate item 6).

Exit grep for the Dockerfile and the bundles is in section 8.

## 4. Native bundles (plan §9.2)

Both bundles keep PostgreSQL, ffmpeg, the client build, `fliks-engine` (checksummed from `engine.lock`), and `fliks-server` (built in the script). They lose Node and `backend/`.

### 4.1 macOS (`macos/`)

| File:line | Action |
|---|---|
| `Scripts/fetch-vendored.sh:7,17,28-42,117` | delete the Node.js download (`NODE_VERSION`, tarball, the `[skip]`/`[done]` block) and the `node:` line of the summary; header "Downloads to ../Vendored/{node,postgresql,ffmpeg}/" loses `node`. An existing `macos/Vendored/node` of a developer is simply unused (gitignored, `.gitignore:93`) |
| `Scripts/build-app.sh:7,13,35-36,52` | prerequisites and `--skip-web` text ("client + backend"), the "Vendored Node.js not found" guard and the version echo |
| `Scripts/build-app.sh:65-70` | delete `Building NestJS backend` (the client build at 59-63 stays: Node is its build tool) |
| `Scripts/build-app.sh:103,105-108` | `rm -rf "$RESOURCES/node" …/backend …` and the node copy; the cleanup list keeps `postgres`, `ffmpeg`, `client` and gains the old `node`/`backend` names for one release so a stale `Resources` is wiped [assumed: drop them at the next major] |
| `Scripts/build-app.sh:110-126` | engine and server land in `$RESOURCES/node/bin/`. Rename the directory to `$RESOURCES/bin/` (decided, section 14 item 3): the bundle directory called `node` would be a lie |
| `Scripts/build-app.sh:188-194` | delete the `Backend` block (dist, node_modules, package.json, public). The cast page goes to `$RESOURCES/cast/` (copied from `server/public`) and `FLIKS_CAST_DIR` points there [assumed] |
| `Scripts/build-app.sh:219-220,238-255` | comments naming `.node` addons; the whole "Node must carry allow-jit" verification (238-249); the Homebrew-link scan (253-257) scoped to `bin/postgres/ffmpeg` and its comment about `backend/node_modules` |
| `project.yml:43-51`, `Fliks/Fliks.entitlements` | `com.apple.security.cs.allow-jit` and `…allow-unsigned-executable-memory` were added for V8 ("Node's V8 JIT"); drop `allow-jit`; `allow-unsigned-executable-memory`, which wasmtime needs (it maps plugin code writable then executable with `mprotect`, no `MAP_JIT`), moves to `bin/fliks-server` alone (`Scripts/fliks-server.entitlements`, picked by `build-app.sh`'s `sign`); the app and every other binary keep only `disable-library-validation` (relocated Homebrew dylibs of postgres/ffmpeg) (user decision 2026-10-18, section 14 item 8). The proof is notarization plus a clean-Mac launch of the signed DMG (release gate item 2), and that launch must exercise the two other code generators in the bundle: a pluginApi 2 plugin installed and run (wasmtime/Cranelift in `fliks-server`, S8, writes executable memory) and `ls Resources/postgres/lib/postgresql/llvmjit*` empty (else `jit=off` for the bundled postgres). If the plugin fails under the hardened runtime, keep `allow-jit` (or `allow-unsigned-executable-memory`) and reword the comment |
| `Fliks/Services/NodeManager.swift` → `ServerManager.swift` (git mv) | type `NodeManager` → `ServerManager`, `NodeError` → `ServerError` (`timeout`, `missingEngine`; messages "Server did not become ready in time"), `BackendEnvironment` → `ServerEnvironment`. Delete: `prepareWorkingDirectory` (155-175: symlinks `dist`, `node_modules`, `package.json` into the data dir) and instead remove those three stale links once at start (`try? removeItem`) so an upgraded install does not keep dangling symlinks [assumed]; the env keys `NODE_ENV`, `UV_THREADPOOL_SIZE`, `FLIKS_NODE_BIN`, `FLIKS_NEST_ENTRY` (209-227), `nodeBin` in `PATH` (205-208, 221); `Paths.nodeBinary`, `effectiveBackend*`. Keep: `fliks-engine --supervise --public-listen … --upstream … -- <bin>/fliks-server` launch, the `kill(-pid, SIGKILL)` process-group cleanup, readiness polling of `/api/system/liveness` (177-193), `PATH` = ffmpeg + pg bin + system, `FLIKS_CAST_DIR`, `FLIKS_CONF_DIR`, `SERVE_STATIC_PATH`, `DB_*`, `PORT`, `TMDB/TVDB` keys, the **cwd = data dir** (existing installs keep `images/`, `backups/` there: `paths.rs:14-25`). Log file `backend-<date>.log` (138) → `server-<date>.log`, log lines `node:` → `server:` (see C-S9-1) |
| `Fliks/State/AppState.swift:6,16,22,34,46-56,75-84,106-118,142-144`, `Fliks/State/ServerState.swift:3,7,16,27,36`, `Fliks/MenuBar/MenuBarView.swift:64`, `Fliks/App/FliksApp.swift:21` | `nodeManager` → `serverManager`, `handleNodeCrash` → `handleServerCrash`, `ServerState.startingBackend` → `.startingServer`, comments "Node.js backend", "Postgres + Node" (`ServerState.swift:3`, `FliksApp.swift:21`), `Services/PostgresManager.swift:151` ("the backend also does this") |
| `Fliks/Utilities/Paths.swift:26-27,38-62,101-152` | delete the `nodeBinary` lookup chain (bundle, Vendored, Homebrew `node@24/node@22/node`, PATH) and `backendDir/Dist/Modules/PackageJSON` + `effective*`; the engine path (59-62) resolves from the new `bin` dir; the dev-checkout detection (123-131) keys on `backend/package.json`: key on `server/Cargo.toml` |
| `Fliks.xcodeproj/project.pbxproj` (committed; 4 `NodeManager` refs) | regenerate with `xcodegen generate` in the same commit as the rename |
| `README.md:33-44,85-87,92,102,112,146` | build steps, "Fetch vendored Node.js" section, "Node.js starts the NestJS backend", menu text "PostgreSQL and Node.js", the file tree |

### 4.2 Windows (`windows/`)

| File:line | Action |
|---|---|
| `Scripts/fetch-vendored.ps1:6,8,20,48-58,75,83,94,116` | delete the Node.js block (`$NodeVersion`, `node\node.exe`), the `node` dir from the MSVC-runtime copy loop (83; `pgsql\bin` stays) and the "postgres/node may crash" wording, the `--version` call (116) |
| `Scripts/build-app.ps1:6-8,12,27,38-46,58,70-71,73,77,81-84,91-99` | description, `-SkipWeb` text, the vendored-node guard (27), `Building NestJS backend` (42-46; client build at 36-40 stays), the `Copy-Tree` comment about `node_modules`, `node\node.exe` copy, engine and server destinations `node\fliks-engine.exe` / `node\fliks-server.exe` → `bin\…` [assumed name], the whole `backend` block (91-99), cast page → `cast\` |
| `Fliks.Tray/Services/NodeManager.cs` → `ServerManager.cs` | `NodeManager` → `ServerManager`, `BackendEnvironment` → `ServerEnvironment` (keep `FLIKS_SUPERVISED=1`, `system.md` rule 6); delete `NODE_ENV`, `UV_THREADPOOL_SIZE`, `FLIKS_NODE_BIN`, `FLIKS_NEST_ENTRY` (22-35), `nodeDir` in `PATH` (14-17); `FLIKS_CAST_DIR` from `AppPaths`; log `backend-<date>.log` (141) → `server-<date>.log`; spawn log (70) |
| `Fliks.Tray/Utilities/AppPaths.cs:6,24-35,45,50-54,62,82` | delete `NodeExe`, `BackendMainJs`; `EngineExe` resolves beside `fliks-server.exe` in `bin\`; `FindRepoRoot` (82) keys on `server\Cargo.toml` instead of `backend\package.json` |
| `Fliks.Tray/State/AppState.cs:7,13,16,38,54,65-68,99,133-144`, `ServerState.cs` | `_node` → `_server`, `HandleNodeCrash` → `HandleServerCrash`, `StartingBackend` → `StartingServer`, path log line (54), text "Node backend", `ServerState.cs:13` ("Postgres + Node"); comments `Services/UpdateService.cs:36` ("postgres and node must already be stopped") and `Services/PostgresManager.cs:133` |
| `README.md:17,27,39,50,55,68,78-79,107` | architecture table row "Code discovery" (obsolete: no `node_modules`), prerequisites ("Node.js (for building client)"), launch description, menu text, "Backend cwd" → "Server cwd" |

Both rename sets keep the **user data** paths (`Application Support/Fliks`, `%LOCALAPPDATA%\Fliks Server\…`), the PostgreSQL data dir and ports, and the browser URL `http://localhost:4848`: an upgrade over an installed 4.x app must find its database and `conf/.jwt-secret` where they were. Velopack (Windows) and the DMG (macOS) replace the app directory, so the `node` → `bin` directory rename cannot leave a stale copy [assumed; the release-gate install over 4.5.0 checks it].

## 5. Golden vectors and parity without Nest

Nest was the oracle twice: TS harnesses generated `server/fixtures/<set>/cases.json` (`backend/test/server-vectors/*.ts`, helper `_util.ts:emit`), and parity scenarios were recorded against a Nest on :4850 (`server/parity/README.md`, `tests/parity.rs:454-506`). After S9 both become **recorded references**; nothing regenerates them from Nest.

1. **Vectors.** `cases.json` files are frozen inputs and expected outputs, replayed by `crates/domain/tests/*.rs`. Delete the generators with `backend/`; `nest-final` (section 2.1) keeps them reachable. Add `server/fixtures/README.md` (one paragraph): provenance (generated from Nest at `nest-final`), "expected values are not regenerated from Rust", and the rule below. The `BLESS=1` switch of the replay tests (`crates/domain/tests/{acl,burn_in,edl,notifications,qoe,release_quality,…}.rs`) rewrites `expected` **from Rust output**: after S9 that is the self-fulfilling edit. Rule [new, process]: a changed `expected` is only accepted in a PR whose description names the deviation row (F/C) it implements; the PR template line and `server/CLAUDE.md` say so. No code change to `BLESS`.
2. **Parity.** The 916 scenario files under `server/parity/scenarios/**` (20 directories) keep their Nest-recorded `expect` and replay against `fliks-server` alone (default `PARITY_TARGET=http://127.0.0.1:4849`, `tests/parity.rs:568`); the "Rust in front of Nest" replay setup in `parity/README.md` (the `cd ../backend … npm run build` block, `FLIKS_CAST_DIR=$PWD/../backend/public`, the Nest-on-:4850 record block) is replaced by the single-process setup: `fliks-server` with a scratch `DB_NAME`, the shared engine on :4860 for `engine:up`, none for `engine:down`. Both engine modes still run (`PARITY_ENGINE`); the shared-engine and scratch-DB rules of the agent brief are unchanged.
3. **Record mode.** `PARITY_RECORD=1` (`tests/parity.rs:569,505-506`) would now record Rust against Rust. Rule (decided, section 14 item 4): record mode only fills a step whose `expect` is absent (new scenarios), never overwrites; a changed `expect` in an existing non-deviation scenario is a red flag in review and needs the F/C row (`deviation` scenarios already hand-write `expect`, line 475 `record && sc["deviation"].is_null()`). Smallest change: guard the overwrite at line 506.
4. **No Nest target in code.** `tests/parity.rs` has no Nest-specific branch beyond the env names (`grep -n 'nest\|Nest' tests/parity.rs` shows only the error-envelope comment at 220); the harness, `media-gen.sh`, `seed/` and the template-DB flow are unchanged. `fixtures/playback-info/engine-playback.recorded.json` (engine-recorded) is untouched.
5. **What replaces "full parity with Nest up"**: the milestone gate wording "full parity passes through fliks-server" becomes "full parity passes against fliks-server, engine up and down, 0 fail, 0 DEVIATION-DIFF"; the count of scenarios must not drop below the count at the S9 base (`find server/parity/scenarios -name '*.json' | wc -l`, 916 now) except the scenarios deleted with a bridge (`internal-routes-not-served`, and any scenario S5-S8 recorded for a bridge) which the PR lists.
6. **Nest jest specs** are not ported: deleted with `backend/` (plan §11 "No jest port"). Vector sets exist where a spec carried logic worth keeping (plan §5.2); the S9 PR verifies each `Vectors/parity` section of `server/docs/spec/*.md` that promised a vector set has its `cases.json` (`ls server/fixtures`) before the harness disappears: any promised-but-missing set is generated **before** the deletion commit or the promise is struck out in that spec.

## 6. Docs to update

| File | Change |
|---|---|
| `README.md:179,184-186` | "Ships with: backend, web client, FFmpeg" → "server, web client, FFmpeg"; "The image is a single container: NestJS backend, …" → Rust server (`fliks-server` behind the engine); "From source: anywhere Node runs" (line 182) → "anywhere Rust and Node (client build) run" [assumed wording]. Any "Node 24" prerequisite in the install section (grep `Node`) |
| `CLAUDE.md` (root) | Engine section: line 11 (`EngineService.runJob` is Nest code) → the Rust engine client module; line 14 (`schema.d.ts`) deleted; line 12 ("rewrites `engine.lock` … and the `ENGINE_IMAGE`") keep; line 15 dev stack: engine → `server` only, no Nest; `dc stop backend server` (line 22) → `dc stop server`; `Commit conventions` unchanged |
| `server/CLAUDE.md`, `server/docs/README.md`, `server/docs/spec/` | `server/CLAUDE.md` per section 2.3; `docs/README.md`: tag legend gets "`[ts:path:line]` resolves in git tag `nest-final`: `git show nest-final:backend/<path>`"; spec index: add `node-removal.md`; "Deviations" intro keeps "Each has a parity exception"; delete the link to `bridge.md`; README rows F-S9/C-S9 numbered at merge. **Specs are not rewritten**: their `[ts:]` tags and "Bridges"/"Deletes in Nest" sections are the historical record of each port |
| `docs/plugins.md` (rewritten), `examples/plugin-scaffold/**` (deleted) | S8 (verify only) |
| `macos/README.md`, `windows/README.md` | section 4 |
| `desktop/CLAUDE.md:206-212` ("Testing against a backend": docker `fliks-backend-1`, `npm run start:dev`, `backend/src` bind mount, "Nest application successfully started", JWT `change-me-in-production`) | rewrite for the dev stack (`server` + engine on :3000, `JWT_SECRET: dev-secret` from the compose example) |
| `server/docs/client-audit.md:8`, `server/docs/spec/system.md:94` | cite `macos/Fliks/Services/NodeManager.swift:184` and `windows/…/NodeManager.cs:178,28`: after the rename those are `ServerManager`; update the file names only |
| `docker-compose.example.yml` | no Node/Nest key, but the `mem_limit` comment (39-41: "Node reads the cgroup limit and sizes its heap") explains a Node behaviour: reword it for the engine's ffmpeg budget. Line 89 `FLIKS_OPENCL_DEVICE` is an engine variable; `THUMB_HWACCEL_DEVICE` (90) is read by no code (engine docs only): delete it. Check the whole file against the env audit (section 8, item 6) |
| `CHANGELOG.md` | generated by release-please; never edited |

## 7. TrueNAS catalog (plan §9.3)

**Who and how.** The user, with the `truenas-publish` skill: fork `clementdelestre/apps`, branch off `master`, PR `fliks: <summary>` on `truenas/apps`, only `ix-dev/community/fliks/` touched, never `item.yaml`/`templates/library/`/`lib_version_hash`. A normal release needs no PR: renovate bumps `ix_values.yaml` `images.image.tag` (digest-pinned) and `app.yaml` `version`/`app_version` daily. Only a **schema** change needs a PR; this release has one. The PR is prepared by an agent during S9 (docs/YAML only, validated with the three local commands of the skill) and opened **right after the release tag** (decided, section 14 item 5).

**Catalog state read on 2026-10-16** (version `1.1.16`, `app_version` 4.5.0, tag 4.5.0 from before the engine): compose template runs one `fliks` container + `postgres` + `permissions`; healthcheck `c1.healthcheck.set_test("http", {port, path: "/api/system/liveness"})`; env `PORT`, `DB_*`, `FLIKS_CONF_DIR`, `FLIKS_DATA_DIR`, `FLIKS_TRANSCODE_DIR`, `FLIKS_DISABLE_UPDATE_CHECK`, plus the user's `additional_envs`; no `command:` override; no Node-specific question or variable. `questions.yaml` resources: `limits.cpus` default **2**, `limits.memory` default **4096** MB (lines 779-805).

**What changes** (every item is a decision, the third column says who decides):

| Field (file) | Change | Decision |
|---|---|---|
| image tag (`ix_values.yaml`) | the new major (5.0.0): **renovate does this** after the release; do not hand-edit unless the PR must land first | renovate |
| healthcheck (`templates/docker-compose.yaml`) | **none needed**: it is the bash `/dev/tcp` HTTP probe on `/api/system/liveness`, served by Rust since S0. The stale note in the skill file ("`healthcheck.set_custom_test` with `node -e`, runtime image has no curl") no longer matches the catalog; the user updates the skill. What the image must keep: `bash` and `grep` (section 3) | none |
| `resources.limits.cpus` default (`questions.yaml:790-796`) | **revisit the 2-CPU default** (user, 2026-10-14). The CPU limit is the ffmpeg slot budget: the engine sizes slots at `cores − 1`, at least 1, from `available_parallelism`, which applies the cgroup quota (`crates/engine/src/slots.rs:7-17`). At 2 CPUs that is **one** software slot (when the `ffmpegSlots` setting is unset), and a 4K HDR software tonemap is below realtime on 2 cores. Default **4** (3 slots), decided (section 14 item 5). Only new installs get a new default; existing installs keep their stored 2. A migration that forces it would override a deliberate setting: none proposed |
| `resources.limits.memory` default (`questions.yaml:797-803`) | keep 4096 MB: measured ~650-730 MB per 4K HDR transcode (user note, 2026-10-14). Node's removal frees RSS but the floor is **measured, not guessed**: release-gate item 6 records idle RSS of engine + fliks-server + PostgreSQL; lower the default only if that number justifies it (decided, section 14 item 5) |
| `-threads` from the cgroup quota | engine side, **not a catalog field**: the engine passes `-threads` from `slots::cpu_quota()` (`crates/engine/src/live.rs:638`, `runtime.rs:1035,1116`; `args/output.rs:379`, `args/encode.rs:620`) which is `available_parallelism`. Release-gate item 5 checks it end to end under `--cpus=N`; if a path still lets ffmpeg count host cores, that is an engine fix before the release (plan: "Release" row), not a workaround here |
| GPU-aware slot budget | after the release (plan "Après release" row); out of scope |
| `app.yaml` `version` | a **minor** bump (1.2.0), not a patch: renovate patch-bumps on image updates and would collide (skill, "Editing") |
| `docker-compose.example.yml:42` (`# mem_limit: 4g`, no cpus line) | add a commented `# cpus: '4'` next to it with the slot explanation (the catalog default) |

Ordering (decided): the catalog PR is opened right after the release tag. Renovate may publish 5.0.0 with `cpus: 2` before it merges; that only affects installs made in between (existing installs keep their stored value either way), so no hold is needed.

## 8. Exit greps and checks

Run at the end of the S9 PR (milestone gate part) and again on the release commit. Each must print nothing unless stated.

```bash
# 1. Node, Nest and backend gone from the image and the bundles; the one allowed line is the client build stage
grep -niE '\bnode(\.js|\.exe)?\b|node_modules|\bnest(js)?\b|\bbackend\b' Dockerfile | grep -v 'FROM node:24-alpine AS client-build'
grep -rniE '\bnode(\.js|\.exe)?\b|node_modules|\bnest(js)?\b|\bbackend\b' macos/Scripts macos/Fliks macos/project.yml windows/Scripts windows/Fliks.Tray windows/Fliks.Setup docker-compose.dev.example.yml \
  | grep -vE 'ServerManager\.swift:.*"node_modules"|/src/client/node_modules|# 4\.x layout, wiped for one release'   # 4.x leftovers removed at start, the client's dev tmpfs
# 2. no reference to a deleted file, variable or type anywhere outside history (specs, plan/, CHANGELOG)
grep -rnIE 'FLIKS_NEST|FLIKS_BRIDGE|FLIKS_NODE_BIN|FLIKS_SERVER_URL|nest-routes|server-vectors|server/contract|NodeManager|BackendEnvironment|backend/(src|test|scripts|public|package)|schema\.d\.ts|dump-routes' \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=plan --exclude=CHANGELOG.md --exclude=package-lock.json . | grep -v '^\./server/docs/'
# 3. no /internal route, no Nest upstream in Rust
grep -rn '"/internal\|nest::\|fliks_engine::\|gateway::' server/crates
# 4. the engine lib dependency is gone, the core one stays: prints exactly one line
grep -n '^fliks-engine' server/crates/server/Cargo.toml
# 5. bridge registry deleted; contract directory deleted
test ! -e server/docs/bridge.md && test ! -e server/contract && test ! -e backend && echo ok
# 6. env audit: every variable set by the Dockerfile, both compose examples, the TrueNAS compose template, ServerEnvironment (mac, win) is read by the Rust server or the engine
for v in $(grep -hoE '\b(FLIKS|STREAM|DB|JWT|CORS|SERVE|TMDB|TVDB|REFRESH|THUMB|TRANSCODE)_[A-Z_]+\b' Dockerfile docker-compose.example.yml docker-compose.dev.example.yml macos/Fliks/Services/ServerManager.swift windows/Fliks.Tray/Services/ServerManager.cs | sort -u); do
  grep -rqF "\"$v\"" server/crates || echo "unread: $v"; done      # prints names the engine owns (FLIKS_OPENCL_DEVICE) and compose-only ones (FLIKS_UID, FLIKS_ENGINE_SRC), reviewed by hand
```

Check 2 leaves out `server/docs/` (the specs, the README Deviations rows and `client-audit.md` cite `backend/…` as history, resolvable at `nest-final`; section 6 lists the edits there) and does not match `plugin-contract`: the client keeps the `@fliks/plugin-ui` alias, repointed by S8. Check 6 exists because the catalog and the bundles set `FLIKS_TRANSCODE_DIR`, `FLIKS_DISABLE_UPDATE_CHECK`, `TMDB_API_KEY`/`TVDB_API_KEY`, `FLIKS_SUPERVISED`: at ed47b977 `server/crates` does not read them yet (their domains are S3-S8), so a variable no code reads is a feature that silently stopped working.

## 9. Versioning and release mechanics

- Current: `.github/.release-please-manifest.json` `"."` = `4.5.0`; `server/Cargo.toml` `workspace.package.version` = `4.5.0`; no tag since `v4.5.0`. The `feat:` commits of S0-S8 would compute a **minor** (4.6.0): the plan says major, and the S8 spec's catalog row already assumes `>=5.0.0 <6.0.0`.
- The S9 squash commit carries a `BREAKING CHANGE:` footer naming what an operator must know (the Node runtime and `FLIKS_NEST_*`/`FLIKS_NODE_BIN` are gone, pluginApi 1 plugins no longer load (S8), `GET /api/system/logs` content, the bundle layout) and `Release-As: 5.0.0` (the override documented in `release-please.yml`). The footer alone already bumps 4.x to 5.0.0 (`release-please.yml` rules); `Release-As` pins it in case another commit's footer is dropped. The repo squashes with `COMMIT_MESSAGES` (the body is every commit message), so both footers go in the **last** commit of the PR and the merger checks they are the final lines of the squash message. `commit-lint` checks the PR commits; `release-parser` checks the squash commit on the push to `main` (`awk 'length>100'` on every body line).
- The release PR is merged **by the user** (memory: never merge the release-please PR on its own). Merging it creates `v5.0.0`, which fires `docker-publish.yml` (tags `5.0.0`, `5.0`, `5`, `latest`), `macos-server-dmg.yml`, `windows-installer.yml`, `plugin-contract-asset.yml` (if S8 left it) and the desktop/store workflows.
- `engine.lock` is bumped in or before the S9 PR to the engine release that has what S9 needs (D1 ffsubsync if done, the `-threads` verification of release-gate item 5); `bump-engine.sh <version>` rewrites `engine.lock`, the `Dockerfile` `ARG ENGINE_IMAGE` and the Cargo tags together; `engine-lock.yml` (with the image check of section 2.2) fails the PR if they disagree.
- `server/Cargo.lock`: `fliks-server` and `fliks_domain` versions are bumped by the release PR (`release-please-config.json`), so the PR touches `Cargo.lock`; the Dockerfile build has no `--locked` (keep), so that edit cannot break it.
- Image size and idle RSS are written in the release PR body (plan release gate); measurement commands in section 10.

## 10. Gates

### 10.1 S9 milestone gate (merge of the S9 PR)

Preconditions of section 1 hold, then:

1. `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` green (CI `server.yml`); `cargo run -p fliks-server -- openapi | diff - server/openapi.json` clean; `.sqlx` offline check green. The count of `#[test]`/`#[sqlx::test]` does not drop except for deleted bridge/topology tests (list them in the PR).
2. Full parity against `fliks-server` alone, engine up and down: 0 fail, 0 DEVIATION-DIFF; scenario count per section 5 item 5.
3. Section 8 greps print nothing.
4. CI workflows that cannot trigger on a PR are dispatched on the branch and green: `gh workflow run docker-publish.yml --ref <branch> -f tag=s9-test` (amd64 only; arm64 is first built by the push to `main` after the merge), `macos-server-dmg.yml` (dispatch), `windows-installer.yml` (also runs on PR through its `server/**`/`windows/**` paths). `docker-publish` is not built by any PR check, so without this the Dockerfile change is unverified.
5. The image built by (4) starts: `docker run` with a scratch Postgres, `curl :4848/api/system/liveness` 200, `curl :4848/` serves the client, `curl :4848/cast/cast-receiver.html` serves the page, `docker exec <c> sh -c 'command -v node'` fails, the TrueNAS probe as the catalog renders it succeeds: `docker exec <c> /bin/bash -c '{ printf "GET /api/system/liveness HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n" >&0; grep "HTTP" | grep -q "200"; } 0<>/dev/tcp/127.0.0.1/4848'`.
6. Web smoke test (Chrome tool, local stack) on the pages the S9 PR touches: none by default (S9 changes no client code); runs only if S8 left client work.

### 10.2 Release gate (after the S9 merge, before merging the release PR; plan §10 "Release gate")

Each item names the check so "done" is observable. Items 1-4 and 6 are the plan's list made concrete, item 8 is the plan's "allows no known gap"; the others are what this spec adds.

1. **Upgrade of a real 4.x dump.** Restore a `pg_dump` of a real 4.5.0 database into a scratch PostgreSQL 18 (never the live one), start the S9 image on it: `fliks-server` boots, `_sqlx_migrations` holds one adopted row per row of the dump's TypeORM `migrations` ledger (at most 81, `adopt_typeorm`, `db/migrate.rs:29-100`, which leaves the `migrations` table itself untouched) plus the new ones, no migration re-ran (row counts of `media`, `media_files`, `users`, `playback_states`, `refresh_tokens` equal before/after; `SELECT count(*) FROM migrations` unchanged), log in with an existing user, play a file. The `.jwt-secret` of that install is reused (sessions survive).
2. **Four deployment targets start and serve the client**: Docker image (10.1 item 5), macOS DMG (notarized, launched from the DMG on a clean user account: menu bar item, Postgres, server, `localhost:4848` serves the UI; no `node` process: `pgrep -fl node` empty), Windows installer (installed, tray, same checks; `Get-Process node` empty), TrueNAS app (installed from the PR branch of the catalog on a TrueNAS box or `ci.py --wait=true` render; healthy, UI loads).
3. **`kill -9` of `fliks-server` mid-playback keeps segments flowing** (plan): start a playback, `kill -9` the server; the engine (parent) restarts it with backoff (`crates/engine/src/supervise.rs`), already-fetched and prefetched segments keep being served, the player does not stall for longer than the restart. Run it in the container and in one native bundle.
4. **Full web + Apple TV smoke** (plan §5.5), including one live TV zap and one subtitle search.
5. **CPU budget**: `docker run --cpus=2` and `--cpus=4`: the engine's slot budget is 1 and 3 (`slots::auto_size`, with `ffmpegSlots` unset; where it is exposed, log or `/v1/capabilities`, is [assumed], check on the pinned engine), a software transcode's ffmpeg argv carries `-threads 2` / `-threads 4` (`ps -o args` on the ffmpeg child). A transcode of a 4K HDR sample at the proposed default records realtime factor in the release PR.
6. **Idle footprint**: image size (`docker image ls`, compared with the 4.5.0 image) and idle RSS (`docker stats --no-stream` after 60 s, engine + server + PostgreSQL) in the release PR body, plus the per-4K-transcode figure if the memory default changes.
7. **TrueNAS catalog PR prepared** (section 7), validated with `ci.py --render-only=true`, `generate_metadata.py`, `port_validation.py`, and its merge ordering agreed.
8. **`bridge.md` and Known gaps empty**: it is deleted (10.1 item 3 and section 8 check 5); `GET /api/system/logs` shows the complete server log (the S9 gap closed); the two "Engine change" gaps are fixed in the pinned engine (failover past a source's `maxStreams`, a live viewer ended on a denial the host cannot attribute), each checked once by hand.
9. **Every Nest route is Rust's, concretely**: section 1 item 3 re-run on the release commit (the manifest is gone, so only the `comm -23` S-prep check applies: prints nothing).
10. **The grep exit** of section 8, run on the release commit.
11. **Version and engine**: the release PR (not merged) proposes `5.0.0`, `engine.lock` equals the Dockerfile `ENGINE_IMAGE` and the Cargo tag, the image's `fliks-engine --version` prints that release.
12. **Rollback note**: the release PR body states that the 4.x → 5.0 upgrade is one-way (new sqlx migrations are not reversible) and that a downgrade needs the pre-upgrade dump; the user is reminded to take it.
13. **First-party plugins published as pluginApi 2** before the release PR is merged: `fk-plugin-download` and `fk-plugin-notify` 1.0.0 are tagged in their repos (release asset `<id>-1.0.0.fkplugin`, unsigned, from `cargo xtask package`), packaged and signed by the catalog's `package-plugin.yml`, and listed in `catalog.json`. Otherwise a 4.x install's download plugin stays `failed incompatible-api` after the upgrade with nothing for auto-update to install (S8 decision 8). The catalog `COMPATIBILITY.md` row for pluginApi 1 is marked retired in the same catalog PR.
14. **Parity known limits are the documented ones only**: the unchecked `after` sub-steps and the residual idle race listed in `server/parity/README.md` (#1754, accepted because Nest-recorded expectations are frozen at S9); no other skipped or unchecked scenario.

## 11. Order of work in the S9 PR (commits)

Scopes per plan §0 rule 7; each commit builds (Rust) or is docs/CI only. Re-grep before each step.

1. `chore(server)`: tag `nest-final` (not a commit; section 14 item 1) and `git mv backend/public/cast-receiver.html server/public/` with the five path consumers (`Dockerfile`, dev compose, `macos`, `windows` scripts and managers' `FLIKS_CAST_DIR`).
2. `refactor(server)`: remove the Nest forwarder, spawn and bridge client (`nest.rs`, `bridge.rs`, `app.rs`, `lib.rs`, `state.rs`, `config.rs` env, the S9-owned `/internal` routes, `settings-changed` call), the `fliks-engine` lib dependency, local `shutdown_signal`, tests (section 2.3). Rust gate: fmt, clippy, workspace tests, openapi diff, `.sqlx`.
3. `test(server)`: parity README single-process, record mode never overwrites, `fixtures/README.md`, deleted bridge scenarios.
4. `refactor(backend)`: `git rm -r backend` + `server/contract/` + `server/docs/bridge.md` (one separate last-of-code commit, as in the S5 brief; `backend/` contents needed by earlier commits are already moved).
5. `ci`: delete `backend.yml`, `db-migrations.yml`; slim `engine-schema.yml` → `engine-lock.yml`; `release-please-config.json`; `windows-installer.yml`, `macos-server-dmg.yml`; `bump-engine.sh`; `.gitignore`, `.dockerignore`, `.claude/settings.json`, `tools/sym`.
6. `build(docker)`: Dockerfile and dev compose (section 3, 2.4).
7. `refactor(macos)` and `refactor(windows)`: scripts, managers rename, paths, entitlements, READMEs.
8. `docs`: README, CLAUDE.md files, `server/docs/README.md` (Deviations rows, tag legend, index), desktop/CLAUDE.md, spec file-name fixups, plan S9 section marked done.
9. TrueNAS PR files prepared outside the repo (clone in the scratchpad), not a commit here.

Commit 4 is the only one that makes `backend/` unavailable to the greps of earlier steps; do the parity/vector verification of section 5 item 6 before it.

## 12. Plan inaccuracies found (S9 section and neighbours)

Fixed in `phase2-plan.md` (companion edit, outside the repo): items 1, 2, 5 in §10 S9; items 3, 4, 6 in §9.1-§9.3 with the section 14 decisions.

1. §10 S9 "Content": "(`nest-routes.json` ⊂ Rust OpenAPI)" states the wrong invariant. The repo asserts the opposite (`tests/routes.rs`, `no_openapi_operation_is_in_the_nest_manifest`: no OpenAPI operation is in the manifest), every milestone removes its routes from the manifest, so the S9 entry condition is a manifest holding only the S9-owned `POST /internal/bridge/settings-changed` (section 1 item 2), plus the S-prep manifest ⊂ OpenAPI check of section 1 item 3.
2. §10 S9 "Content" lists no rescue of `backend/public/cast-receiver.html`, served by Rust and copied by the Dockerfile, both bundles and the dev compose; deleting `backend/` as written breaks `/cast`. Also missing from the list: `backend.yml`, `db-migrations.yml`, `plugin-contract-asset.yml`, the `release-please-config.json` extra-files, `windows-installer.yml:53` (version from `backend/package.json`), `tools/sym`, `.claude/settings.json`, the committed `Fliks.xcodeproj/project.pbxproj`, the macOS entitlements added for V8.
3. §9.1 S9: "Remove python/ffsubsync/pgsrip/tesseract only if the engine image already provides them (verify in `fliks-engine/Dockerfile`)". Verified on engine main: it provides `python3`, `pgsrip`, `tesseract-ocr(-all)`, `mkvtoolnix`, `subtile-ocr`, **not `ffsubsync`**, which the engine execs; the `alass` binary is dead (crate). `postgresql-client` must stay for backups. See D1.
4. §9.2 S9: the bundle directory `node/` (macOS `Resources/node/bin`, Windows `node\`) also holds `fliks-engine` and `fliks-server`; "drop node" is a rename of that directory plus the `FindRepoRoot` and `Paths` dev detection keyed on `backend/package.json`.
5. §10 S9 "Exit": `grep -rn "node" Dockerfile macos/Scripts windows/Scripts shows only the client build stage` is too narrow (the managers, `project.yml`, READMEs and the dev compose also carry Node) and too loose in form ("node" also matches `node_modules`, `Node.js`, `NodeManager` in different shapes). Replaced by the exact commands of section 8.
6. §9.3 S9 "lower the RAM floor in the catalog (measure idle RSS …)" conflicts with the recorded user requirement that the TrueNAS release revisit the **CPU** default (2 CPUs = 1 ffmpeg slot) and keep 4096 MB; the RAM floor is a measurement outcome, the CPU default is the decision. The `truenas-publish` skill's "node -e healthcheck" note is stale: the catalog uses the library's bash `/dev/tcp` probe.

## 13. Deviation rows

None are required by design: S9 deletes the process that served the forwarded routes, and every route keeps its path, status and body. Placeholders (numbering is settled at merge: the next free ids on `main` after S8 are F78 and C152 [assumed until #1753 merges]; none touches the HTTP contract):

| # | Today | After S9 | Client impact |
|---|---|---|---|
| C-S9-1 [assumed] | native bundles write `backend-<date>.log` (macOS `NodeManager.swift:138`, Windows `NodeManager.cs:141`) with Nest's output | `server-<date>.log` with the `fliks-server` and engine output; old files are left, not deleted | none for the API; support instructions that name the file change |
| C-S9-2 [assumed] | `GET /internal/**` answers Nest-shaped 404 even with a client dir (`app.rs:192-194`) | falls to the SPA fallback like any unknown non-`/api` path, as before the strangler (404 `Cannot GET` when no client dir is set) | none |
| F-S9-1 (candidate, only if the S9 porter finds it) | a bridge or `FLIKS_BRIDGE_TOKEN` exposure surviving to release | removed | none |

Any behaviour change found while deleting that touches paths, fields or status shapes is **not** done in S9: it becomes a `[rust-followup]` issue (user rule, 2026-10-16).

## 14. Decisions (user, 2026-10-16)

The open questions of this spec, all answered as proposed:

1. **`nest-final` tag**: an annotated tag on the last commit with `backend/`, pushed with the S9 PR; the README tag legend cites it (section 2.1).
2. **Cast receiver page**: moves to `server/public/cast-receiver.html` (section 2.1); the root `cast-receiver/` stays the Cast Console app.
3. **Bundle directory**: the bundles' `node/` directory becomes `bin/` (section 4).
4. **Parity record mode**: only fills a missing `expect`, never overwrites; a changed `expected`/`expect` needs the F/C row (section 5).
5. **TrueNAS**: default 4 CPUs (3 slots) and 4096 MB until the release-gate measurement says otherwise; the catalog PR is opened right after the release tag (section 7).
6. **D1**: an engine PR adds `ffsubsync` to the engine image, released and pinned before S9 (section 3).
7. **`db-migrations.yml`**: deleted, not reduced (section 2.2).
8. **macOS entitlements** (user decision 2026-10-18): `allow-jit` dropped; `allow-unsigned-executable-memory` kept for wasmtime, on the `bin/fliks-server` signature only; proven by notarization and a clean-Mac launch that also runs a WASM plugin (section 4.1, release gate item 2).
9. **Windows dev version**: read from `.github/.release-please-manifest.json` (section 2.2).

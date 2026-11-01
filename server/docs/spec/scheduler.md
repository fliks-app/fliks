# Spec: scheduler

Auth, CASL and error-body rules are in `auth.md` (cited as "auth rule N"); the `/api/system/*` rest is in `system.md`.

Scope: the `commands` table and its audit wrapper (`run_audited`), the cron runner, the boot sweep, the core jobs (Backup, RefreshMetadata, RefreshMissingMetadata, prune commands, the trigger-only list) and `/api/commands*`. Not here: the subtitle tick (`subtitles.md`), the live TV job bodies (`livetv-sources.md`), plugin manifest crons and the plugin staging sweep (`plugins.md`), pairing / refresh-token prunes, QoE purge and scan backfill, the SSE hub and activity registry (`events-hub.md`). This spec lists and triggers the jobs the first three own.

## Routes

4 routes, all in the commands controller. Class guards `JwtOrApiKeyGuard, PoliciesGuard`. Both policies below are satisfied by `settings.access` or `manage:all` (auth rule 25), so `Read Settings` = `Manage Settings` here.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/commands/schedulers` | `ability.can(Read, 'Settings')`| none | 200, `SchedulerJob[]` (rule 10) | 401, 403 | none |
| `GET /api/commands` | `ability.can(Read, 'Settings')`| query `page?`, `limit?` (rule 20) | 200, `{data: Command[], total: int}` | 401, 403; 400 on malformed numbers | none |
| `POST /api/commands` | `ability.can(Manage, 'Settings')`| body `{name: string}` (rule 14) | 201, the queued `Command` (rule 16) or `{ok: true}` for a plugin job | 400 validation, 400 `Unknown command: <name>. Valid: <list>`, 409 plugin job running, 400 plugin job not triggerable | INSERT `commands`; starts the job in the background; `command.started` / `command.completed` |
| `DELETE /api/commands/history` | `ability.can(Manage, 'Settings')`| none | 200, `{deleted: int}` | 401, 403 | DELETE `commands` (rule 21) |

`SchedulerJob` = `{name: string, cron: string, triggerable: bool, labelKey: string, lastRun: string|null, lastStatus: string|null, nextRun: string, pluginId: string|null}`, every key always present. `Command` = rule 2.

## Rules

### A. The `commands` table

1. Table `commands` (baseline + `1783000000000_align-timestamp-columns-to-timestamptz.sql` + `1786500000000_updated_at_trigger.sql`, so every UPDATE refreshes `updatedAt`): `id serial`, `createdAt`/`updatedAt timestamptz NOT NULL DEFAULT now()`, `name varchar NOT NULL`, `status varchar NOT NULL DEFAULT 'queued'`, `startedOn`/`endedOn timestamptz NULL`, `trigger varchar NOT NULL DEFAULT 'manual'`, `body jsonb NULL`. No index beyond the PK, no enum.
2. Vocabulary: `status` in `queued|running|completed|failed`; `trigger` in `manual|scheduled|auto` (`auto` only from marker detection). `body` is written only by `IntroDetection` (`{seasonId, mediaId, seasonNumber}`, markers spec); every other producer leaves it `null`, and lists return it as stored. The status page shows `body.mediaTitle` when present, a key no producer writes. Row JSON in lists: `{id, createdAt, updatedAt, name, status, startedOn, endedOn, trigger, body}`, dates ISO-8601 with ms and `Z`, nullable columns as `null` (never absent).
3. Names written: the core names of rules 10 and 15, `IntroDetection`, `ImportWatchHistory`, `ImportSeerrRequests`, the three `LiveTv*` crons, plus nothing for plugin jobs (rule 13). The last three families insert their rows through rule 5.

### B. Audit wrapper

4. `run_audited(name, trigger, fn)` (scheduled and in-process callers): INSERT a row `{name, status:'running', trigger, startedOn: now}`; emit `command.started {name}`; run `fn`; on `Err` log `Command <name> error: <message>` at error level (the message is not stored; `body` stays null) and set `status='failed'`, else `'completed'`; always set `endedOn = now`, UPDATE the row, emit `command.completed {name, status}`; the error is swallowed (never propagates to the cron tick).
5. API for other domains (`fliks_server::jobs::run_audited`): every domain that audits work (`IntroDetection`, `ImportWatchHistory`, `ImportSeerrRequests`, live TV) calls this one function; there is one copy of the lifecycle. `IntroDetection` is the one producer that creates a `queued` row first and updates it by id (markers spec); it uses the update helpers of rule 6, not `run_audited`.
6. Manual path (`POST /commands`): INSERT `{name, status:'queued', trigger:'manual'}` and answer; then, detached from the request: UPDATE `status='running', startedOn=now`; emit `command.started {name}`; run the job body; UPDATE `status='completed'|'failed', endedOn=now`; emit `command.completed {name, status}`; on failure log `Command <name> failed: <message>` (the message is not stored). The only differences from rule 4 are the `queued` stage and `trigger='manual'`.

### C. Boot sweep and cron runner

7. Boot: `UPDATE commands SET status='failed', "endedOn"=now() WHERE status IN ('running','queued')`; when rows were touched, warn `Marked <n> stale command(s) as failed on startup`. It runs after migrations and before the cron runner starts, so no row of this boot is swept.
8. Cron runner: one in-process task per scheduled job (Jobs/timers), expressions in 5-field form exactly as in rule 10 (`croner`; a seconds field is accepted for plugin crons), evaluated in the server time zone (rule 9). A tick fires the job through rule 4 (`trigger='scheduled'`). No catch-up: a job whose time passed while the server was down is not run. A tick whose job is still queued or running in this process is skipped with a warn. Shutdown stops the timers and does not wait for a running job; its row is swept at the next boot (rule 7). On a DST-change day every valid local fire time fires (`0 04 * * *` in `Europe/Paris` fires on 2026-03-29) and `nextRun` shows it.
9. Server time zone: the process zone, resolved from `TZ` as an IANA name with `chrono-tz`, else `/etc/localtime`, else UTC; `nextRun` and the cron runner use the same zone object.

### D. `GET /commands/schedulers`

10. Core entries, in this order, `triggerable: true`, `pluginId: null`. All five are fired by Rust (rules 22, 23, 30, 31).

    | name | cron (verbatim string) | labelKey |
    |---|---|---|
    | `Backup` | `0 02 * * *` | `system.cmd_backup` |
    | `RefreshMetadata` | `0 04 * * *` | `system.cmd_refresh_metadata` |
    | `RefreshPluginSources` | `0 3 * * *` | `system.cmd_refresh_plugin_sources` |
    | `SubtitleSearch` | `0 0-23/6 * * *` | `system.cmd_subtitle_search` |
    | `SubtitleUpgrade` | `0 0-23/6 * * *` | `system.cmd_subtitle_upgrade` |
    | `MediaCleanup` | `0 05 * * *` | `system.cmd_media_cleanup` |

    The cron strings are verbatim, part of the contract; the client shows them.
11. After the core five come the live TV jobs in this order (`LiveTvSourceRefresh`, `LiveTvGuideRefresh`, `LiveTvGuidePrune`, `pluginId: null`, `lastRun`/`lastStatus` from `commands` like core), then the plugin-declared jobs `{name, cron, triggerable, labelKey, lastRun: null, lastStatus: null, pluginId}` (a plugin's runs have no `commands` row, rule 13).
12. `lastRun` / `lastStatus` = `startedOn` / `status` of the newest row of that name by `createdAt` (a `queued` row gives `lastRun: null, lastStatus: 'queued'`), else both `null`; one query for all non-plugin names (SQL). `nextRun` = next fire time strictly after now, computed in the zone of rule 9 and serialized as UTC ISO-8601 with ms and `Z`.
13. A plugin job never gets a `commands` row: core owns that trail, the plugin's run does not.

### E. `POST /commands`

14. Body `{name: string}` (empty string passes); a missing or non-string `name` → 400 with the validation array, an unknown extra key → 400 (whitelist + forbid, bootstrap rule 2).
15. Known names, in this order: triggerable core schedulers (rule 10), the live TV jobs, then the trigger-only list `RescanAll, RefreshMissingMetadata, RescanMissingFiles, GenerateSprites, GenerateMissingSprites, DetectMarkers, DetectMissingMarkers`. Not in it: a declared plugin job (→ plugin branch, rule 18), else 400 `Unknown command: <name>. Valid: <names joined by ", ">`. Names are case-sensitive; `IntroDetection`, `ImportWatchHistory` etc. are not triggerable here.
16. Response 201 is the whole queued row, as `GET /commands` lists it: `{id, createdAt, updatedAt, name, status:'queued', startedOn:null, endedOn:null, trigger:'manual', body:null}`. A plugin job answers 201 `{ok: true}` and no row.
17. Dispatch (rule 6 around it): `Backup` → rule 22; `RefreshMetadata` → 23; `RefreshMissingMetadata` → 25; `RescanAll`, `RescanMissingFiles` → 27; `GenerateSprites`, `GenerateMissingSprites` → 28; `DetectMarkers`, `DetectMissingMarkers` → 29; `RefreshPluginSources` → 30; `SubtitleSearch`, `SubtitleUpgrade` → 31; `LiveTv*` → the live TV job bodies (`livetv-sources.md`).
18. A declared plugin job is classified before the core names are tried and has no row: `jobs::Running` is claimed, the job starts detached and the route answers 201 `{ok:true}`; already running → 409 `Job "<name>" is already running`; unknown or not triggerable → 400 `Job "<name>" is unknown job` / `Job "<name>" is not triggerable`.
19. A command already `queued`/`running` in this process (a `jobs::Running` claim) answers 409 `Command "<name>" is already running`. The same claims cover the subtitle tick (`subtitles.md` rule 55) and the plugin jobs and scheduled calls (`plugins.md` rules 50, 55). The web status page shows the 409 through its generic error toast.

### F. List and clear

20. `GET /commands`: `p = max(1, int(page) or 1)`, `l = min(100, max(1, int(limit) or 25))`; `ORDER BY "createdAt" DESC, id DESC OFFSET (p-1)*l LIMIT l`; `total` = count of all rows. Absent, empty and `0` page/limit take the defaults; negative is clamped up; above 100 clamped down. Any non-canonical integer string (`1.5`, `1e1`, `0x10`, ` 7 `) → 400; the same holds for `GET /api/system/logs?limit` (`system.md` rule 27). The client always sends integers.
21. `DELETE /commands/history`: `DELETE FROM commands WHERE status NOT IN ('running','queued')`, log `Command history cleared — <n> row(s) deleted`, answer `{deleted: n}`.

### G. Jobs

22. **Backup** (`Backup`, cron or manual): create a dump through the system spec's `create_backup` (`system.md` rules 17-19), then delete every backup past the newest 7, log `Backup: wrote <filename> (<size> bytes)` plus `, pruned <n> older backup(s)` when any. The direct `POST /api/system/backup` does not prune.
23. **RefreshMetadata** (`RefreshMetadata`, 04:00 or manual): if env `TMDB_API_KEY` is blank after trim, warn `RefreshMetadata: TMDB_API_KEY not configured` and return (row `completed`). Else load every media (Rust: `ORDER BY id`, scalar columns only), keep those with an external id (`external-ids.md` rule 7), then those due (rule 24); log the start counts. For each due media `i`: emit `task.progress {command:'RefreshMetadata', current:i, total, message:title, subject}` (subject = `buildMediaProgressSubject(media)`), activity `upsertRunning('RefreshMetadata','RefreshMetadata',subject,i,total)`, call the media metadata refresh with the id only (`refreshMetadata(id)` reloads the media itself, media spec); a failure warns `RefreshMetadata: failed for "<title>": <message>` and continues. After the loop, when `total > 0`, emit a final `task.progress {current:total, total, message:'RefreshMetadata'}`; the activity row `RefreshMetadata` is removed in a `finally`. No sleep between media. Before anything else it deletes the metadata snapshots expired for more than 30 days (`metadata-orchestrator.md` rule 33).
24. Due test: a media is *settled* when it is a movie released more than 365 days ago (`releaseDate`, the `release` row of `media_release_dates` read as `YYYY-MM-DD`, is UTC midnight of that day; when it is null, `year` (non-zero) as 1 January 00:00 local time; else not settled; a non-null unparsable `releaseDate` is not settled and does not fall back to `year`) or a series with `status='ended'`. Not settled → due. Settled → due when `metadataRefreshedAt` is null or at least 7 days old.
25. **RefreshMissingMetadata** (trigger-only): same `TMDB_API_KEY` guard (`RefreshMissingMetadata: TMDB_API_KEY not configured`). `staleMonths = max(1, parseInt(METADATA_STALE_AFTER_MONTHS or '3', 10) or 3)`; `staleBefore = now - staleMonths` calendar months (local time, day-of-month overflow rolls into the next month). Candidates = identified media (rule 23) that are incomplete (`posterUrl` empty/null, or `overview` empty/null, or a series with no `seasons` row) or never refreshed or `metadataRefreshedAt < staleBefore`. Per candidate the same progress, activity (`RefreshMissingMetadata`) and refresh as rule 23, no sleep, warn `RefreshMissingMetadata: failed for "<title>": <message>`; final progress when `candidates > 0`; summary log.
26. **Prune commands** (`0 03 * * *`, not listed, not triggerable, no row, no event): `DELETE FROM commands WHERE "createdAt" < now() - interval '720 hours'` (30×24 h, not calendar days across DST), log `PruneOldCommands: deleted <n> command(s) older than 30 days`. It also removes a `running` row past the cutoff (none can exist after rule 7).
27. **RescanAll** / **RescanMissingFiles** (trigger-only): `RescanAll` = every media `(id, title, type)`; `RescanMissingFiles` = media whose library has a path and that either have no file (and a non-empty `folderName`: a root-level movie with no file is skipped) or, for a kind with seasons (the registry's `has_seasons`), any file with `episodeId` null. Shared loop: log `<name>: started — <n> media to scan`; pre-register an activity `<name>:<mediaId>` (type `<name>`, parent `<name>`) as pending for every media; per media emit `task.progress {command:name, current:i, total, message:title, subject}`, `upsertRunning(name, name, undefined, i, total)` and `upsertRunning('<name>:<id>', name, subject)`, call the rescan (returns `{added, removed, updated}`), remove the child row in `finally`; a failure counts as skipped and warns `<name>: skipped "<title>": <message>`; final progress when `total > 0`; the parent row is removed in a `finally`; summary `<name>: scanned <ok>/<n> media, <changes> change(s), <skipped> skipped` and, when skipped, a warn. Media are read `ORDER BY id`.
28. **GenerateSprites** (force) / **GenerateMissingSprites** (trigger-only): file ids = all `media_files`. `GenerateSprites` passes `force=true`; `GenerateMissingSprites` passes every id with `force=false` and lets the engine report a cached sprite instead of filtering on sprite metadata. Subjects are resolved in chunks of 1 000 ids (scalar columns of media, episode, season only). Every file is registered as pending `GenerateSprite:<fileId>` (type `GenerateSprite`, parent = command name) up front. Files are processed in batches of 2, concurrently inside a batch: per batch emit `task.progress {command, current:i, total, message: formatted subject of the first file or the command name, subject}`, `upsertRunning(command, command, undefined, i, total)`; each file calls the sprite job (`stream::sprite::generate`, priority `normal` when forced else `low`); a failure warns `Sprite failed for file #<id>: <message>` and, like any `null` result, counts as not generated and always removes its `GenerateSprite:<id>` row. Summary `<command>: generated <g>/<n> sprites`. No final 100 % progress event and no sleep.
29. **DetectMarkers** / **DetectMissingMarkers** (trigger-only): seasons = `markers.listSeasonsForScan(onlyMissing)` (`s."number" > 0`, series only, and for the missing variant at least one episode with a part (`items.md` rule 21) and `markersScannedAt` null; `ORDER BY m.title, s."number"`; markers spec). Pre-register `IntroDetection:<seasonId>` pending (type `IntroDetection`, parent = command name), then per season: progress `{command, current:i, total, message: formatted season subject, subject}`, `upsertRunning(command, command, undefined, i, total)`, `markers.runDetectionInline(seasonId, subject)` (no `commands` row of its own; a season already in detection elsewhere returns `{0, 0}` and counts as scanned, not skipped); counts `introsDetected + outrosDetected`; a failure warns `<command>: skipped "<title>" S<n>: <message>`; final progress when `total > 0`; log `<command>: done — <d> marker(s) saved across <ok>/<n> season(s)`.
30. **RefreshPluginSources** (`0 3 * * *` or manual): runs the plugin catalog refresh then the plugin auto-update (a no-op unless an admin opted in) under the audit row of rule 4 or 6 (`crate::plugins::sources::refresh_and_update`).
31. **SubtitleSearch** / **SubtitleUpgrade**: bodies in `jobs::bodies` (`subtitles::scheduler::{search_missing, upgrade}`). The scheduled firing is the subtitle tick (`subtitles::scheduler::spawn_tick`, every 6 h, gated by the `subtitle_*_interval` settings, each pass under its `jobs::Running` claim) and it writes no `commands` row (only the manual path does); `jobs::runner::spawn` skips both names.
32. Reserved names: a plugin-declared job may not take any core or trigger-only name; registration fails `job-name-conflict` (`job "<name>" collides with a core scheduler job`). It asks `jobs::names` (`plugins.md` rule 9), so every core name is reserved. The name lists of rules 10 and 15 are `jobs::names` (a unit test pins both lists).
33. Events and activity of these jobs (`task.progress`, `command.started`, `command.completed`, `activity.changed`) go through the Rust hub and registry directly. Progress `current` counts items finished before the current one (`i`, not `i+1`).

## SQL

- Boot sweep: `UPDATE commands SET status = 'failed', "endedOn" = now() WHERE status IN ('running','queued')`.
- Insert (scheduled / manual): `INSERT INTO commands (name, status, trigger, "startedOn") VALUES ($1,'running',$2,now()) RETURNING *` / `INSERT INTO commands (name, status, trigger) VALUES ($1,'queued','manual') RETURNING id, "createdAt", "updatedAt", name, status, trigger`.
- Transitions: `UPDATE commands SET status='running', "startedOn"=now() WHERE id=$1`; `UPDATE commands SET status=$2, "endedOn"=now() WHERE id=$1`.
- List: `SELECT * FROM commands ORDER BY "createdAt" DESC, id DESC OFFSET $1 LIMIT $2` + `SELECT count(*) FROM commands`.
- Last run per name: `SELECT DISTINCT ON (name) name, "startedOn", status FROM commands WHERE name = ANY($1) ORDER BY name, "createdAt" DESC, id DESC`.
- Clear: `DELETE FROM commands WHERE status NOT IN ('running','queued')`. Prune: `DELETE FROM commands WHERE "createdAt" < now() - interval '720 hours'`.
- Job inputs (all read-only `SELECT`, `ORDER BY id`): media `(id, title, type, status, the `release` date (`media-details.md` rule 3), year, "metadataRefreshedAt", "posterUrl", overview, the `tmdb`, `tvdb` and `imdb` ids (`external-ids.md` rule 5), "folderName", "libraryId")`; `EXISTS (SELECT 1 FROM item_groups WHERE "mediaId" = m.id)`; `media_files (id, "episodeId", "mediaId")`; libraries `path`; seasons for scan (markers spec).

## Events

Emitted (all broadcast, `events-hub.md` rows 3, 15, 16, 14): `command.started {name}`, `command.completed {name, status:'completed'|'failed'}`, `task.progress {command, current, total, message, subject?}`, `activity.changed` (via the activity registry). Consumed: none.

## Settings keys

None in the `settings` table (the only settings-gated tick is the subtitle one). Environment (`config.md`): `TMDB_API_KEY` (trimmed, blank = not configured), `METADATA_STALE_AFTER_MONTHS` (`max(1, parseInt(raw,10) or 3)`), `TZ`, `DB_*` (backup, `system.md`).

## Jobs/timers

| Job | Owner | Schedule (server TZ) | Setting / env | Behaviour | Audit row |
|---|---|---|---|---|---|
| `Backup` | Rust | `0 02 * * *`, manual | none | rule 22 | `Backup`, `scheduled` / `manual` |
| `RefreshMetadata` | Rust | `0 04 * * *`, manual | `TMDB_API_KEY` | rules 23, 24 | `RefreshMetadata` |
| `PruneOldCommands` | Rust | `0 03 * * *` | none | rule 26 | none |
| `RefreshPluginSources` | Rust | `0 3 * * *`, manual | none | rule 30 | `RefreshPluginSources` |
| `MediaCleanup` | Rust | `0 05 * * *`, manual | `cleanup_max_per_run` | `cleanup.md` rules 11-18 | `MediaCleanup` |
| `RefreshMissingMetadata` | Rust | manual only | `TMDB_API_KEY`, `METADATA_STALE_AFTER_MONTHS` | rule 25 | `RefreshMissingMetadata`, `manual` |
| `RescanAll`, `RescanMissingFiles` | Rust | manual only | none | rule 27 | same name, `manual` |
| `GenerateSprites`, `GenerateMissingSprites` | Rust | manual only | none | rule 28 | same name, `manual` |
| `DetectMarkers`, `DetectMissingMarkers` | Rust | manual only | none | rule 29 | same name, `manual` |
| `SubtitleSearch`, `SubtitleUpgrade` | Rust: tick `0 0-23/6 * * *` with the `jobs::Running` claim, listing and manual via `jobs::bodies` | manual | `subtitle_*` | rule 31 | manual only |
| `LiveTv*` (3) | Rust | `0 0-23/1 * * *` (prune `0 01 * * *`) | per job | `livetv-sources.md` | `LiveTv*` rows through rule 5 |
| Plugin crons, plugin staging | Rust | per job | per job | `plugins.md` | none for plugin jobs |

## Vectors/parity

Vector set `cron-next` (`server/fixtures/cron-next`; the five core strings, hourly-style expressions, a 6-field case, from fixed instants in UTC, `Europe/Paris` and `America/New_York` across both DST changes: expected next three fire times), replayed by the unit test in `crates/server/src/jobs/cron.rs`, which allows a difference only in a window crossing a DST transition. The due and candidate rules (24, 25) are covered by the Rust tests in `crates/domain/src/refresh.rs`. Other unit tests: the job name lists; `run_audited` lifecycle on a scratch DB (completed, failed, events in order); boot sweep; overlap skip; cron runner with a paused clock.

Parity scenarios (`server/parity/scenarios/commands/`; seed has `commands` rows: one of each status, one past the prune cutoff, two with the same `createdAt`): `schedulers` (200, ignore `$..nextRun`, `lastRun`), `schedulers-requires-auth` (401), `schedulers-forbidden` (403), `list-default`, `list-paging` (`page=2&limit=2`, `limit=1000` clamps to 100, `page=0`), `list-malformed` (400), `trigger-unknown` (400 body message), `trigger-validation` (missing / non-string / extra key), `trigger-forbidden` (403), `trigger-refresh-missing-metadata` (201 body keys, then poll `GET /commands` until `completed`, `TMDB_API_KEY` unset), `trigger-twice` (409), `trigger-created`, `clear-history` (200 `{deleted:n}`, running/queued rows kept), `clear-history-forbidden`. Job runs against the generated media under `/tmp/fliks-parity/` only. The Backup job runs only on the scratch database of `system.md` Vectors.

## Open questions

- `TZ` handling (rule 9): if the image has no `tzdata`, libc-based `chrono::Local` silently becomes UTC. Resolve `TZ` through `chrono-tz` explicitly, or ship `tzdata` in the Dockerfile? Needed so `0 02 * * *` keeps meaning local 02:00.
- `GenerateMissingSprites` (rule 28) relies on the engine cache: confirm the engine answers a cached sprite for `force=false` without regenerating.

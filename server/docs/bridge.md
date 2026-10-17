# Bridge registry

Temporary HTTP endpoints between `fliks-server` and Nest during the strangler. Each row is added in the milestone that needs it and removed when the bridge is deleted. Planned list: phase-2 plan §6.4. A feature whose caller or callee moves later may stay broken instead of getting a bridge (plan §0 rule 2): see "Known gaps until Sn".

Auth: `Authorization: Bearer $FLIKS_BRIDGE_TOKEN` (random per boot; constant-time compare). Nest serves bridges under `/internal` (no `api` prefix). Public fallback must 404 `/internal/**`.

| Endpoint | Direction | Payload | Added | Removed |
|---|---|---|---|---|
| `POST /internal/bridge/settings-changed` (Nest) | S1 to S9 | `{keys:string[] (non-empty), origin?:string}`; per key, in order: Nest's change listeners then the `settings.changed` domain event; `engine_url`/`engine_token` in `keys` also makes Nest re-adopt the engine; no DB write; 204 | S1 | S9 |
| `POST /internal/events` (Rust) | S2 to S9 | `{kind:"sse", event:SseEvent, userId?:int, userIds?:int[]}` (none = broadcast, `userId` = `emitToUser` with the household hook, `userIds` = `emitToUsers`), `{kind:"raw", event:{type:"plugin.<id>.<type>", payload}, userIds?:int[]}` (no `userIds` = broadcast), `{kind:"domain", event:DomainEvent}`; 204; Nest `EventsService.emit*` forwards in emit order, never dispatches locally | S2 | S9 |
| `GET /internal/events/stream` (Rust, SSE) | S2 to S9 | `data: {"kind":"sse"\|"raw"\|"domain","event":{...}}` per event of the hub (every audience, `sse.connected` and `ping` excluded), `:` keep-alive comments; Nest re-emits into its in-process `subscribe`/`onDomain` subscribers; at-most-once, Nest reconnects with 0.5 to 15 s backoff | S2 | S9 |
| `GET /internal/events/progress?mediaId=` (Rust) | S2 to S8 | 200 `{downloads: Download[]}` (empty when the cache has nothing); the plugin host's grab placeholder reads it | S2 | S8 |
| `POST /internal/activity` (Rust) | S2 to S9 | `{op:"pending", id, type, subject?, parentId?}`, `{op:"running", id, type, subject?, current?, total?, parentId?}` or `{op:"remove", id}`; 204; Nest's `ActivityRegistryService` queues writes in call order | S2 | S9 |
| `POST /internal/activity/claim` (Rust) | S2 to S9 | `{id, type, subject?, current?, total?, parentId?}`; registers the id as running and answers 204, or 409 when the id is already registered (one lock: two concurrent claims cannot both pass); `ActivityRegistryService.claim` queues it behind the pending writes and maps 409 to `false` (the producers' `409 errors.already_running`) | S2 | S9 |
| `POST /internal/plugins/pre-roll` (Nest) | S2 to S8 | request `{mediaFileId:int, mediaId:int, episodeId?:int\|null, principal:{kind:"delegated", userId:int>=1}}` (bridge bearer); 200 `PreRollItem[]` (`{mediaFileId, labelKey?, skippable?}`), `[]` on any plugin failure; Rust ACL-gates every candidate itself and treats any bridge failure as `[]` | S2 | S8 |
| `POST /internal/notifications/dispatch` (Rust) | S4 to S8 | `{event, payload}`: `event` one of the 18 notification events, `payload` an object, no other keys (else 400); 204 once every matching sender settled (failures logged, never the status); 500 only when the connections SELECT fails. Nest `NotificationsService.dispatch` (never rejects) and `dispatchStrict` (plugin host) call it | S4 | S8 |
| `GET /internal/jobs` (Nest) | S5 to S8 | 200 `{jobs: [{name, cron, triggerable, labelKey, pluginId: string\|null}]}`: the registry jobs (`pluginId: null`) then the plugin-declared jobs; the bridged core name (`RefreshPluginSources`) is not in it; Rust lists it in `GET /api/commands/schedulers` and classifies a `POST /api/commands` name with it, an unreachable bridge shrinks the listing | S5 | S8 |
| `POST /internal/jobs/run` (Nest) | S5 to S8 | `{name}`; `RefreshPluginSources` and registry jobs run the body and answer when it ends (204; 500 `{message}` on a throw; 404 unknown name); a declared plugin job answers at once (202 started, 409 already running, 400 `{message}` = `unknown-job` or `not-triggerable`). The Rust client has no total timeout (connect 2 s only) | S5 | S8 |

Rust bridge auth: `Authorization: Bearer $FLIKS_BRIDGE_TOKEN`, constant-time compare, 401 otherwise (`Bridge::check`). Nest bridge auth: missing `FLIKS_BRIDGE_TOKEN` answers 503 on every `/internal/bridge/*` call, a wrong or absent bearer 401. Nest reaches Rust through `FLIKS_SERVER_URL` (base URL, no trailing slash).

## Allowed duplication

- Library ACL verify in Nest until S8 (`LibrariesService.getAccessibleLibraryIds`, `assertMediaAccessible`, `getCountsByLibrary`, kept for `counts.service.ts` and the plugin guards, read queries only), duplicated by `libraries::accessible_library_ids` / `assert_media_accessible`, the single Rust implementation every route uses; both read the same tables live, so no endpoint.
- Auth verify in Nest until S9: `jwt.strategy.ts`, guards, CASL factory, `PoliciesGuard`, `current-user` decorator, `jwt-secret.ts` (Nest still authenticates its own routes; Rust signs).
- Nest files kept for code that still imports them: the ffprobe wrapper (`modules/media-probe`, the `MediaFile.streamInfo` type) until S9, `modules/media-tools/fps.ts` (the VOD presence) and `modules/media/edl` (the playback-info DTO type) until S9. Rust has its own implementations; each file goes with its last importer.

## Known gaps until Sn

No new temporary bridge: each gap below is a Nest caller that loses a function when its callee moves to Rust, or the reverse. The release gate allows none. The two "Engine change" rows are engine follow-ups (no host workaround, plan §0 rule 3). `POST /internal/ingest` (plan §6.4) is dropped: known gap until S8.

| Until | Gap | Spec |
|---|---|---|
| Engine change (S7 ships without) | A failover onto another source's stream can exceed that source's `maxStreams`: capacity is checked only for the primary stream's source and the hold then follows the feeding upstream, so a down primary also counts against the wrong source until the first attempt event. Fix = a per-upstream capacity veto in the engine (`LiveUpstream.atCapacity`, or a host callback before an attempt on another source); parity with Nest until then | `livetv-sessions.md` rules 8, 24, 36 |
| Engine change (S7 ships without) | The engine ends a live viewer on any resolver denial, including a credential that resolves to no user, which the host cannot attribute to the viewer's owner. Fix = end a live viewer only on a denial for its owner | `livetv-sessions.md` rules 31, 37 |
| S8 | Plugin `library.ingest` throws `unavailable until S8`; plugin imports fail (`POST /internal/ingest` dropped) | `ingest.md`, `media-write.md` |
| S8 | Plugin host loses its profile and scoring reads (`media.acquisitionContext`, `acquisition.candidates`, `releases.score`, `releases.match`, `buildWant`, `scoringWindowFor`, `buildAcquisitionTarget`, `filesForEpisode`/`filesForSeasonPack`): plugin acquisition (search, grab, upgrade) does not work between S5 and S8 | `profiles.md`, `release.md` |
| S8 | `download.complete` triggers no Emby refresh (Nest plugin host) | `media-servers.md` |
| S8 | The plugin host's `requests.markInProgress` has no callee (the Nest lifecycle is gone): a request moves to `processing` only through the `acquisition.grabbed` domain event, which Rust consumes from `POST /internal/events` | `requests.md` |
| S9 | `GET /api/system/logs` shows only `fliks-server`'s own events; Nest lines stay on stdout (plugin lines join the ring from S8, so after S8 it is Nest lines only) | `system.md` |

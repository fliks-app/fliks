# Bridge registry

Temporary HTTP endpoints between `fliks-server` and Nest during the strangler. Each row is added in the milestone that needs it and removed when the bridge is deleted. Planned list: phase-2 plan §6.4. A feature whose caller or callee moves later may stay broken instead of getting a bridge (plan §0 rule 2): see "Known gaps until Sn".

Auth: `Authorization: Bearer $FLIKS_BRIDGE_TOKEN` (random per boot; constant-time compare). Nest serves bridges under `/internal` (no `api` prefix). Public fallback must 404 `/internal/**`.

| Endpoint | Direction | Payload | Added | Removed |
|---|---|---|---|---|
| `POST /internal/bridge/settings-changed` (Nest) | S1 to S9 | `{keys:string[] (non-empty), origin?:string}`; per key, in order: Nest's change listeners then the `settings.changed` domain event; `engine_url`/`engine_token` in `keys` also makes Nest re-adopt the engine; no DB write; 204 | S1 | S9 |
| `POST /internal/events` (Rust) | S2 to S9 | `{kind:"sse", event:SseEvent, userId?:int, userIds?:int[]}` (none = broadcast, `userId` = `emitToUser` with the household hook, `userIds` = `emitToUsers`), `{kind:"raw", event:{type:"plugin.<id>.<type>", payload}, userIds?:int[]}` (no `userIds` = broadcast), `{kind:"domain", event:DomainEvent}`; 204; Nest `EventsService.emit*` forwards in emit order, never dispatches locally | S2 | S9 |
| `GET /internal/events/stream` (Rust, SSE) | S2 to S9 | `data: {"kind":"sse"\|"raw"\|"domain","event":{...}}` per event of the hub (every audience, `sse.connected` and `ping` excluded), `:` keep-alive comments; Nest re-emits into its in-process `subscribe`/`onDomain` subscribers; at-most-once, Nest reconnects with 0.5 to 15 s backoff | S2 | S9 |
| `POST /internal/activity` (Rust) | S2 to S9 | `{op:"pending", id, type, subject?, parentId?}`, `{op:"running", id, type, subject?, current?, total?, parentId?}` or `{op:"remove", id}`; 204; Nest's `ActivityRegistryService` queues writes in call order | S2 | S9 |
| `POST /internal/activity/claim` (Rust) | S2 to S9 | `{id, type, subject?, current?, total?, parentId?}`; registers the id as running and answers 204, or 409 when the id is already registered (one lock: two concurrent claims cannot both pass); `ActivityRegistryService.claim` queues it behind the pending writes and maps 409 to `false` (the producers' `409 errors.already_running`) | S2 | S9 |

Rust bridge auth: `Authorization: Bearer $FLIKS_BRIDGE_TOKEN`, constant-time compare, 401 otherwise (`Bridge::check`). Nest bridge auth: missing `FLIKS_BRIDGE_TOKEN` answers 503 on every `/internal/bridge/*` call, a wrong or absent bearer 401. Nest reaches Rust through `FLIKS_SERVER_URL` (base URL, no trailing slash).

## Allowed duplication

- Auth verify in Nest until S9: `jwt.strategy.ts`, guards, CASL factory, `PoliciesGuard`, `current-user` decorator, `jwt-secret.ts` (Nest still authenticates its own routes; Rust signs).
- Nest files kept for code that still imports them: the ffprobe wrapper (`modules/media-probe`, the `MediaFile.streamInfo` type) until S9, `modules/media-tools/fps.ts` (the VOD presence) and `modules/media/edl` (the playback-info DTO type) until S9. Rust has its own implementations; each file goes with its last importer.

## Known gaps until Sn

No new temporary bridge: each gap below is a Nest caller that loses a function when its callee moves to Rust, or the reverse. The release gate allows none. `POST /internal/ingest` (plan §6.4) is dropped: known gap until S8.

| Until | Gap | Spec |
|---|---|---|
| Accepted ceiling (engine 0.4) | A failover onto a source that filled after the open can exceed its `maxStreams` by one stream: verdicts are taken at open (per-upstream `atCapacity`) and not re-asked per attempt | `livetv-sessions.md` rules 8, 24, 36 |
| S9 | `GET /api/system/logs` shows only `fliks-server`'s own events; Nest lines stay on stdout (plugin lines join the ring from S8, so after S8 it is Nest lines only) | `system.md` |

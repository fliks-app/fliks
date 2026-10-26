# Spec: events hub (SSE) and activity registry

Scope: the hub, its two routes, the event catalogue and the domain bus. The remote routes (`/api/remote/*`, grants, `canControl`) and presence are spec'd in `remote.md`; here only the hub half of them (target registry, attribution, household hook) is stated.

## Routes

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/system/events` | `SessionAuthed`; policy: any authenticated user | `device?`, `ff?`, `tvPlatform?`, `name?` (raw strings, no validation) | `text/event-stream`, status 200, stays open | 401 no/invalid credential or disabled user (rule 1); 403 `session_token_required` (rule 2) | registers the connection, evicts superseded same-`targetId` connections, sends `remote.targets_changed` to the user when `device` is given, then `sse.connected` and the progress-cache replay (rule 9) |
| `POST /api/system/events/ticket` | `SessionAuthed` | none | 201 `{ticket: string, expiresIn: 30}` | 401; 403 `session_token_required` | stores the ticket in memory (rule 1a) |
| `GET /api/system/activity` | `Authed`; policy `ability.can(Action.Read, 'Settings')` | `page?`, `limit?` (raw strings) | `{ data: ActivityRow[]; total: number; dropped: number }` | 401; 403 without `read:Settings` | none |

## Rules

### `GET /api/system/events`: connection

1. Auth runs once at connect (JWT extractor order cookie `fliks_access`, then `Bearer`, then `?token=`; `EventSource` cannot send headers so web uses the cookie, native clients `?token=`). The user must exist and be `enabled` (loaded with its role), else 401. A token expiring or a user being disabled later does not close the stream by itself; only rules 28-30 do.
2. A token with any `scope` claim (only `'stream'` is minted, for both stream and Cast tokens) is rejected: 403 `{"statusCode":403,"message":"session_token_required","error":"Forbidden"}`. No cookie/Bearer/token or invalid: 401 (`auth.md` rule 14 body).
1a. Ticket: `?ticket=` replaces the credential of rule 1. `POST /api/system/events/ticket` mints a 24-byte random value bound to the caller, valid 30 s and once; the connect removes it whatever follows. An unknown, used or expired ticket is 401 (even with a valid token alongside), and the ticket's user must still be `enabled`. Without `ticket`, rules 1-2 apply unchanged, so released native clients (`?token=`) keep working; tickets live in process memory.
3. Query params, all optional, copied into the connection identity: `device` -> `targetId`, `ff` -> `formFactor`, `tvPlatform`, `name` -> `deviceName`; `userAgent` = request `User-Agent` header. Absent is stored as `null` ; an empty `device=` is stored as `""`, which is falsy, so it behaves like absent for the eviction/announce/listing branches.
4. `targetId` is `deviceId#tabNonce` (stable across reconnects, unique per screen). A client with no `device` never becomes a remote target (never listed, never announces).
5. Response headers: `Content-Type: text/event-stream`, `Connection: keep-alive`, `Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0, no-transform`, `Pragma: no-cache`, `Expire: 0` (sic, not `Expires`), `X-Accel-Buffering: no`; status 200; headers flushed immediately. The socket gets keep-alive and no-delay and the idle timeout is disabled.
6. First bytes on the wire are a single blank line `\n`, before any event.
7. Wire format of every message: `event: <type>\n` only when the message has a `type` (only `ping` does), then `id: <n>\n`, then one `data: <line>\n` per line of the payload, then a blank line. `<n>` is a per-connection counter starting at **1** and incremented for every message written, pings included (e.g. `id: 1\ndata: {"a":1}\n\nevent: ping\nid: 2\ndata: 30000\n\n`). No `retry:` line.
8. All events except `ping` are unnamed messages (no `event:` line); `data:` is the JSON of the event: absent fields omitted, `null` kept. Key order is the order at the emitter.
9. On connect, in this order, synchronously (no event can interleave): (a) a fresh `connectionId` = `randomUUID` (v4) is minted; (b) if `targetId` is set, every existing connection of the same user with the same `targetId` is evicted (rule 22); (c) the connection is registered; (d) if `targetId` is set, `remote.targets_changed` is `emit_to_user(userId)` (so the new stream itself is not yet subscribed and does not receive it; the user's other streams and household viewers do); (e) first message to this client: `sse.connected`; (f) replay of the progress cache (rule 14); (g) subscription to the live bus.
10. `sse.connected` payload: `{"type":"sse.connected","connectionId":"<uuid>"}`, delivered only to that connection, never through the bus. The client binds `connectionId` to its live playback sessions (`sseConnectionId`).
11. Ping: every 30 000 ms (first one 30 s after connect, per connection, not aligned) the connection receives the named message `{type:'ping', data:'30000'}`; wire: `event: ping\nid: <n>\ndata: 30000\n\n`. `data` is the interval in ms as a string; the client uses any bytes to reset its idle timeout. The ping carries data on purpose (an empty buffer would be dropped).
12. Delivery filter per event: deliver if the envelope has no audience and no connection list (broadcast); or its `connectionIds` contains this connection id; or its `audience` contains this user id. Otherwise skip.
13. A connection receives only events emitted after step (g) plus the replay of rule 14; there is no `Last-Event-ID` handling and no history.
14. Replay on connect: `snapshot_for(userId)` of the progress cache yields every cached `download.progress` snapshot whose recipients include this user, each written as an ordinary unnamed message, after `sse.connected` and before live events.

### Teardown

15. When the client closes or the hub completes the stream: the ping timer is cleared, the bus subscription removed, the connection deleted; if the connection had a `targetId` (read before deleting; an evicted connection has no entry, so it reads none), `remote.targets_changed` is `emit_to_user(userId)`.
16. Completing the stream ends the HTTP response, which is how a drop becomes visible to the client (it reconnects).
   - 15a. A connection queues at most 1024 frames for its stream (a suspended TV or a stalled proxy would otherwise grow it without bound). The emit that finds the queue full closes the connection like a teardown (stream ends after the queued frames, `remote.targets_changed` announced when it was a target, household hook included); the client reconnects and gets the replay cache again.

### Audiences and emit API

17. `emit(event)`: broadcast to every open connection of every user, regardless of role.
18. `emit_to_user(userId, event)`: connections owned by that user. When the event type is `remote.state`, `remote.targets_changed` or `remote.stopped`, the registered household fan-out hook is also called with `(event, ownerId)`.
19. `register_household_fan_out(fn)` is registered once by the remote service; its behaviour (grantees of the device or owner plus all enabled admins, minus the owner, via `emit_to_users`; 30 s grant cache; `remote.state` and `remote.stopped` scoped to the device id of `targetId`, the part before `#`) belongs to `remote.md`. Because it calls `emit_to_users`, which never invokes the hook, it cannot loop.
20. `emit_to_users(userIds, event)`: connections of those users; an empty list delivers to nobody (an empty array is a non-null audience). No hook.
21. `emit_to_connection(connectionId, event)` returns a boolean. Polled target (key `polled:<targetId>`): pushed to its queue, `true`; if the queue already holds 20 (`POLLED_QUEUE_MAX`) the event is dropped with a warning and `false`. SSE connection unknown: warning, `false`. Otherwise delivered to exactly that connection only. A caller must not fall back to `emit_to_user` for `remote.command` (it would command every device of the user).
   - 21a. `emit_raw(type, payload, audience)` for plugin events: wire event is `{"type":"plugin.<id>.<type>","payload":<payload>}`; `audience: null` broadcasts, else a user-id list.
22. Superseded-connection eviction: on connect with a `targetId`, every other connection of the same `userId` and same `targetId` is deleted from the registry and its stream is closed by the server. It stops being a target, receives no teardown announce and is skipped by `drop_connections_for_*`. Rationale: a killed webview or dropped mobile network sends no FIN. Two tabs of one device have different `targetId` and coexist; connections without `targetId` are never evicted; the same `targetId` under another user is not evicted.
23. Each `emit*` goes through one `dispatch`: when the audience is non-null, a `download.progress` event is recorded into the replay cache with the audience as recipients, and an `import.complete` clears the cache for `(mediaId, seasonNumber, episodeNumber)`. A `download.progress` sent through `emit` (null audience) is not cached. Then the envelope is published on the bus.
24. Backend-internal `subscribe` receives every SSE event envelope's event regardless of audience (including events addressed to one connection through the bus; not polled-queue events and not `sse.connected`/`ping`).

### Progress replay cache (`download.progress`)

25. One entry per `mediaId`: `{event, recipients, recordedAt}`. `record(recipients, event)`: empty `downloads` deletes the entry (an empty snapshot retires the media); otherwise replaces the entry (a snapshot states the whole set; no merge).
26. `clear(mediaId, seasonNumber?, episodeNumber?)`: no entry: no-op; `seasonNumber == null`: delete the media; else keep a download if its season differs, or if an episode is given and the download's episode differs (a download with no `episodeNumber` is a pack and survives a single-episode clear); no downloads left deletes the entry.
27. `snapshot_for(userId)`: walks all entries; any entry older than 3 min (against an injectable clock) is deleted regardless of which user connects; returns the events whose recipients include the user. Not persisted; restart empties it. The first `download.progress` after a grab states the cached set plus a placeholder `ref: "pending:<season>:<episode>"` (producer rule).

### Connection drops (security)

28. `drop_connections_for_user(userId)`: complete the observable of every SSE connection of the user (teardown of rule 15 runs, announcing `remote.targets_changed` per connection that had a target), delete every polled target of the user; if any polled target was dropped, emit `remote.targets_changed` to the user. Log line `Dropped N SSE connection(s) and M polled target(s) for user U` when either count > 0. Evicted connections are already closed (rule 22).
29. Callers: user update when `roleChanging || enabledChanging` (`roleChanging` = `roleId` differs, `enabledChanging` = `enabled` differs; so re-enabling also drops). Not called on `isAdmin` change, library-access change or user deletion, which only revoke the user's engine sessions, nor on a password change (users.md rule 17 drops the user's connections on its own). Logout calls rule 30's target-scoped drop.
30. `drop_connections_for_target(userId, targetId)`: same but scoped to the caller's own device; completes SSE connections matching both, deletes `polled:<targetId>` if owned by the user; nothing found: warning `Logout target scope: no connection for user U target T` and return; polled drop emits `remote.targets_changed`. Called from logout with `payload.sub` of the verified access token (cookie, else Bearer) and the body field `targetId`; no `targetId` in the body: warning, nothing dropped; an invalid/expired access token: nothing dropped.

### Target registry (hub half of remote control)

31. `list_for_user(userId)` / `list_all`: every SSE connection with a non-null `targetId` plus every non-expired polled target, each as `{connectionId,...identity}`, sorted by `since` descending (newest first). The scan itself expires polled targets whose last poll is older than 30 000 ms (`POLLED_TARGET_TTL_MS`): deleted, log `Polled target T stopped polling`, and `remote.targets_changed` emitted to the target's owner. Expiry is lazy (only when a list runs).
32. `register_polled_target(userId, identity)`: refuses a missing `targetId` (warning, no-op). Key `polled:<targetId>`. Re-registration keeps `since` and `queue`, refreshes `lastPoll` and identity; first registration emits `remote.targets_changed` to the user. The key doubles as the connection id. The route derives `targetId = <deviceId>#native` server-side.
33. `drain_commands(userId, targetId)`: unknown target or other owner: `null` (route answers 404 `remote.error_device_offline`); else refresh `lastPoll` (no TTL check), return and clear the queue (each command at most once).
34. `resolve_target(userId, targetId)`: among `list_for_user(userId)`, the newest matching row's `connectionId`, or `null`; more than one match logs a warning. Scoping to the user is the authorization.
35. `target_id_for(connectionId)`: SSE connection's `targetId`, else polled target's, else `null` (also `null` for null/undefined input). `has_connection(id)` is `true` only for SSE connections (not polled).
36. Attribution: `claim_attribution(targetId, userId, mediaFileId)` stores one claim per target (overwrites). `take_attribution(targetId, mediaFileId)`: null target or no claim: `null`; the claim is deleted on any read; older than 60 000 ms (`ATTRIBUTION_TTL_MS`): `null`; file mismatch: `null`; else the claimant's user id. Claimed by `remote.command` `load` with a `mediaFileId` (after delivery); taken by playback-info, which re-claims it (fresh timestamp) when the engine open fails.

### Domain bus (backend to backend)

37. `emit_domain(event)` publishes to the domain bus; a subscriber registers a handler. In-process, at-most-once, no persistence, no replay, no retry; a handler that fails is caught and logged `Domain event handler threw on "<type>": <message>`, never reaching the emitter.
38. Domain event payloads (11 types) are in the Events section. The plugin contract's webhook event list equals the domain event types; adding a domain event requires adding it to the plugin webhook event names too.
39. `settings.changed` exists only as a domain event (emitted after the in-process consumers ran); there is no `settings.changed` SSE event.

### `GET /api/system/activity` and the registry

40. Query: `page` default 1, `limit` default 25; each is parsed with JS `parseInt(x, 10)` semantics and accepted only when finite and `> 0`, else the default (so `page=0`, `page=-3`, `page=abc`, `limit=0` fall back; `limit=1e3` parses as 1; no upper bound on `limit`).
41. Response `{ data, total, dropped }`: `total` = number of top-level rows (a parent and its children count as one), `dropped` = lifetime count of registrations rejected at capacity.
42. Entry shape (JSON order as listed): `id: string`, `type: string`, `subject?: MediaProgressSubject`, `status: 'running'|'pending'`, `current?: number`, `total?: number`, `parentId?: string`; absent fields are omitted from JSON. A top-level row additionally has `children?: ActivityEntry[]` (omitted when empty), children never nest further (a row whose parent is itself a child is in neither list nor `total`). `subject` = `{title: string, mediaId?, mediaType?: string, seasonNumber?, episodeNumber?, episodeTitle?, episodeId?}`.
43. Order: running before pending; inside a status group, ascending insertion sequence `seq`; applied to top-level rows and, separately, to each parent's children. `seq` is assigned on first insert and kept across upserts of the same id (pending to running does not reorder).
44. A child whose `parentId` is absent from the registry is listed as a top-level row. Pagination slices the ordered top-level list `[(page-1)*limit, +limit)`; a page past the end returns `data: []` with the real `total`.
45. `upsert_pending(id, type, subject?, parentId?)` stores `{id, type, subject, status:'pending'}` (a re-upsert of a running id returns it to pending and drops `current/total`); `upsert_running(id, type, subject?, current?, total?, parentId?)` stores status running. `parentId` is sticky: the new `parentId` when given, else the existing one.
46. `has(id)` is a synchronous registry lookup used to refuse duplicate work (`409 errors.already_running`); `claim` registers the work atomically with that check; `remove(id)` deletes and schedules a broadcast only if the id existed.
47. Capacity: 20 000 entries (`MAX_ENTRIES`). A new id at capacity is not stored: `dropped++`, one warning `Activity registry at capacity (20000): "<id>" (and further registrations) will not appear until the registry drains`, never again; an existing id still updates.
48. Change ping: every mutation arms a 250 ms timer if none is armed; when it fires one broadcast `{type:'activity.changed'}` goes out (`emit`, all connections). Mutations inside the window coalesce into that one ping; the next mutation after it fires arms a new timer (no trailing re-arm). The ping has no payload; clients refetch the route.

## SQL

The hub and registry are in-memory: no SQL. Audience resolution for media-scoped events (`viewersForMedia`, `recipientsForMedia`, `adminIds`) is:

1. `viewersForMedia(mediaId)`: `mediaId` null returns `adminIds` (query 3). Else
   ```sql
   SELECT "libraryId" FROM media WHERE id = $1; -- media.library.id, null when no library
   SELECT u.*, r.permissions FROM users u LEFT JOIN roles r ON r.id = u."roleId" WHERE u.enabled = true;
   SELECT "userId" FROM library_user_access WHERE "libraryId" = $libraryId; -- only when libraryId is not null
   ```
   Result: enabled users who have every library (`isAdmin` or role permissions contain `manage:all`), plus (when `libraryId` is not null) users granted in `library_user_access`; when `libraryId` is null only the every-library users. Ids only.
2. `recipientsForMedia(mediaId)`: `SELECT DISTINCT "userId" FROM requests WHERE "mediaId" = $1;` non-empty returns those ids (any request status, disabled users included); empty or `mediaId` null returns `adminIds`.
3. `adminIds`: `SELECT id FROM users WHERE "isAdmin" = true AND enabled = true;` (note: `isAdmin` column only; a role with `manage:all` is not an admin here, unlike the every-library test).

## Events

### Wire events (`SseEvent`, 48 named types + `ping` + `plugin.<id>.<type>`)

Audience legend: B = broadcast to every connection; U(x) = connections of user x (+household hook for the three `remote.*` types); Us(list) = connections of those users; C = one connection. Payload types are TypeScript-style; `?` = may be absent on the wire.

| # | Event | Audience | Payload |
|---|---|---|---|
| 1 | `sse.connected` | C (direct, not via bus) | `{connectionId: string}` |
| 2 | `ping` (named `event: ping`) | per connection | data = `"30000"` (not JSON) |
| 3 | `task.progress` | B | `{command: string, current: number, total: number, message: string, subject?: MediaProgressSubject}` |
| 4 | `subtitle.synced` | B Us(viewersForMedia) | `{subtitleId: number, language: string, mediaId?: number, automatic?: boolean}` |
| 5 | `subtitle.downloaded` | B Us(viewersForMedia) | `{mediaId: number, title: string, language: string, provider: string, subtitleId?: number, reason?: string ('translation'), automatic?: boolean}` |
| 6 | `subtitle.failed` | B Us(viewersForMedia) | `{mediaId: number, title: string, language: string, error: string, reason?: string ('translation'|'rate_limit'), scope?: string ('daily'|'per-minute'), automatic?: boolean}` |
| 7 | `subtitle.list_changed` | B Us(viewersForMedia) | `{mediaId: number}` |
| 8 | `subtitle.translation_progress` | B Us(viewersForMedia) | `{subtitleId: number, mediaId: number, progress: number (0-100)}` |
| 9 | `import.complete` | Us(viewersForMedia) | `{mediaId: number, title: string, seasonNumber?: number, episodeNumber?: number}`; clears the replay cache |
| 10 | `import.failed` | Us(recipientsForMedia) | `{mediaId: number, title: string, error: string}` |
| 11 | `download.progress` | Us(viewersForMedia); skipped when empty; cached for replay | `{mediaId: number, mediaType: 'movie'|'series', downloads: {ref: string, seasonNumber?: number, episodeNumber?: number, progress: number (0-1), dlspeed: number, eta: number, state: DownloadProgressState}[]}` |
| 12 | `stalled.removed` | Us(recipientsForMedia) | `{title: string}` |
| 13 | `queue.updated` | B | `{}` |
| 14 | `activity.changed` | B (debounced 250 ms) | `{}` |
| 15 | `command.started` | B | `{name: string}` |
| 16 | `command.completed` | B | `{name: string, status: string ('completed'|'failed')}` |
| 17 | `rescan.started` | U(requesting admin) | `{mediaId: number, title: string}`; emitted before the `has` check, so a 409 duplicate still announces it |
| 18 | `rescan.completed` | U(requesting admin) | `{mediaId, title, added: number, removed: number, updated: number, subtitleRemovedMissing?: number, subtitleRemovedDuplicates?: number}` |
| 19 | `rescan.failed` | U(requesting admin) | `{mediaId: number, title: string, error: string}` |
| 20 | `media.files.delete_failed` | U(requesting admin) | `{mediaId: number, title: string}` |
| 21 | `player.command` | C (the session's `sseConnectionId` when still connected), else U(session owner) | `{sessionId: string, mediaFileId: number, userId: number, action: 'pause'|'play'|'stop'|'message', message?: string}` |
| 22 | `markers.season.completed` | B | `{mediaId: number, seasonId: number, seasonNumber: number, introsDetected: number}` |
| 23 | `metadata.started` | B | `{mediaId: number, title: string}` |
| 24 | `metadata.refreshed` | B | `{mediaId: number, title: string}` |
| 25 | `metadata.failed` | B | `{mediaId: number, title: string, error: string}` |
| 26 | `watch-history.import.started` | B | `{serverId: number, serverName: string}` |
| 27 | `watch-history.import.completed` | B | `{serverId, serverName, users: number, usersCreated: number, imported: number, skipped: number}` |
| 28 | `watch-history.import.failed` | B | `{serverId: number, serverName: string, error: string}` (`error: ''` on audit-row failure) |
| 29 | `seerr.import.started` | B | `{}` |
| 30 | `seerr.import.completed` | B | `{users: number, usersCreated: number, imported: number, updated: number, skipped: number}` |
| 31 | `seerr.import.failed` | B | `{error: string}` (`''` on audit-row failure) |
| 32 | `pairing.requested` | U(target user) | `{userId: number, pairingId: string, deviceName: string, deviceId: string}` |
| 33 | `remote.command` | C (or polled-target queue) | `{cmdId: string, expiresAt: number (epoch ms, now+10 000), byTargetId: string|null, action: RemoteCommandAction, mediaId?: number, mediaType?: 'movie'|'series', mediaFileId?: number, episodeId?: number, positionSeconds?: number, level?: number, muted?: boolean, trackId?: string, subtitleId?: string|null}`; also carries whatever other validated request fields; JSON key order is the request's fields first, then `type`, `cmdId`, `expiresAt` (`byTargetId` keeps its request position when sent) |
| 34 | `remote.state` | U(owner) + household hook (grantees of the device, admins) | `{targetId: string} & RemoteStatePayload`: `sessionId: string, mediaId: number|null, mediaFileId: number, episodeId: number|null (TS-optional, always sent), mediaTitle: string|null, episodeLabel: string|null, posterUrl: string|null, fanartUrl: string|null, positionSeconds: number, durationSeconds: number, state: 'playing'|'paused'|'buffering', volume: number|null, muted: boolean|null, supportsVolume: boolean, subtitleId: string|null, quality: string|null, qualities: {id: string, label: string, lowBandwidth?: boolean}[]|null, autoplayBlocked: boolean, hasNext: boolean, audioTrackIndex: number|null, subtitleTrackIndex: number|null, lastCmdId: string|null`; sent every heartbeat, ~10 s per playing session |
| 35 | `remote.targets_changed` | U(owner) + household hook | `{}` |
| 36 | `remote.stopped` | U(owner) + household hook (device-scoped) | `{targetId: string}` |
| 37 | `social.followed` / `social.follow_request` | U(target user) | `{userId: number, username: string, avatar: string|null}` |
| 38 | `social.follow_accepted` | U(requester) | `{userId, username, avatar: string|null}` |
| 39 | `social.content_recommended` | U(recipient) | `{userId, username, avatar: string|null, mediaTitle: string}` |
| 40 | `plugin.<pluginId>.<type>` (raw, outside the union) | B, or Us(`[userId]`), or Us(recipientsForMedia) | `{payload: unknown}` (plus `type`) |
| 41 | `party.state` | C (each member of the party) | `{partyId: number, rev: number, state: 'idle'|'waiting'|'paused'|'playing', item: PartyItem, anchor: {position: number, serverTimeMs: number}, whenMs: number|null, by: {userId, username}|null, action: string|null}` (`watch-party.md`) |
| 42 | `party.members` | C (members) | `{partyId, rev, members: PartyMember[]}` |
| 43 | `party.settings` | C (members) | `{partyId, rev, name: string, policy: 'everyone'|'host_only'}` |
| 44 | `party.message` | C (members) | `{partyId, message: PartyMessage}` |
| 45 | `party.reaction` | C (members) | `{partyId, userId, username, emoji: string}` |
| 46 | `party.closed` | C (members) | `{partyId, reason: 'host_ended'|'expired'|'kicked'}` |
| 47 | `party.invited` | Us(invitees) | `{partyId, name, scheduledAt: string|null, host: {userId, username}, item: PartyItem|null}` |
| 48 | `party.starting` | Us(invitees) | `{partyId, name}` |
| 49 | `party.updated` | Us(owner + invitees) | `{partyId}` |
| 50 | `party.signal` | C (one member: the target) | `{partyId, from: {userId, deviceId}, kind: 'offer'|'answer'|'ice'|'bye', data: object}` (`watch-party.md`, Voice) |
| 51 | `party.selection` | C (members) | `{partyId, rev, item: PartyItem|null}` (`watch-party.md`) |

Row 37 is two wire types and row 2 (`ping`) and row 40 are not in the `SseEvent` union, so the table lists 39 `SseEvent` types (the union writes the three `social.followed|follow_request|follow_accepted` as one member at). All `*.started/completed/failed/progress` rows are fire-and-forget; none is retried.

`RemoteCommandAction` = `'load'|'play'|'pause'|'playpause'|'stop'|'seek'|'volume'|'mute'|'next'|'audio'|'subtitle'|'quality'|'browse'`; all absolute except `playpause`.

### Domain events (`DomainEvent`, 11 types, in-process only)

| Event | Payload |
|---|---|
| `media.imported` | `{mediaId: number, tmdbId: number|null, mediaType: string, libraryId: number|null, addedByUserId: number|null}` |
| `media.monitored.changed` | `{mediaId: number, monitored: boolean}` |
| `media.season.monitored.changed` | `{mediaId: number, seasonNumber: number, monitored: boolean}` |
| `media.removed` | `{mediaId: number, tmdbId: number|null, mediaType: string}` |
| `media.files.imported` | `{mediaId: number, seasonNumber?: number, episodeNumber?: number, source: 'download'|'disk'}` |
| `media.acquisition.requested` | `{mediaIds: number[], reason: string}` |
| `acquisition.grabbed` | `{mediaId: number, seasonNumber?: number, episodeNumber?: number}` |
| `request.created` | `{requestId: number, mediaType: string, tmdbId: number, userId: number|null, kind: string, seasons: number[]|null}` |
| `request.approved` | `{requestId: number, mediaId: number|null, mediaType: string, tmdbId: number, seasons: number[]|null, approvedByUserId: number|null}` |
| `library.scan.completed` | `{libraryId: number, added: number, updated: number}` |
| `settings.changed` | `{key: string}` |

### In-process subscribers

Two in-process buses: the SSE bus (`subscribe`, audience-blind) and the domain bus (`emit_domain`). Every subscriber below sees every event of its type, at-most-once. Error isolation (rule 37) covers only the domain bus: a subscriber of the SSE bus catches its own errors.

| Subscriber | Bus | Event types consumed | Effect |
|---|---|---|---|
| request lifecycle | SSE bus | `import.complete` | recompute of open requests for the media |
| request lifecycle | domain bus | `acquisition.grabbed` | APPROVED to PROCESSING for the media and season |
| post-import queue | domain bus | `media.files.imported` | debounce-schedule sprites/markers/scans for the media |
| post-import queue | SSE bus | `rescan.completed` | schedule post-import when `added > 0`, else scan sources |
| plugin webhook dispatcher | domain bus | all 11 domain types (filtered by each plugin's declared webhooks) | HTTP webhook delivery |
| plugin process dispatcher | domain bus | all 11 | NDJSON event to every ready `process` plugin |

Not subscribers: media-server dispatch and notification dispatch are direct calls at the emitting sites, and the settings change consumers are the direct calls of `settings.md` rule 11, not the bus.

## Settings keys

none (the hub reads no setting; `engine_*`/`streaming_*` keys are in `engine-glue.md`).

## Jobs/timers

| Timer | Interval | Behaviour |
|---|---|---|
| Ping | 30 000 ms per connection | rule 11 |
| Activity broadcast debounce | 250 ms | rule 48 |
| Replay-cache sweep | none (swept on `snapshot_for`) | rule 27 |
| Polled-target expiry | none (swept on list), TTL 30 000 ms | rule 31 |
| Attribution TTL | checked on take, 60 000 ms | rule 36 |
| Polled queue bound | 20 events | rule 21 |
| SSE connection queue bound | 1024 frames | rule 15a |

## Vectors/parity

No fixture set. The Rust unit tests in `server/crates/server/src/events/` (hub, replay cache, activity registry) cover the replay cache, the remote target registry, the activity registry, the audience filter, the wire format (rule 7 byte-exact incl. the `id:` counter and the leading blank line) and the 30 s ping with a paused clock.

Parity scenarios: `server/parity/scenarios/events/` (14 files: SSE handshake and auth variants, `remote.targets_changed` and `pairing.requested` delivery, superseded-connection close, activity list, pagination and 403).

## Open questions

None.


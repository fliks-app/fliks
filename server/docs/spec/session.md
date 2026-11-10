# Spec: account session ("continue everywhere")

Scope: the one playback an account has at a time, held by the server so every device of the account can show it, drive it and take it over. Transport (targets, commands, SSE) stays in `remote.md` and `events-hub.md`; live engine sessions stay in `presence.md`; the beat that feeds this is in `heartbeat.md` (rules 22-27). This file owns the table, the preference, the claim, the epoch, the parked state and the two routes.

The account session is opt-in (`users."sessionSync"`, default false). With the option off, or for a kind outside the user's scope, nothing here runs and playback behaves as before.

## Routes

The routes below require a session credential: a `scope:'stream'`/`'cast'` token is rejected with `403 { message: "session_token_required" }` (same as `/api/remote/*`). No CASL policy applies: a caller only ever reaches their own row. 401 for no/invalid credential. Neither route is household-scoped: a grantee or an admin never sees another account's session.

| Method path | Auth | Request | Response | Errors | Side effects |
|---|---|---|---|---|---|
| `GET /api/session` | session-only credential | none | `AccountSessionDto` or JSON `null` (200 either way) | 401, 403 `session_token_required` | evaluates staleness (rule 14): a live row whose owner stopped beating becomes `parked` and `session.changed` is emitted |
| `DELETE /api/session` | session-only credential | none | 204, no body | 401, 403 `session_token_required`, 409 `session.error_not_parked` | deletes a `parked` row and emits `session.changed` with null fields; no row is a 204 no-op |

| `POST /api/session/transfer` | session-only credential | `{ toTargetId: string }` (unknown keys refused) | 202, `{ cmdId: string }` | 401, 403 `session_token_required`, 403 `remote.error_<reason>`, 404 `session.error_no_session`, 404 `remote.error_device_offline`, 400 `remote.error_self_target`, 400 `session.error_not_transferable`, 400 validation | one `remote.command load` to the target's connection (rule 18) |

`POST /api/session/transfer` is for the caller's own account session. The target is authorized exactly like `POST /api/remote/:targetId/command` (`authorizeTarget` then `canControl`, `remote.md` rules 7 and 10): the caller's own devices, a device granted to them, or any device for an admin.

`AccountSessionDto` (every key always present, `null` not absent):

```
{ epoch: number,
  item: { id: number, mediaId: number, episodeId: number|null, mediaFileId: number|null, kind: MediaKind, family: 'video'|'audio'|'text'|'image'|null, title: string|null,
          subtitle: string|null, posterUrl: string|null },
  owner: { targetId: string|null, deviceName: string|null, formFactor: string|null },
  state: 'playing'|'paused'|'buffering'|'parked',
  positionSeconds: number, positionAt: ISO-8601 ms string, playing: boolean,
  durationSeconds: number|null,
  queue: { itemIds: number[], index: number, shuffle: boolean, repeat: 'off'|'all'|'one' }|null }
```

`positionAt` is the server time the position was last reported: observers extrapolate `positionSeconds + (now - positionAt)` while `playing` (`state = 'playing'`). `title` is the media title and `subtitle` the episode or track label, `posterUrl` the same poster the item page uses. `mediaId` and `episodeId` are the routing pair a player needs to open the item: the item's media, and the item itself when it sits in a group (episode, disc), else `null`.

## Data

One row per account, the primary key being the account (`userId`), so the database refuses two sessions.

```sql
CREATE TABLE account_sessions (
  "userId" integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  "sessionId" text NOT NULL,
  epoch bigint NOT NULL,
  "itemId" integer NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  "mediaFileId" integer REFERENCES media_files(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN (<MediaKind::ALL>)),
  state text NOT NULL CHECK (state IN ('playing','paused','buffering','parked')),
  "positionSeconds" double precision NOT NULL,
  "durationSeconds" double precision,
  "ownerTargetId" text, "ownerDeviceName" text, "ownerFormFactor" text,
  queue jsonb,
  "updatedAt" timestamptz NOT NULL DEFAULT now());
```

The kind CHECK lists `MediaKind::ALL` (`items.md` rule 39). `"itemId"` and `"mediaFileId"` carry a covering index (every FK has one). Addressing is item-first: the stored key is `itemId`; the `(mediaId, episodeId)` pair is derived from it when the row is shown or transferred, never stored.

Preference columns of `users`: `"sessionSync" boolean NOT NULL DEFAULT false`; `"sessionKinds" text[]`, `NULL` meaning every kind, with a CHECK that every element is a `MediaKind`. Both are self-writable preferences (`users.md` rule 19) and `PublicUser` keys.

## Rules

Scope
1. A beat is in scope when the account has `sessionSync = true` and its kind is in `sessionKinds` (or `sessionKinds` is null). The account is `attributedUserId ?? user.id` of the live session (the credited account, like the history). The kind is the live session's `mediaType` tag. The preference is read from `users` at the first beat of a sid only (the claim, rule 4), never per beat.
2. Out of scope (option off or kind not selected): the `account_sessions` row is neither created, updated nor superseded, and the beat is answered as before. Presence and remote control are unaffected.
3. Never in scope in this version: live TV, watch parties (a beat whose connection or device is a member of a live party neither claims, updates nor supersedes; its history is written as usual), and sessions of a client with neither an SSE connection nor a polled target (no target id: Subsonic, OPDS, Kobo). A `download=1` session never beats, so nothing excludes it explicitly. A beat with a `playedAt` (offline replay, `heartbeat.md` rule 21) never claims or updates the row.

Claim
4. The claim happens at the first beat of an engine sid that reaches the hub with a target (a sid the hub has never seen), not at `playback-info`: the audio preload opens sessions that never beat before playing and so claims nothing. A sid claims once; the hub remembers it (sid and target) until the engine can no longer revive it after its session ended (`STREAM_SESSION_REVIVE_TTL_MS`), so a device waking inside that window cannot claim again. At boot every stored row's sid is remembered as a claim of its owner target, ended now. A sid found out of scope is remembered until its session ends, so later beats do not read the preference.
5. The decision and the write of the row run under one lock of the hub, so two concurrent claims are serialised: the last one in is the owner, the other is superseded on its next beat. The preference read (rule 1) runs outside the lock: the decision is taken again once it returns, so a slow read holds its own beat, not every account's.
5b. The owner of a beat (target, device name, form factor) never depends on its SSE connection being alive: it is resolved from the connection or polled target the beat names, else from the user's live target whose id the beat names (`targetId`; a bare device id, without `#`, names the device's newest live target), else from the one remembered on the live session from an earlier beat, else the bare `targetId`, unless another login has a live target of that device (a beat never takes a device another account is using). A beat sent while its stream reconnects therefore still claims, updates the row and emits `remote.state`. When the device has a registered native face (`remote.md` rule 21a) every beat of the device is attributed to it, so the owner is its `#native` target, with its real name and form factor, and `remote.command` reaches it through its polled queue.
6. A claim continues the row's owner when it has the same target, or the same device (`deviceIdOf(targetId)`) while the previous owner's target no longer has a live connection or polled registration: a reload changes the tab nonce, its previous tab is gone, and it must not supersede itself; a device's `#native` face and its web layer are one owner whichever is still registered. A second tab of the device, whose first tab is still connected, is another owner. Cases of the first beat of a sid, in order:
   1. no row: insert with `epoch = 1`;
   2. the claim continues the owner (above): the row's `sessionId`, item, file and kind are replaced (next track, next episode, restarted engine session), `epoch` unchanged;
   3. the row is owned by another owner (another device, or another live tab of this one): `epoch += 1`, the row is replaced. When the previous owner was live (`state` not `parked`), `session.superseded` goes to its connection (its command queue when it is a polled target) and its engine session is stopped after `SUPERSEDED_STOP_DELAY` (3 s: until then its beats are answered `superseded`, rule 8). The event is `silent` when the claim is a deliberate hand-over: the claiming beat says `handoff: true` (`heartbeat.md` rule 25b), or a transfer to this target for this item was sent less than `HANDOFF_TTL_MS` (60 s) before (rule 18). Silent changes nothing else: the old device still saves its position and stops, but shows nothing. Otherwise (another device simply started a different playback) it is not silent and the old device tells its user.
7. After any claim, every other account's row whose owner is the claiming device (rule 6) and that is not `parked` becomes `parked` and its account gets `session.changed` (a shared device: a guest credited elsewhere took the screen).
8. A beat of a sid the hub already claimed:
   - the row's `sessionId` is this sid: the current session. Item, file, kind, state, position, duration, queue (when the beat carries one) and the owner target are updated. A `parked` row comes back to the beat's state (a device that recovered within the engine revive window);
   - the row has another sid owned by another device, the sid was superseded by a claim (even of another tab of its own device), or the row's owner changed hands: the session is superseded, whether or not the beat's sender can be identified. The beat is answered `superseded: true`, never writes the row and emits no `remote.state` or QoE sample. It writes `playback_states` only when its item differs from the row's item (the old device moved on to another item, whose progress is its own); a beat of the row's item writes nothing. This holds also when the engine already lost the session (`sessionLost: true` first);
   - the row has another sid owned by the same device that did not supersede it (a replaced session, e.g. a reload): ignored for the row, the history write is not blocked, `superseded` is not set;
   - no row (completed or dismissed): ignored.
9. The row is written when it is created, replaced, when the state, item, file or queue change, on a position jump above 30 s, and at least every 30 s while beating (the trigger of `playback_states`, `heartbeat.md` rule 13). The volatile position of the other beats lives in memory.
10. `session.changed` is emitted on a change of owner, item, file, state or queue, on park, completion and dismissal. Never on a plain position tick. Payload: rule 15.

Completion and expiry
11. When the history write of a beat marks the item completed (the existing completion rule of its family, `heartbeat.md` rule 15), the stored row of that sid is deleted at once, so a completed item is never offered again after a restart. A row still playing stays in memory until the playback stops: its beats keep updating it (rule 8), it is served and superseded as before but never stored again, and where it would be parked (rule 14) it leaves memory instead, with `session.changed` with null fields. A parked row of that sid leaves memory at once, with the same event.
12. A `parked` row is deleted 24 h (`PARKED_TTL`) after it was parked, when the sweep or boot finds it.
13. A row also leaves by `DELETE /api/session` (rule 16), by the media being deleted (`ON DELETE CASCADE`), and with its user.

Parked
14. A row becomes `parked` (position kept, `positionAt` and the 24 h clock set to now) when: (a) its live session has no presence or its `lastBeat` is older than the presence TTL (`STREAM_LIVE_SESSION_TTL_MS`, 30 s), found by a sweep every `SWEEP_EVERY` (15 s) and by `GET /api/session`; (b) the engine reports `SessionEnded` for its sid, or the owner stops it with `DELETE /api/stream/sessions/:sid`; (c) the server boots: every stored row that is not parked is parked before the first request.
15. `session.changed` payload: `{ epoch: number|null, itemId: number|null, state: string|null, ownerTargetId: string|null }`, all null after a completion or a dismissal. It carries identity and ownership only: observers refetch `GET /api/session`. `session.superseded` payload: `{ sessionId: string, byDeviceName: string|null, epoch: number, silent: boolean }`, `sessionId` being the superseded sid; a client that does not know `silent` shows its takeover notice as before. Both are `emit_to_user` to the account, never fanned out to the household.
16. `DELETE /api/session` on a live row is `409 session.error_not_parked`: to stop a live playback, send `remote.command stop` to its owner. A live row whose owner stopped beating is parked first, so it is deleted. The database delete comes before the memory one, here and in the completion and the sweep: a failed delete keeps the row.

Safety
17. The `account_sessions` row is never sent to the household (grantees, admins). `remote.state` is unchanged and still fans out as in `remote.md`.

Transfer
18. `POST /api/session/transfer` answers 404 `session.error_no_session` when the caller has no row (checked first), authorizes the target (404 `remote.error_device_offline` for a target the caller cannot see or that is gone, 403 `remote.error_<reason>` when seen but not controllable), and answers 400 `remote.error_self_target` when the row is live and already owned by `toTargetId`. It then sends one `remote.command` `load` to that connection only (the same send and `claimAttribution` as `POST /api/remote/:targetId/command`): `mediaId`/`episodeId` (the pair of the item, rule above), `itemId`, `mediaFileId` (omitted when the row has none), `kind`, `positionSeconds` = the row's position plus the time since `positionAt` while `state = 'playing'` (capped at `durationSeconds` when it is positive), `paused` = the state is `paused` or `parked`, and for a row with a queue `queue {itemIds, index}`, `shuffle`, `repeat`. Audio and subtitle tracks are not stored in the row, so the command carries none. A row of the video family whose file no longer exists (the id is shown as null, never served stale) is 404 `session.error_no_session`. A row of the text or image family (a reader's position, rule 19) is not transferable: 400 `session.error_not_transferable`, checked after the target is authorized. The route never supersedes: the target's first beat claims (rule 6) and the previous owner is superseded by that normal path. The route changes nothing in the row, but remembers the hand-over in memory for the target: `(account, targetId)` to the item and `HANDOFF_TTL_MS` (60 s). The first claim of that target for that account removes the record, and is `silent` (rule 6) when it is for that item inside the TTL; a claim of another item, or after the TTL, is a plain takeover. A transfer never claimed leaves only the lapsing record, and the sweep (rule 14a), or the next transfer recorded, announces its lapse with a `session.changed` carrying the row as it stands, so the originator's wait ends within `HANDOFF_TTL_MS` plus one sweep: an owner that did not change is a transfer that failed.

Readers
19. Books and comics are resume only (no claim, no epoch, no supersede, no exclusivity). A `PUT /api/playback/media/:mediaId/state` without `sessionId` or `playedAt` that carries a `progression` for an item of the text or image family, written to the history (the `playback_states` debounce of `heartbeat.md` rule 13), leaves the account's row as a `parked` row of that item when the account is in scope for the item's kind (rules 1-2) and the current row is absent or parked. A live row is never touched. The row has `sessionId = 'reader:<itemId>'`, the current `epoch` (1 for a new row), `positionSeconds = progression`, `durationSeconds = 1`, the file of the beat, no queue, and as owner the identity (target, device name, form factor) of the connection named by `sseConnectionId`, the `X-Fliks-Sse-Connection` header or `targetId`. A save whose identity or target is unknown leaves no row (a row without owner would read as another device). The row is stored when it is created or its item, file or owner changes, and then at most every 30 s (`PERSIST_EVERY_MS`); memory holds the latest percentage. A sid that claimed earlier and beats after a reader replaced its row claims normally when it is the replaced row's sid or targets the replaced row's owner: the reader's row never supersedes nor ignores it. Any other claimed sid is judged against the replaced row's owner (rule 8), so a superseded sid the engine revives stays superseded. `session.changed` is emitted when the item or the owner changes, not on each save. The position itself stays in `playback_states` (`progression`, `locator`): opening the reader on the item resumes there. When a write completes the item (`TEXT_SHARE`; a reader save, a Kobo or KOReader sync, an offline replay), the reader row of that item goes like a video's (rule 11); with no such row nothing happens.

20. A device that connects its events stream with a target id (`GET /api/system/events?device=`) is sent, right after `sse.connected` and to that connection only, the live owner's last `remote.state` (the presence of the row's sid), so volume, tracks, quality, `hasNext` and the real position arrive at once and not at the next beat. Nothing is sent when the account is out of scope for the row's kind (rules 1-2: the option was turned off or the kind deselected after the row was written), when the row is parked or absent, when the owner is this device (rule 6), when no target is known for the session, or when the live session belongs to another login than the connecting one (the credited account of a granted guest gets no `remote.state` of the guest's device, as at every beat). The row and its item are read before the connection registers; the presence is read right after it, with no await in between, so a `remote.stopped` or a newer `remote.state` is never followed by an older snapshot.
21. A `remote.stopped` and a `remote.targets_changed` go to the previous owner's account (and its household, `remote.md` rules 31-34) when its engine session is stopped after a supersede, like an explicit stop (`presence.md` rule 23).

## Events

| Event | Audience | Payload | Emitter |
|---|---|---|---|
| `session.changed` | the account's own connections (`emit_to_user`, no household hook) | rule 15 | claim, update on a change, park, completion, dismissal, lapse of an unclaimed transfer (rule 18) |
| `session.superseded` | exactly one connection of the previous owner (its queue for a polled target) | rule 15 | claim from another target |

## Jobs/timers

Sweep every 15 s (rule 14a), `SUPERSEDED_STOP_DELAY` 3 s, `HANDOFF_TTL_MS` 60 s, `PARKED_TTL` 24 h, persist throttle 30 s. The sweep and boot are the only timers.

## Vectors/parity

Rust unit tests (`crates/server/src/account_session/tests.rs`): concurrent claims leave one owner, a preloaded session without a beat claims nothing, an offline replay claims nothing, the sweep parks a silent owner and drops an old parked row, a lapsed transfer is announced once, a reload (same device, new tab nonce, the old tab gone) keeps the epoch and supersedes nothing, a second live tab of the owning device supersedes the first, boot parks everything, an out-of-scope kind or the option off leave the row untouched, a same-target replacement keeps the epoch, a completion keeps a playing row in memory, unstored, until it stops, a shared device parks the other account's row, a reader save parks a row without bumping the epoch, never replaces a live row and its completion removes it.
Integration (`tests/it/account_session.rs`): two SSE streams of one account, claim from the second target, `session.superseded` on the first stream only (`silent: false`; `silent: true` for a `handoff` beat and for the first claim after a transfer, once), `session.changed` on both, the first's next beat answered `superseded`.
Parity (`server/parity/scenarios/session/`): `get-empty`, `get-after-beat`, `beat-superseded`, `dismiss-parked`, `dismiss-live-409`, `stream-token-forbidden`, `unauthenticated`, `transfer-ok`, `transfer-no-session`, `transfer-offline`, `transfer-own-target`, `transfer-other-user-denied`, `transfer-grantee-allowed`, `transfer-stream-token-forbidden`, `reader-save-parked`, `reader-out-of-scope`, `reader-option-off`, `transfer-reader-refused`.

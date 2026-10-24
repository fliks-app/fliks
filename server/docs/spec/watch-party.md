# Spec: watch party

Synchronized playback of one media item at a time between several users, with an ephemeral chat. A party can follow a playlist. Persisted part: the party row and its guests (invitees and link joiners). Live part (state machine, members, chat): in memory in a `PartyRegistry` held by `AppState`, like `presence.md`.

## Model

Table `watch_parties`:
- `id serial PK`, `name text NOT NULL` (1..80), `ownerId int FK users ON DELETE CASCADE`
- `mediaId int FK media ON DELETE CASCADE`, `mediaFileId int NULL`, `episodeId int NULL`: the current item
- `playlistId int NULL FK playlists ON DELETE SET NULL`: the playlist the party follows; deleting the playlist leaves a plain party on its current item
- `inviteToken text UNIQUE NOT NULL` (22 chars base64url, 128 random bits)
- `policy text NOT NULL DEFAULT 'everyone'` (`everyone` | `host_only`)
- `reactionsEnabled boolean NOT NULL DEFAULT true`, `chatEnabled boolean NOT NULL DEFAULT true`, `linkSharing boolean NOT NULL DEFAULT true`: host switches for the whole party
- `scheduledAt timestamptz NULL` (set on every party created since the lobby rule: "now" is the creation time; null only on a row that went live before it)
- `status text NOT NULL` (`scheduled` | `live` | `ended`)
- `position double precision NOT NULL DEFAULT 0` (source-timeline seconds, written on every state transition, not on drift beacons)
- `createdAt`, `startedAt NULL`, `endedAt NULL`

Table `watch_party_invitees`: `partyId FK watch_parties ON DELETE CASCADE`, `userId FK users ON DELETE CASCADE`, PK `(partyId, userId)`, `source text NOT NULL DEFAULT 'invite'` (`invite` | `link`, CHECK). A row is a guest of the party: `invite` for an explicit invitation, `link` for a user who joined with the token.

Live state, only while `status = live`:
- `state`: `idle | waiting | paused | playing`
- `anchor { position: f64, serverTimeMs: i64 }`: while `playing`, `position(t) = anchor.position + (t - anchor.serverTimeMs) / 1000`; otherwise `anchor.position`.
- `rev: u64`, +1 on every mutation of state, item, members or settings.
- `members[]`: `{ userId, username, deviceId, connectionId, role: host|member, status: ready|buffering|away|waiting, lastSeenMs, rttMs }`. A member key is `(userId, deviceId)`: the same user on a second device is a second member.
- `chat`: ring buffer of the last 200 `PartyMessage`.

## Access

- Every route requires a session credential (`SessionAuthed`). No CASL policy beyond that.
- Creating a party: the owner must pass `assert_media_accessible` on `mediaId`. With `playlistId` the owner must also be able to read the playlist (`playlists.md` rule 4, min role viewer, else 404 `Playlist #<id> not found`); the party then follows it for as long as it lives, whatever the owner's access to it later. Each invitee must be a user the owner follows with an `accepted` follow; otherwise 400 `party.error_invitee_not_followed`.
- Viewing or joining: the owner, any guest (invitee or link joiner), or anyone presenting the `inviteToken` (any account). The joiner must pass `assert_media_accessible` on the current item, else 403 `party.error_no_access` (the client names the party and the media).
- `setItem` to a new item: every current member must pass `assert_media_accessible`; otherwise 409 `party.error_member_no_access` with `{ usernames: string[] }`. `next`, `previous` and the advance after `ended` in a playlist party skip such an item instead (Playlist parties).
- Host-only actions: `PATCH`, `DELETE`, schedule, kick, transfer, `start`, token regeneration. Others get 403 `party.error_not_host`.
- `reactionsEnabled = false`: `POST /reactions` is 403 `party.error_reactions_off`; `chatEnabled = false`: `POST /messages` (quick phrases included) is 403 `party.error_chat_off`. System messages keep flowing.
- `linkSharing = false`: `PartyDto.inviteToken` is null for everyone but the current host, members included. Joining with a token already held keeps working, and regenerating the token stays host-only.
- `policy = host_only`: `play|pause|seek|setItem|next|previous` intents from a non-host get 403 `party.error_host_only`.
- Unknown party, or a party the caller can't see: 404 `party.error_not_found` (never reveals existence).

## Routes

Module `server/crates/server/src/party/`. Error messages are translation keys.

| Method path | Body / query | Response | Notes |
|---|---|---|---|
| `GET /api/time` | none | `{ t1: i64, t2: i64 }` | server epoch ms at request reception (`t1`) and right before writing the response (`t2`). Any authenticated caller. |
| `POST /api/parties` | `{ name, mediaId?, mediaFileId?, episodeId?, playlistId?: int, scheduledAt?: ISO, policy?, reactionsEnabled?, chatEnabled?, linkSharing?, inviteeIds?: int[] (max 50) }` | 201 `PartyDto` | `mediaId` is required without `playlistId` (400 `party.error_invalid_item`). With `playlistId`, `mediaId`/`episodeId` pick the first item, which must be a row of the playlist (else 400 `party.error_invalid_item`); left out, it is the playlist's first playable item for the owner (none: 400 `party.error_invalid_item`). `scheduledAt` null or in the past ⇒ `scheduledAt = now`. The party is always `scheduled`; when its lobby window is open (always for "now") the lobby machine exists at once, with `live` non-null, and `party.starting` goes to the invitees right away. Going live is `POST /start`. Emits `party.invited` to invitees. A switch left out takes the owner's value from their most recent party (default true). |
| `GET /api/parties` | none | `PartySummaryDto[]` | parties with status `scheduled` or `live` where the caller is owner or has a guest row (invitee or link joiner); `live` first, then `scheduledAt` ascending. |
| `GET /api/parties/{id}` | none | `PartyDto` | full snapshot; `live` is filled whenever the party has an in-memory state: `live`, or a `scheduled` party whose lobby is open. Also allowed to a member who joined with the token. |
| `GET /api/parties/by-token/{token}` | none | `PartyDto` | resolves an invite link; does not join. |
| `PATCH /api/parties/{id}` | `{ name?, policy?, reactionsEnabled?, chatEnabled?, linkSharing?, scheduledAt?: ISO, regenerateToken?: bool }` | `PartyDto` | host only; `scheduledAt` only while `scheduled` (else 409 `party.error_not_scheduled`); a past date is clamped to now, which opens the lobby at once (machine and `party.starting` immediately, not at the next sweep). Cancelling is `DELETE`; starting early is `POST /start`, which takes a scheduled party live at any time. Emits `party.updated` to invitees and `party.members`-style `party.settings` to members. |
| `DELETE /api/parties/{id}` | none | 204 | host only; sets `ended`, emits `party.closed {reason: 'host_ended'}` to members and `party.updated` to invitees. |
| `POST /api/parties/{id}/join` | `{ deviceId, token? }` | `PartyDto` | opens the lobby of a `scheduled` party if within 15 min of `scheduledAt` (status stays `scheduled`, members are kept in memory); before that 409 `party.error_not_open`. `connectionId` = the caller's SSE connection for that `deviceId` (from the hub); none ⇒ 409 `party.error_no_connection`. Rejoining with the same `(userId, deviceId)` replaces the connection and resets status. A successful join with the token by a user without a guest row inserts one with `source = link`. |
| `POST /api/parties/{id}/start` | none | `PartyDto` | host only; `scheduled` ⇒ `live`, `startedAt = now`, state `idle`; the only way to go live. |
| `POST /api/parties/{id}/leave` | `{ deviceId }` | 204 | removes the member; host leaving ⇒ host transferred to the oldest member. |
| `POST /api/parties/{id}/intent` | `{ deviceId, action: play\|pause\|seek\|setItem\|ended\|next\|previous, position?: f64, item?: { mediaId, mediaFileId?, episodeId? }, baseRev: u64 }` | 202 `{ rev }` | `baseRev < rev` and action is `seek`, `setItem`, `next` or `previous` ⇒ 409 `party.error_stale` with the `PartyDto` in body. `play`/`pause` are applied whatever `baseRev`. `ended` is only honoured from the host. `next` and `previous` need `item` absent and a playlist party, else 400 `party.error_invalid` (Playlist parties). |
| `GET /api/parties/{id}/queue` | none | `PartyItem[]` | the playlist's items in its current order, those in a library the caller can access; `[]` for a party without a playlist. Owner, guests and members, like `GET /api/parties/{id}`. |
| `POST /api/parties/{id}/status` | `{ deviceId, status: ready\|buffering\|waiting, position: f64, rttMs?: int }` | 204 | updates the member; may complete a `waiting` phase. `waiting` means "not ready" (the lobby toggle). |
| `POST /api/parties/{id}/messages` | `{ deviceId, text (1..500) }` | 201 `PartyMessage` | max 5 messages per 10 s per member, else 429 `party.error_rate_limited`. |
| `GET /api/parties/reactions` | none | `{ animations: { [emoji]: string }, defaults: string[] }` | the emojis that have an animated asset (32), each mapped to the server-relative URL of a 72 px animated WebP, `/api/emoji/<Noto codepoint id>.webp`, served without auth from `<cast dir>/emoji/` (`public/emoji/`) with `Cache-Control: public, max-age=604800`; every other emoji is static. `defaults` is the default bar (`👍 😂 😮 😢 😡 ❤️ 🔥 👏`). Any session user. Registered before `/api/parties/{id}`. |
| `POST /api/parties/{id}/reactions` | `{ deviceId, emoji }` | 204 | `emoji` is any single standard emoji known to the Unicode emoji data (the `emojis` crate: skin-tone variants and unqualified forms included), checked before membership, else 400 `party.error_invalid`; relayed as sent; max 10 per 10 s; not stored. |
| `POST /api/parties/{id}/members/{userId}/kick` | none | 204 | host only; removes every member of that user and deletes the user's guest row (any source) and blocks rejoin with the token until the token is regenerated. |
| `POST /api/parties/{id}/members/{userId}/host` | none | 204 | host only; transfers the host role. |
| `POST /api/parties/{id}/invitees` | `{ userIds: int[] }` | `PartyDto` | host only; followed users only; emits `party.invited`; a link joiner invited this way becomes an `invite` row. |

DTOs (camelCase, every key present, `null` not absent):
- `PartyItem { mediaId, mediaFileId: int|null, episodeId: int|null, title: string, posterUrl: string|null, fanartUrl: string|null, additionalFanartUrls: string[] }` (the media DTO's artwork fields, so the client picks the same backdrop)
- `PartySummaryDto { id, name, status, scheduledAt: ISO|null, host: { userId, username }, item: PartyItem, playlist: { id, name }|null, memberCount: int }`
- `PartyDto = PartySummaryDto + { policy, reactionsEnabled, chatEnabled, linkSharing, inviteToken: string|null (host, and members while `linkSharing`), guests: { userId, username, source: 'invite'|'link' }[], live: PartyLive|null }`
- `PartyLive { rev, state, anchor: { position, serverTimeMs }, members: PartyMember[], messages: PartyMessage[] (last 50) }`
- `PartyMember { userId, username, deviceId, role, status, deviceName: string|null, formFactor: string|null, voice: { muted: bool }|null }` (`voice` null = not in the voice channel)
- `PartyMessage { id: u64, userId: int|null (null = system), username: string|null, text: string, system: { kind: string, by: string|null, args: object }|null, sentAtMs: i64 }`

## Events (SSE, `events-hub.md`)

To each member connection (`emit_to_connection`):
- `party.state { partyId, rev, state, item: PartyItem, anchor, whenMs: i64|null, by: { userId, username }|null, action: string|null }`. `whenMs` is the server epoch at which clients apply `playing` (scheduled unpause); null = apply now.
- `party.members { partyId, rev, members }`
- `party.settings { partyId, rev, name, policy, reactionsEnabled, chatEnabled, linkSharing }`
- `party.message { partyId, message: PartyMessage }`
- `party.reaction { partyId, userId, username, emoji }`
- `party.closed { partyId, reason: host_ended|expired|kicked }`

To users (`emit_to_users`):
- `party.invited { partyId, name, scheduledAt, host: { userId, username }, item: PartyItem }` to explicit invitees only (a link joiner upgraded by an invitation included, never a plain link join).
- `party.starting { partyId, name }` to every guest when the lobby opens (15 min before, or at once for a party for now) and when a party goes live; also to an invitee added while the lobby is open or the party is live.
- `party.updated { partyId }` to owner + every guest on reschedule, cancel, start, end, and when a guest row is added by a link join or removed by a kick (the kicked user included): the home rail refetches `GET /api/parties`.

Clients drop any `party.state|members|settings` whose `rev` is ≤ the last applied one, and refetch `GET /api/parties/{id}` after an SSE reconnect or a `rev` gap.

System messages are `PartyMessage` with `system.kind` in `joined, left, paused, resumed, seeked, item_changed, item_skipped, playlist_ended, host_changed, kicked`, `system.by` = username, `args` e.g. `{ position }`; `item_changed` and `item_skipped` carry `args.title`, the item label as `PartyItem.title` builds it (`Title S01E02` for an episode). The client translates `party.system.<kind>`.

## Playlist parties

A party with a `playlistId` follows the playlist's items (`playlist_items`, `ORDER BY position, id`; an episode row is `{ mediaId: series, episodeId }`, a movie row `{ mediaId, episodeId: null }`, `mediaFileId` left to the client).

- `next` / `previous`, and a host `ended` that took effect (state was not `idle`), choose the item on the server from the current one: the first row after (before) it in the playlist's order. A current item no longer in the playlist counts as before the first row for `next` (so the first remaining row plays) and gives nothing for `previous`.
- A candidate is skipped when it has no media file (the episode's, or the movie's) or when any current member (one check per user) cannot access its media; each skip appends a system message `item_skipped` with `args.title`, in the order walked.
- The first candidate left becomes the item exactly as a `setItem` would (state `waiting`, `item_changed`, `rev + 1`); the `baseRev` stale check applies to `next` and `previous` only, the advance after `ended` uses the current revision.
- Nothing left: the party goes `idle` on the current item (like `ended`) and appends `playlist_ended`. A non-host `next` under `host_only` is 403 `party.error_host_only`.
- Without a playlist, `next` and `previous` are 400 `party.error_invalid` and `ended` only idles: the client moves along the series itself.
- The `PartyDto.playlist` name follows renames; the row's `playlistId` drops to null with the playlist.

## Voice

Peer-to-peer WebRTC audio, full mesh between the members in the voice channel; the server only relays signaling and never sees media.

- `VOICE_MAX = 8` members in the voice channel per party; a 9th `voice` join gets 409 `party.error_voice_full`.
- `POST /api/parties/{id}/voice { deviceId, joined: bool, muted: bool }` → 204. Sets or clears the member's `voice`; bumps `rev` and emits `party.members`. Leaving the party, a kick, or the member's removal clears it. An `away` member keeps `voice` (its peers drop the connection on their side and renegotiate on return).
- `POST /api/parties/{id}/signal { deviceId, to: string (target deviceId), kind: offer|answer|ice|bye, data: object (max 16 KiB) }` → 204. Both sender and target must be members with `voice` set, else 409 `party.error_voice_not_joined`. Delivered as `party.signal { partyId, from: { userId, deviceId }, kind, data }` to the target member's connection only. Rate limit 60 per 10 s per member, else 429. Not stored, no `rev`.
- Offer direction: on a new voice member, the member whose `deviceId` sorts lower sends the offer (no glare).
- `GET /api/parties/ice` → `{ iceServers: RTCIceServer[] }` for any session user, from the setting `party_voice_ice_servers` (JSON array of `{ urls, username?, credential? }`); absent or invalid = `[{ "urls": "stun:stun.l.google.com:19302" }]`. A TURN server is the admin's to configure; credentials are passed through as stored.
- System messages: `voice_joined`, `voice_left`.
- Details: a `voice` call that only changes `muted` bumps `rev` without a system message; a `signal` with a `data` that is not an object or over 16 KiB serialized is 400 `party.error_invalid_data`; an empty `iceServers` array stored by the admin is returned as is; the rate limit counts only signals that passed the voice checks.

## State machine (pure module, unit-tested)

Timing constants: `WAIT_TIMEOUT_MS = 10000`, `MIN_START_DELAY_MS = 500`, `AWAY_GRACE_MS = 120000`, `EMPTY_TTL_MS = 600000`, `LOBBY_OPEN_BEFORE_MS = 900000`, `SCHEDULE_EXPIRY_MS = 7200000`.

1. `play` from `idle|paused`, `seek`, `setItem` ⇒ `waiting`: every non-`away` member's status becomes `waiting`; `anchor.position` = the requested position (`play` keeps the current one; `setItem` = 0). Emits `party.state` (`whenMs: null`), where the state is `waiting` and clients seek to `anchor.position` and pause.
2. A member's `status ready` with `|position - anchor.position| <= 1.0` counts as ready; a farther one gets nothing back (the client already has the anchor and re-seeks).
3. Every member ready, or `WAIT_TIMEOUT_MS` elapsed (checked by a 1 s tick): the target is `playing` if the phase was entered by `play`, or by `seek`/`setItem` while playing; else `paused`. For `playing`: `whenMs = now + max(2 × max(rttMs), MIN_START_DELAY_MS)`, `anchor = { position, serverTimeMs: whenMs }`. Members still not ready are left as they are and catch up alone.
4. `pause` while `playing` ⇒ `paused` immediately at `position(now)`; `pause` while `waiting` ⇒ the phase target becomes `paused`.
5. `status buffering` while `playing` changes the member status only; the group never pauses for it.
6. A member joining while `playing` never re-enters `waiting`: it gets the snapshot and catches up.
7. `ended` from the host ⇒ `idle` with the same item; in a playlist party the server then advances (Playlist parties), else the host's client sends `setItem` for the next episode itself.
8. Every transition writes `position` to the row (cheap: transitions are rare).
9. A member whose SSE connection drops becomes `away` (hub disconnect hook or a missing connection at the 1 s tick); removed after `AWAY_GRACE_MS`; a host removed this way is transferred. A live party with no non-away member for `EMPTY_TTL_MS` ⇒ `ended`, `party.closed {reason: expired}`.
10. Boot: every `live` row is loaded with state `paused` at its stored `position`, with no member; its `EMPTY_TTL_MS` countdown starts.
11. Scheduler: at `scheduledAt - LOBBY_OPEN_BEFORE_MS`, emit `party.starting` once; at `scheduledAt + SCHEDULE_EXPIRY_MS` a still-`scheduled` row ⇒ `ended` + `party.updated`.

Every state, member or settings mutation bumps `rev` and emits the matching event; every user action also appends a system message (`party.message`).

## Implementation notes

- Code: the pure machine is `fliks_domain::party`; routes, registry and tick are `server/crates/server/src/party/`. Wire events nest `item`, `anchor`, `members`, `message`, `host` as plain JSON in `SseEvent`.
- Extra error keys: 403 `party.error_not_member` (caller has no member for that `deviceId`), 403 `party.error_kicked` (token rejoin after a kick), 409 `party.error_not_live` (no live state, or `intent` on a `scheduled` party), 409 `party.error_ended`, 400 `party.error_invalid` / `party.error_invalid_<name|text|item|invitees>`, 429 `party.error_rate_limited`. A kick or host transfer aimed at a non-member is 404 `party.error_not_found`.
- Error bodies are the usual `{statusCode, message, error}`, except 409 `party.error_stale`, whose body is the bare `PartyDto`;  409 `party.error_member_no_access` adds `usernames: string[]`.
- `intent` returns 202 `{ rev }`; `ended` from a non-host is accepted and ignored. `leave`, `status` and chat need only a member of an in-memory party.
- Rule 9 is polled by the 1 s tick through `Hub::has_connection`; there is no hub hook. After an SSE reconnect the member is `away`: the client calls `join` again (same `deviceId`) to re-attach its new connection.
- `deviceId` is the caller's SSE target id (`deviceId#tabNonce`, one member per tab) or a bare device id; it maps to the non-polled SSE connection with that exact target id, else the newest one whose target id starts with `deviceId#`.
- `position(t)` is clamped to `anchor.position` while `t < anchor.serverTimeMs` (a pause during the start delay).
- `system.by` is the acting username; for `host_changed` and `kicked`, `args.username` names the new host or the kicked user (`by` is null for an automatic transfer).
- `party.starting` before a lobby opens is remembered in memory only: a restart inside the 15 min window repeats it once. The lobby and expiry checks run every 10 s from the registry tick, not the job scheduler.
- `GET /api/time`: `t1` is taken when the handler starts, after authentication.
- Lobby (a `scheduled` party whose lobby is open): `live` is non-null with `state: idle` and anchor 0; members start `waiting`, `status` ready/waiting toggles emit `party.members`, chat works. `start` keeps the members and chat and the party goes `live`.

# Spec: push notifications (user notifications on every device)

Scope: the push pipeline (`push::notify`), the relay client, the identity file, encryption, Web Push, push subscriptions, the notification catalogue, text loading, actions and the `attention` badge. The admin channels (Discord, ntfy...) are `notifications.md` and are untouched; the built-in `fliks-relay` connection that switches mobile push on is described there (rules 30 to 36) and here. The relay wire protocol is `PROTOCOL.md` of the relay repository, with its test vectors. Auth, CASL and error bodies: `auth.md` ("auth rule N"). The plugin entry point (`notify:users`) is `plugins.md`, not specified here.

## Routes

7 routes, all under `/api/push`. `SessionAuthed` rejects a `stream` token with 403 `session_token_required` (auth rule 11). Admin routes need `ability.can(Action.Manage, 'Settings')`.

| Method path | Auth | Request | Response | Errors | Side effects |
|---|---|---|---|---|---|
| `GET /api/push/config` | `SessionAuthed` | none | 200 `{mobile: bool, vapidPublicKey: string, plugins: [{id, name}]}`; `mobile` = the `enabled` flag of the `fliks-relay` connection; `plugins` = the active plugins granted `notify:users`, whose `plugin.<id>` category a user can mute, `name` from the manifest | 401, 403 | none |
| `POST /api/push/subscriptions` | `SessionAuthed` | body `{platform: 'apns'\|'fcm'\|'web', p256dh, auth, locale, endpoint?}`; `endpoint` required for `web`, ignored otherwise; unknown keys 400 | mobile: 201 `{sub, ticket}`; web: 201 `{id}` | 400 validation, bad keys, refused endpoint (rule 25); 409 `push.error_disabled` (mobile, connection disabled); 503 `push.error_relay_unavailable` (mobile, enabled but registration failed) | upsert of the session's row (rule 30); at the cap the oldest row is replaced (rule 29) |
| `DELETE /api/push/subscriptions/current` | `SessionAuthed` | body `{platform}` | 204 (also when no row) | 400 validation; 503 `push.error_relay_unavailable` when the relay did not answer: the row stays and the device keeps its pending deletion and retries | deletes the row of the calling session and platform; the relay subscription first for mobile (rule 22) |
| `POST /api/push/test` | `SessionAuthed` | none | 200 `{results: [{platform, ok: bool, error?: string}]}`, one entry per subscription of the caller | 401, 403 | sends the `test` notification (rule 28) to every subscription of the caller |
| `POST /api/push/act` | `SessionAuthed` | body `{token}` (`fka_`, rule 41) | 204 | 400 malformed token; 403 token of another user or expired | runs the action with the caller's rights (rule 42) |
| `GET /api/push/status` | `Authed`; `Manage Settings` | none | 200 `{relay: {state: 'disabled'\|'ready'\|'error', url, key, error, pendingDeletions: [{relay, key}], stats}, web: {subscriptions}, mobile: {subscriptions}}` | 401, 403 | none |
| `DELETE /api/push/pending/{relay}` | `Authed`; `Manage Settings` | path `relay` = the host of a pending deletion | 204 | 404 when none matches | drops that pending deletion (rule 10) |

`ticket` is the relay ticket of rule 13. A `GET /api/counts` carries the badge (`counts.md` rule 16), `PUT /api/users/{id}` writes `pushMuted` (`users.md` rule 35) and `GET /api/system/events?lang=` renders the live event (`events-hub.md` rules 49 to 52).

## Rules

### A. Pipeline

1. `push::notify(recipients, notification)` is the only entry point. The hub hook (rule 33), the request lifecycle, the new-episode grouper (rule 35) and the plugin host call it. `notification` = category (rule 31), a text key with params, `url`, optional `image`, `actions`, `tag`, `ttl`.
2. Recipients are filtered first: enabled users who have not muted the category (`users.pushMuted` contains the category: dropped). `plugin.<id>` categories are muted the same way.
3. Live clients: the SSE event `notification` (`events-hub.md` rule 49) goes to every open connection of each recipient, rendered in that connection's language (`lang`, rule 40). Web, TV and desktop show it in-app; the desktop app turns it into a system notification while its window is hidden.
4. Mobile: for each `apns` or `fcm` subscription of a recipient, render in the subscription's `locale`, encrypt (rule 16), then `POST /v1/push {nid, sub, payload, ttl}` to the relay (rule 12). One request per subscription.
5. Web: for each `web` subscription, render, encrypt, then POST to the browser's endpoint with VAPID (rules 23 to 26).
6. `nid` = 16 random bytes base64url, one per notification, shared by every push of that notification, unrelated to the plaintext `id` (rule 17).
7. The send query joins `push_subscriptions` to `sessions` (`"revokedAt" IS NULL`) and `users` (`enabled`). A row of a revoked session is never sent to even before the sweep (rule 22) removes it.
8. Sends are spawned, each with a 10 s timeout counted from the spawn, 8 concurrent at most, no queue (a device is skipped when the 8 slots are taken, logged), no retry (like `notifications.md` rule 12). A refused or failed send is logged and the notification is lost for that device.
9. A mobile app or browser tab in the foreground on the notification's session hides the system notification and shows the toast. A browser always shows the system notification it received (Safari revokes the permission otherwise, Chrome requires `userVisibleOnly`); that tab then skips the toast. This is client behaviour; the server always sends.
10. The admin connections of `notifications.md` are not recipients here: they are admin channels. `dispatch` never reaches the `fliks-relay` connection and `push::notify` never reaches the admin connections.

### B. Identity file and reconcile

11. The identity file is `<conf>/.push-identity.json`, created through the code path of `.jwt-secret` (`auth.md` rules 1 and 2): `<conf>` resolution, exclusive create, mode 0600, rejected when not owned by the effective uid or readable by group or other, never in a database dump. Content: the current relay `{url, seed}` (Ed25519 seed, 32 bytes base64url), the pending deletions `{url, seed}[]`, and the VAPID key pair (P-256 ECDSA, rule 23). It is created at first need (first enabling of the connection or first web subscription), not at boot.
12. Relay URL: the official relay compiled in as a constant, overridden by the deployment variable `FLIKS_PUSH_RELAY_URL` (development and forks). It is not a setting and not in the UI.
13. Relay client (`PROTOCOL.md`): every signed request carries `Fliks-Key` (public key, base64url), `Fliks-Time` (unix seconds) and `Fliks-Signature`, over `"fliks-relay-v1\n" METHOD "\n" HOST "\n" PATH "\n" TIME "\n" hex(sha256(body))`, `HOST` being the host of the configured relay URL and `PATH` the raw path. Tickets are `base64url(JSON {key, sub, aud, exp}) "." base64url(signature)`, signed over `"fliks-relay-ticket-v1\n"` plus the first part, `sub` 16 random bytes minted by the server (the subscription id), `aud` the relay host, `exp` = relay-adjusted time plus 300. The test vectors of the relay repository are replayed by the server's tests.
14. Clock: the client reads the `Date` header of every relay reply and keeps the offset to its own clock. On `401 clock_skew` it adopts the offset and retries once. Every time put on the wire, tickets included, uses the same offset.
15. Error mapping of `POST /v1/push`:

    | Reply | Server does |
    |---|---|
    | 200 | nothing |
    | `404 unknown_subscription` | deletes the row of that `sub` |
    | `401 unknown_server` | registers again (`POST /v1/servers`), retries once |
    | `409 duplicate` | nothing |
    | `429` (`Retry-After`, `scope`) | drops the notification, logs |
    | `403 blocked`, `413`, `502`, `408`, transport error | drops, logs |

    `PUT /v1/subscriptions` is made by the device with the ticket, never by the server.
16. Encryption: RFC 8291 `aes128gcm` (ECDH P-256, HKDF-SHA256, AES-128-GCM), one record, 103 bytes of overhead, a fresh ephemeral key per message, for one subscription (`p256dh` 65-byte uncompressed point, `auth` 16 bytes, both base64url). Primitives only (RustCrypto `p256`, `hkdf`, `aes-gcm`). The tests replay RFC 8291 Appendix A. The same encryptor serves mobile and Web Push.
17. Plaintext (JSON before encryption, mobile and web): `{v: 1, id, ts, ttl, cat, title, body, url, image?, actions?, badge?, user, tag?}`.
    - `id`: 16 random bytes base64url, the replay key on the device. `ts`: unix seconds. `ttl`: seconds. `cat`: the category. `user`: the recipient's user id.
    - `url`: an in-app path. `image`: a path on the server. `badge`: the recipient's `attention` count (`counts.md` rule 16).
    - `v`: the plaintext version. A device that gets a `v` higher than the one it knows shows its generic text for an unreadable notification and nothing else of it (relay `PROTOCOL.md`, device rules).
    - `actions`: `[{id, title, kind: 'open'|'call', url?, token?, done?}]`, two at most.
    - `tag?`: the replace key (rule 35, `episodes:<mediaId>`; `test` for rule 28): a device replaces a shown notification with the same `tag`; `id` stays unique.
18. Size: the plaintext is 2500 bytes at most. The server shortens `body`, then `title`, cutting on a character boundary and counting the JSON-escaped size, until it fits; when even empty texts do not fit (a huge `url` or `image`) that device is skipped and logged. The relay payload limit is 2700 bytes once decoded.
19. Locale: a tag is normalised to its base language when it is one of `en fr de es it pt`, else `en`; the `locale` of a subscription is stored normalised.
20. Reconcile compares the identity file with the `enabled` flag of the `fliks-relay` connection and runs at boot, after every write to that connection, and every 10 minutes while work is pending (a pending deletion, a failed registration). A reconcile never runs twice at once.
    - Enabled with no current identity: make one, check `GET /v1/info` (`api` is the list of versions the relay serves and must contain 1), `POST /v1/servers` (201 or 200). A failure is the `error` state of `GET /api/push/status`; the connection stays enabled and the next reconcile retries.
    - Disabled with a current identity: delete every mobile subscription row at once, then `DELETE /v1/servers/self` (204, idempotent), then delete the identity. While the relay is unreachable the identity moves to the pending deletions and is retried every 10 minutes; `GET /api/push/status` says so (`pendingDeletions`).
    - Relay URL changed (the variable): register the new identity at once, move the old one to the pending deletions, retried in the background until the relay answers 204.
21. Web subscriptions are not affected by the connection: they never touch the relay.

### C. Subscriptions

22. Table `push_subscriptions` (SQL below): one row per session and platform. A mobile row holds the `sub` id minted by the server (unique); a web row holds the `endpoint`. Deleting a mobile row always calls `DELETE /v1/subscriptions/{sub}` at the relay first (signed); the row stays until the relay answered 204, 401 or 404, or until the server has no relay identity (rule 20). The client of the identity file is used even before the first reconcile. The sweep (rule 45) is the one cleanup for revoked sessions and disabled users.
23. Web Push: VAPID with a second key pair, P-256 ECDSA, separate from the encryption keys, in the identity file. Each request carries `Authorization: vapid t=<jwt>, k=<public key>`, the JWT having `aud` = the endpoint's origin, `exp` = now plus 12 h, `sub` = the `public_url` setting when set, else `mailto:` of the first enabled admin that has an email (Apple requires one). The JWT is cached per origin for an hour.
24. Web send: `POST` to the endpoint with `TTL` = the notification's `ttl`, `Urgency: high` for the category `account`, else `normal`, `Content-Encoding: aes128gcm`, body the encrypted record. `404` and `410` delete the row; any other failure is logged and dropped.
25. The endpoint is user input that the server will POST to. It is accepted only when it is an `https` URL whose host is on the allow-list of known push services (FCM, with `jmt17.google.com` for Chromium outside the stable channel, Mozilla autopush, Apple Web Push, Windows push), resolved once, every address vetted and the connection pinned through `net::guard::vet` (`vetted.rs`), no redirect. Anything else is 400. An unknown push service cannot subscribe (known limit).
26. The server never sends to a web subscription whose endpoint stopped passing the allow-list (re-checked at send time).
27. Subscribe validation: `p256dh` is a valid P-256 point, `auth` is 16 bytes, `locale` is normalised (rule 19), `platform` is one of the three; else 400. A mobile subscribe also requires the connection enabled (409, rule in Routes) and a registered relay identity (503 otherwise); the reconcile of rule 20 is attempted once inline.
28. `POST /api/push/test` sends a notification with the text key `test` and no params, category `account`, `tag` `test` (a client shows it as a system notification even while in front), `ttl` 5 minutes, to every subscription of the caller, and the live connections of the caller get the SSE event too. `results` has one entry per subscription; a send that failed has `ok: false` and a short `error`. Not counted by any limit of the server (the relay's limits still apply).
29. Cap: a user holds 10 subscriptions at most (any platform). A subscribe by a session that has no row for that platform, when the user is at 10, deletes the oldest row (`"createdAt"`, then id) in the same transaction as the insert, under a per-user advisory lock, so concurrent subscribes cannot overshoot; its relay subscription is deleted right after the commit (best effort: an orphan at the relay expires with the relay's 60 day sweep).
30. Upsert: a second subscribe by the same session and platform updates the row (`p256dh`, `auth`, `locale`, `endpoint`; `sub` is kept for mobile) and answers a fresh `ticket` for the same `sub`. `"updatedAt"` follows the house trigger.

### D. Catalogue

31. Categories: `requests`, `parties`, `social`, `episodes`, `account` and `plugin.<id>`. The category is what `users.pushMuted` stores.
32. Catalogue:

    | Category | Source | Recipient | Text key | `ttl` | Image | Actions |
    |---|---|---|---|---|---|---|
    | `requests` | request approved | the requester | `request_approved` | 1 day | poster | open |
    | `requests` | request declined | the requester | `request_declined` | 1 day | poster | open |
    | `requests` | request available | the requester | `request_available` | 1 day | poster | open |
    | `requests` | request created | users who can approve (`requests.manage`, `manage:all`), minus the requester | `request_created` | 1 day | poster | Approve, Decline (`call`); opens `/requests?status=pending` |
    | `parties` | `party.invited` | the invitees | `party_invited` | 1 day | party image | Join (`open`) |
    | `parties` | `party.starting` | the invitees | `party_starting` | 15 min | party image | Join (`open`) |
    | `social` | `social.follow_request` | the target user | `follow_request` | 1 day | avatar | Accept, Decline (`call`) |
    | `social` | `social.follow_accepted` | the requester | `follow_accepted` | 1 day | avatar | open |
    | `social` | `social.content_recommended` | the recipient | `content_recommended` | 1 day | poster | open |
    | `episodes` | new episode files of a series (rule 35) | users who watched it | `episode_one`, `episodes_many`, `episodes_series` | 1 day | poster | open |
    | `account` | `pairing.requested` | the hinted user | `pairing_requested` | 10 min | none | open only (approval needs the code shown on the other device, `auth.md` rule 53) |
    | `plugin.<id>` | sent by the plugin | its audience | the plugin's keys | 1 day | the plugin's choice | open |
    | `account` | `POST /api/push/test` | the caller | `test` | 5 min | none | none |

    `social.followed` (an accepted follow of a public profile) is not notified.
33. Sources: events addressed to users on the SSE hub go through one hook of the hub (`events-hub.md` rule 51). The hook maps `party.invited`, `party.starting`, `social.follow_request`, `social.follow_accepted`, `social.content_recommended` and `pairing.requested`, sent to users, and ignores every other type. Request notifications come from `requests::services::notify`, the one helper behind approved, declined and available, which carries the requester's id (`Req.user_id`), and from the creation path for the approvers. The emit sites are not edited.
34. Request actions: Approve and Decline are `call` actions with `request.approve` / `request.decline` tokens, target = the request id. Follow actions: Accept and Decline are `follow.accept` / `follow.decline`, target = the requesting user id.
35. New episodes: the source is the in-process domain event `media.files.imported` with `family` `video` and a `seasonNumber` and `episodeNumber`, not the SSE hub.
    - Recipients: users with a playback row on an item of the series not hidden from continue watching (hiding marks every row, a heartbeat clears it: any visible row counts) and who still read its library. A user with a request for that media, in any state, is excluded: the requester gets the `requests` notifications instead, never both, whatever order the events come in (the check reads the `requests` table at flush time).
    - Grouping: imports of one series are held for 5 minutes (from the first import of the group) and sent as one notification keyed by media. One episode: `episode_one` (`S02E03`); several of one season: `episodes_many` (count, `S02`); several seasons: `episodes_series` (count).
    - `tag` = `episodes:<mediaId>`, so a later notification for the series replaces an earlier one on the device.
    - The group is in memory: a graceful shutdown sends the groups still waiting at once; a crash inside the window loses them. A lagged bus drops imports with a warn.
36. Text keys and params (client `push` branch, rule 38): `request_approved|request_declined|request_available` `{title}`; `request_created` `{title, user}`; `party_invited` `{party, host}`; `party_starting` `{party}`; `follow_request|follow_accepted` `{user}`; `content_recommended` `{user, title}`; `episode_one` `{title, episode}`; `episodes_many` `{title, count, season}`; `episodes_series` `{title, count}`; `pairing_requested` `{device}`; `test` (none). Action titles `push.action.<id>` with ids `approve decline join accept open`.
37. Images: `image` is a path on the server: posters and backdrops (`/api/images/media/:id/poster?size=medium`), avatars (`/api/images/user/:id`), party images. Those routes are public already (`images.md`), so no token travels.

### E. Text

38. `title` and `body` are `push.<key>.title` and `push.<key>.body` of the client's `public/i18n/<lang>.json`, ngx-translate `{{param}}` interpolation. Languages: `en fr de es it pt`.
39. The server reads the files from the client directory it already serves (`static_files`), asynchronously and off any lock, cached in memory per language once read; a failed read is retried after 60 seconds, never cached for good. With no client directory, or a missing key or file, the English constants of `fliks_domain::push` are used. A param that is missing renders as the empty string. A plugin notification brings its own table (manifest `i18n`), English as fallback.
40. A connection gives its language with `lang` (`events-hub.md` rule 52), a subscription with its `locale`. No translated text lives in the backend code.

### F. Actions

41. Action tokens: `fka_<user>:<action>:<target>:<exp>:<mac>`; `mac` = hex HMAC-SHA256 of `"fliks-push-action:" + user + ":" + action + ":" + target + ":" + exp` under `grant_key` (the key of the job grants of `queue/remote.rs`). `exp` = unix seconds = `ts + ttl`. Actions: `request.approve`, `request.decline`, `follow.accept`, `follow.decline`.
42. `POST /api/push/act {token}`: the MAC is checked in constant time, `exp` must be in the future, and the `user` of the token must be the authenticated caller, else 403 (an unknown action is 400). Then the action runs with that user's rights through the same function as the existing route (the request approve and decline of `requests.md`, the follow accept and reject of `social.md`), never a second copy: a caller who lost the permission gets that route's error. A token is not single use: a repeated approve answers the route's own state error.
43. `open` actions carry a `url` only; a `call` action carries `token`, no `url`, and `done`: the text a device shows once the call succeeds, `push.done.<action>` with the action's `.` as `_` (`done.request_approve`), rendered like `title`. A device without `done` shows its generic done text. Two actions at most. Actions are sent only in the encrypted plaintext and the SSE event, never in the relay fallback text. Web: the service worker POSTs a `call` action with the session cookie and shows a done or failed notification; it cannot refresh the session (the refresh token lives in the page's storage, rotation is serialised there by Web Locks), so on a `401` it opens the app at the notification's `url` and the user acts there. A `url` that is not a path of the app's origin opens `/`.

### G. Badge, revoke, relay deletion

44. Badge: every push carries `badge` = the recipient's `attention` count (`counts.md` rule 16), computed once per recipient per notification. A badge that goes down while the app is closed stays stale until the next push or launch.
45. Revoke sweep (`push::sweep`): deletes the push rows of revoked sessions (`sessions."revokedAt" IS NOT NULL`) and of disabled users (every session of the user), after calling `DELETE /v1/subscriptions/{sub}` for each mobile row; a row stays when the relay did not answer 204 or 404, and the next sweep retries it. It runs at boot, every 10 minutes, and after the revoke call sites that hold state: logout with a refresh token, `DELETE /api/auth/sessions/:id`, `DELETE /api/users/:id/sessions`, a password change, disabling a user (`PUT /api/users/:id` with `enabled: false`) and refresh reuse. The paths without state (OIDC back-channel logout, provider disable) are caught by the periodic run. User deletion: the push rows are removed after the relay subscriptions were deleted, before the user row (the cascade then has nothing left).
46. Disabling the `fliks-relay` connection deletes the server at the relay (rule 20); re-enabling later makes a new identity, so devices subscribe again at their next launch.
47. Statistics of the server at the relay: `GET /v1/servers/self/stats` (signed), `{days: [...]}`, last 30 days, shown on the admin page through `GET /api/push/status`.

## SQL

Table `push_subscriptions` (one migration, with the `fliks-relay` connection row of `notifications.md` and `users."pushMuted"`):

```sql
CREATE TABLE push_subscriptions (
  id serial PRIMARY KEY,
  "sessionId" integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  platform text NOT NULL,           -- 'apns' | 'fcm' | 'web'
  sub text UNIQUE,                  -- mobile only (relay subscription id)
  endpoint text,                    -- web only
  p256dh text NOT NULL, auth text NOT NULL, locale text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("sessionId", platform)
);
```

- Upsert: `INSERT INTO push_subscriptions (...) VALUES (...) ON CONFLICT ("sessionId", platform) DO UPDATE SET p256dh = $.., auth = $.., locale = $.., endpoint = $.., "updatedAt" = now() RETURNING id, sub`, under the per-user advisory lock of rule 29.
- Count per user: `SELECT count(*) FROM push_subscriptions p JOIN sessions s ON s.id = p."sessionId" WHERE s."userId" = $1`; oldest: same join `ORDER BY p."createdAt", p.id LIMIT 1`.
- Send: `SELECT p.* FROM push_subscriptions p JOIN sessions s ON s.id = p."sessionId" AND s."revokedAt" IS NULL JOIN users u ON u.id = s."userId" AND u.enabled WHERE s."userId" = ANY($1)`, the category filter on `users."pushMuted"` applied with the recipients (rule 2).
- Sweep: `SELECT p.id, p.sub FROM push_subscriptions p JOIN sessions s ON s.id = p."sessionId" JOIN users u ON u.id = s."userId" WHERE s."revokedAt" IS NOT NULL OR NOT u.enabled`, then `DELETE FROM push_subscriptions WHERE id = $1` after the relay call.
- Relay deletion by session: `SELECT sub FROM push_subscriptions WHERE "sessionId" = $1 AND platform IN ('apns','fcm')`.

## Events

Emits the SSE event `notification` (`events-hub.md` rule 49) to the recipients' connections. Consumes, in process: the hub hook of `events-hub.md` rule 51 and the domain event `media.files.imported` (rule 35). No domain event is emitted.

## Settings keys

None: mobile push is the `enabled` flag of the `fliks-relay` connection; browser, desktop and in-app notifications are switched on per device and per category by each user (`users.pushMuted`). The only configuration is the deployment variable `FLIKS_PUSH_RELAY_URL` (rule 12).

## Jobs/timers

| Job | Schedule | Behaviour |
|---|---|---|
| reconcile | boot, after each write of the `fliks-relay` connection, every 10 minutes while work is pending | rule 20 |
| sweep | boot and every 10 minutes | rule 45 |
| new-episode flush | 5 minutes after the first import of a group | rule 35 |

## Vectors/parity

Vector sets: the relay's `vectors.json` (signature, ticket and clock-skew cases), RFC 8291 Appendix A (encryption), and a domain set for locale normalisation, `{{param}}` interpolation, English fallbacks and plaintext shortening (`fliks_domain::push`). Parity: the `notifications` scenarios gain the `fliks-relay` row, plus scenarios for its create, delete and update refusals (`notifications.md` rules 30 to 36); the `counts` scenarios gain `attention`.

## Open questions

- Open: the minimum interval of a reconcile retry after a failed registration is the 10 minute timer, no backoff.
- Open: `POST /api/push/subscriptions` for a mobile platform with the relay still registering waits for the inline reconcile (bounded by the 10 s relay timeout) before answering 503.
- Open: the notification to approvers (`request_created`) excludes the requester when the requester can approve.
- Open: `DELETE /api/push/pending/{relay}` answers 404 when no pending deletion has that host.
- Open: the Fliks Relay editor reads `stats` as `null` while the relay is not `ready`.
- Open: the default relay URL constant waits for the owner's choice of the official host.

# Spec: notifications (connections, senders, dispatch)

Scope: connections CRUD, senders and dispatch, and every `notifications.dispatch` caller (listed in Events). Auth, CASL, error bodies: `auth.md` ("auth rule N"). Requests that dispatch: `requests.md`.

## Routes

7 routes. Class-level guards `JwtOrApiKeyGuard, PoliciesGuard`; `scope:'stream'` tokens are rejected by the extractor. POST = 201, DELETE = 200 (empty). Declaration order: `GET events` before `GET:id`. Read policies need `settings.access` (it grants both `Read` and `Manage` on `Settings`, auth rule 25).

`ConnectionJSON` = `{id: number, createdAt: ISO, updatedAt: ISO, name: string, type: 'discord'|'slack'|'webhook'|'gotify'|'ntfy', settings: object, events: string[], enabled: boolean}` with `settings` redacted (rule 8; `webhookUrl` of discord/slack is a secret too, rule 24).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `POST /api/notifications` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `(ability) => ability.can(Action.Manage, 'Settings')` | body (rule 2): `name` string, `type` in the 5 types, `settings` object (endpoint rule), `events?` string[] of the 18 names, `enabled?` boolean | 201, `ConnectionJSON` (redacted, saved row) | 400 validation (auth rule 16, rule 29); 400 `gotify requires a non-empty settings.token` | INSERT `notification_connections` |
| `GET /api/notifications` | same; `Action.Read, 'Settings'` | none | `ConnectionJSON[]` `ORDER BY name ASC` | 401, 403 | none |
| `GET /api/notifications/events` | same; `Action.Read, 'Settings'` | none | `string[]`: the 17 subscribable events in vocabulary order (rule 3) | 401, 403 | none |
| `GET /api/notifications/:id` | same; `Action.Read, 'Settings'` | path `id` numeric | `ConnectionJSON` | 400 `Validation failed (numeric string is expected)`; 404 `Notification connection #<id> not found` | none |
| `PUT /api/notifications/:id` | same; `Action.Manage, 'Settings'` | path `id`; body = the same as create (so `name`, `type`, `settings` are required; `events?`, `enabled?` optional) | 200, `ConnectionJSON` (saved row, redacted) | 400; 404; 400 gotify token | UPDATE (rules 5-7) |
| `DELETE /api/notifications/:id` | same; `Action.Manage, 'Settings'` | path `id` | 200, empty body | 400 numeric; 404 | DELETE |
| `POST /api/notifications/:id/test` | same; `Action.Manage, 'Settings'` | path `id`, no body | 201, `{ok: boolean, message: string}` (always 201, a failed send is `ok:false`, never an HTTP error) | 400 numeric; 404 `Notification connection #<id> not found` | one outbound HTTP request (rule 17) |


## Rules

### A. Entity, vocabulary, validation

1. Table `notification_connections`: `id`, `createdAt`, `updatedAt`, `name` varchar, `type` varchar, `settings` jsonb (default `{}`), `events` jsonb array (default `[]`), `enabled` boolean (default true).
2. Vocabulary (`NOTIFICATION_EVENTS`, 20, in this order): `request.created`, `request.approved`, `request.declined`, `request.processing`, `request.available`, `request.delete.created`, `request.delete.approved`, `request.delete.declined`, `grab.started`, `download.complete`, `health.issue`, `subtitle.downloaded`, `subtitle.upgraded`, `subtitle.failed`, `subtitle.synced`, `livetv.account_expiring`, `livetv.account_expired`, `livetv.adult_guard_failed`, `media.leaving_soon`, `media.cleaned_up`. Types (`NOTIFICATION_TYPES`): `discord`, `slack`, `webhook`, `gotify`, `ntfy`. Validation: `name` string; `type` one of the types; `settings` object + endpoint constraint (rule 4); `events` optional array of vocabulary names; `enabled` optional boolean. An unknown event is a 400 (`each value in events must be one of the following values: <18 values joined ", ">`, free-text validation message).
3. `GET /api/notifications/events` = the vocabulary minus `health.issue` (test-only: nothing dispatches it): 19 names, same order. `health.issue` stays a valid stored value (4.x connections).
4. Endpoint key per type (`ENDPOINT_KEY`): `discord`, `slack` → `settings.webhookUrl`; `webhook`, `gotify`, `ntfy` → `settings.url`. Constraint: the endpoint (for `url` types either `url` or `webhookUrl`, `url` winning when truthy) trimmed must match `/^https?:\/\//i`, else 400 message `<type> requires settings.<url|webhookUrl> to be an http(s) URL` (e.g. `ntfy requires settings.url to be an http(s) URL`); a blank or scheme-less endpoint fails; an unknown `type` is rejected by the type check, not by this constraint.

### B. Create, update, secrets

5. `create`: row `{name, type, settings: normalizeSettings(type, settings ?? {}), events: events ?? [], enabled: enabled ?? true}`, saved; response redacted. `update`: load by id (404 `Notification connection #<id> not found`), then each of `name`/`type`/`events`/`enabled` is assigned only when `!== undefined`; `settings` (when defined) is `normalizeSettings(dto.type, dto.settings, dto.type === previousType ? stored settings: undefined)`; save; response redacted. Because validation requires `name`, `type`, `settings`, in practice `PUT` replaces those three.
6. `normalizeSettings(type, settings, existing?)`: (1) every top-level string value is trimmed (nested values untouched); (2) webhook-addressed types (`discord`, `slack`): result = `mergeSecretFields(undefined, trimmed, [token])` (`mergeSecretFields(existing, trimmed, [token, webhookUrl])`, rule 24) (so a stored/sent `token` blank is dropped to `undefined`, `null` deleted, and the read-only marker `secretsSet` is removed); (3) server-addressed types: `webhookUrl` is folded onto `url` (`url = rest.url || webhookUrl`, `webhookUrl` removed; if the body has no `webhookUrl` the settings pass unchanged), then `mergeSecretFields(existing, folded, [token])`; (4) `gotify` with an empty merged `token` → 400 `gotify requires a non-empty settings.token` (also when the editor sends `token: null`). Other keys (`topic`, `username`, anything) are stored as sent.
7. Provider switch: `update` with a different `type` than the stored one passes `existing = undefined`, so the stored token is NOT carried over to another provider (the new connection starts without one; `gotify` then 400s if none sent).
8. Secret redaction (secret keys removed from responses and listed under `secretsSet`): the secret fields are `settings.token` and, for discord/slack, `settings.webhookUrl` (rule 24). Every connection response (`create`, `findAll`, `findOne`, `update`) has `settings` = stored settings with `token` deleted plus `secretsSet: string[]` (`["token"]` when a non-empty token is stored, else `[]`). `redactSecretFields` tests truthiness (`out[key]` set), so an empty-string token reports `[]`. The service's own reads keep the real token (senders need it): redaction happens in the controller only. Write convention (`mergeSecretFields`): incoming `token` absent or blank (any falsy) → keep the stored value; explicit `null` → erase; incoming `secretsSet` is always stripped, never persisted (a client echoing the GET marker back is safe).
9. Not redacted: `settings.url` of every type is returned in clear (an address, not a secret). Logs never print settings. `settings.webhookUrl` of `discord`/`slack` embeds its credential and is redacted (rule 24).

### C. Dispatch and senders

10. `dispatch(event, payload)`: `SELECT * FROM notification_connections WHERE enabled = true`, keep rows whose `events` array contains `event` (exact string match), then `send(conn, event, payload)` for all of them concurrently, waiting for all to settle (no order, no limit). A failing sender never affects the others nor the caller; only a failure of the SELECT rejects. Callers do not await it except the plugin host (rule 22).
11. `send` logs WARN `Failed to send notification via <conn.name>: <error message>` on any error and rethrows (so `dispatch` swallows it, `test` reports it). An unknown `type` (impossible through validation) logs WARN `Unknown notification type: <type>` and counts as success. Error messages must not contain the request URL: the gotify token travels in the query string (rule 26).
12. Common transport: one HTTP `POST` per send: 10 s total timeout, no retry, no backoff (rule 27), redirects followed (up to 10, POST rewritten to GET on 301/302), any non-2xx status is an error with message `Request failed with status code <n>`, JSON bodies sent as `application/json`. The response body is ignored. There is no rate limit, no batching, no queue, no persistence: a notification missed while the endpoint is down is lost. TLS uses reqwest `rustls-tls-webpki-roots` (bundled Mozilla roots), so https works on a minimal Docker image, macOS and Windows without a system store or OpenSSL.
13. Endpoint lookup `endpointOf` = `String(settings[ENDPOINT_KEY[type]] ?? '')` (no trimming at send time; trimmed at save).
14. Per-channel request (exact). `MSG` = `formatMessage(event, payload)` (rule 16). Missing-config errors are thrown BEFORE any request, literal strings (surface in the `test` response `message`):

| Type | Preconditions (else error `<msg>`) | URL | Headers | Body |
|---|---|---|---|---|
| `discord` | endpoint non-empty, else `webhookUrl not configured` | endpoint | none | JSON `{"username": String(settings.username ?? "Fliks"), "content": MSG, "allowed_mentions": {"parse": []}}` (rule 28) |
| `slack` | endpoint non-empty, else `webhookUrl not configured` | endpoint | none | JSON `{"text": MSG}` |
| `webhook` | endpoint non-empty, else `url not configured` | endpoint (as is) | `Authorization: Bearer <token>` only when `settings.token` is truthy | JSON `{"event": <event>,...payload}` (payload keys spread after `event`: a payload key named `event` would override it; keys with `undefined` values are omitted by JSON) |
| `gotify` | `url = endpoint` minus ONE trailing `/`; `token = String(settings.token ?? "")`; both non-empty, else `url and token required` | `<url>/message?token=<encodeURIComponent(token)>` (e.g. `a b&c` → `a%20b%26c`) | none | JSON `{"title": "Fliks — <event>", "message": MSG, "priority": 5}` (title uses an EM DASH U+2014) |
| `ntfy` | `url = endpoint` minus ONE trailing `/`, non-empty else `url not configured`; `topic = String(settings.topic \|\| "fliks")` (empty/missing → `fliks`); `token` used only if `typeof settings.token === "string"` | `<url>/<topic>` (topic NOT percent-encoded) | `Title: Fliks - <event>` (ASCII hyphen: non-latin1 header chars are dropped by the HTTP layer); `Authorization: Bearer <token>` only when token non-empty | the raw MSG string as body (sent with `Content-Type: application/x-www-form-urlencoded`; ntfy ignores it) |
15. No length limit or escaping is applied to MSG (Discord rejects > 2000 chars with a 400 that becomes a WARN); `title` values are interpolated raw (no Markdown escaping; mentions are neutralised by `allowed_mentions`, rule 28).
16. `formatMessage(event, payload)`, `title = (payload.title as string) ?? ''` (a missing or null title is the empty string, a non-string is stringified by template interpolation); `lang = String(payload.language ?? '')`; `src = String(payload.sourceName ?? '')`:

| Event | MSG | Payload keys read |
|---|---|---|
| `request.created` | `New request: <title>` | `title` |
| `request.approved` | `Request approved: <title>` | `title` |
| `request.declined` | `Request declined: <title>` | `title` |
| `request.delete.created` | `New deletion request: <title>` | `title` |
| `request.delete.approved` | `Deletion request approved: <title>` | `title` |
| `request.delete.declined` | `Deletion request declined: <title>` | `title` |
| `request.processing` | `Request downloading: <title>` | `title` |
| `request.available` | `Request available: <title>` | `title` |
| `grab.started` | `Grabbing: <title>` | `title` |
| `download.complete` | `Download complete: <title>` | `title` |
| `health.issue` | `String(payload.message ?? "Health issue detected")` | `message` |
| `subtitle.downloaded` | `Subtitle downloaded: <title> [<lang>]` | `title`, `language` |
| `subtitle.upgraded` | `Subtitle upgraded: <title> [<lang>]` | `title`, `language` |
| `subtitle.failed` | `Subtitle download failed: <title> [<lang>]` | `title`, `language` |
| `subtitle.synced` | `Subtitle synced [<lang>]` (no title) | `language` |
| `livetv.account_expiring` | `Live TV source "<src>" account expires soon` | `sourceName` |
| `livetv.account_expired` | `Live TV source "<src>" account has expired` | `sourceName` |
| `livetv.adult_guard_failed` | `Live TV source "<src>" adult-group restriction pass failed` | `sourceName` |
| `media.leaving_soon` | `Leaving soon: <title>[ S<ss>[E<ee>]]`, then ` (<n> days)` when `daysLeft` is an integer (`1 day` for 1) | `title`, `seasonNumber`, `episodeNumber`, `daysLeft` |
| `media.cleaned_up` | `Cleaned up: <title>[ S<ss>[E<ee>]]` | `title`, `seasonNumber`, `episodeNumber` |
| any other string | `<event>: <JSON.stringify(payload)>` | whole payload (unreachable: events are validated, rule 29) |

   Other payload keys (`mediaType`, `reason`, `quality`, `sourceTitle`, `provider`, `score`, `oldScore`, `newScore`, `error`, `subtitleId`, `expiresAt`) are NOT in MSG; they reach only the `webhook` channel.
17. `POST:id/test`: loads the connection (404), then `send(conn, 'health.issue', {test: true, message: 'Test notification from Fliks'})` regardless of `enabled` and of the connection's `events`; success → `{ok: true, message: 'Test notification sent'}`; any error → `{ok: false, message: <error.message>}` (HTTP 201 both ways). Resulting message per channel: discord `content` / slack `text` / ntfy body / gotify `message` = `Test notification from Fliks`; webhook body `{"event":"health.issue","test":true,"message":"Test notification from Fliks"}`; gotify title `Fliks — health.issue`, ntfy `Title: Fliks - health.issue`. Error `message` texts: the literals of rule 14 for missing config; transport errors carry no request URL (rule 26): `Request failed with status code <n>` is exact, the rest is free text.
18. `GET /api/notifications` sorts by `name` (sorted bytewise); `DELETE` removes the row with no dependants (nothing references `notification_connections`); the setup checklist's `notification` item is `count(*) > 0`.

### D. Dispatch callers

19. Callers (all fire-and-forget unless noted); payloads exactly as emitted:

| Event | Payload |
|---|---|
| `request.created` / `request.approved` (create) | `{title, mediaType}` |
| `request.approved` (approve) | `{title}` |
| `request.delete.created` / `request.delete.approved` | `{title, mediaType}` |
| `request.declined` / `request.delete.declined` | `{title, reason}` |
| `request.processing` / `request.available` | `{title, mediaType}` |
| `download.complete` | `{title, quality, sourceTitle}` |
| `grab.started` | plugin-supplied free `payload` (host method `notifications.dispatch`, awaited) |
| `subtitle.downloaded` | `{title, language, provider, score}` |
| `subtitle.failed` | `{title, language, error}` |
| `subtitle.upgraded` | `{title (may be undefined), language, oldScore, newScore, provider}` |
| `subtitle.synced` | `{language, subtitleId}` |
| `livetv.account_expired` / `livetv.account_expiring` | `{sourceName, expiresAt: ISO\|null}` (only on state transition) |
| `livetv.adult_guard_failed` | `{sourceName}` |
| `media.leaving_soon` | `{title, mediaId, deleteAt, daysLeft}` plus `seasonNumber` (and `episodeNumber`) for a season (episode) scope |
| `media.cleaned_up` | `{title, mediaId, action}` plus `seasonNumber` (and `episodeNumber`) for a season (episode) scope |
| `health.issue` | `{test: true, message}` |

20. `NotificationsService::dispatch(event, payload)` is the one in-process entry point for the 11 call sites above; the event is a typed value from the 18-name vocabulary, so an event outside it cannot be dispatched.
21. `dispatch` returns after every matching sender settled (success or failure); per-connection failures never change the outcome (they are logged, rule 11). Only a failure of the connections SELECT is an error to the caller. Fire-and-forget callers log and drop it; the plugin host awaits it, so a failure reaches the plugin. Senders are bounded by 10 s (rule 27).
22. Plugin host path: the awaited `notifications.dispatch` host method (`grab.started`) resolves after all senders settled; a plugin-supplied `event` outside the 18-name vocabulary is rejected with 400 before any sender runs (rule 29).
23. The `notifications` module has no timers, no settings keys, no SSE events and no domain events (it emits none and subscribes to none: callers invoke it directly, hub spec "Not subscribers").

### E. Hardening

24. `settings.webhookUrl` of `discord` and `slack` is a secret field with `token` (`secretsSet` convention): omitted from every response, `secretsSet` lists it when non-empty (`["webhookUrl"]`, `["token"]` or both), a blank or absent value on write keeps the stored one, an echoed `secretsSet` is stripped; `settings.url` of the other types stays in clear. The endpoint constraint (rule 4) applies to the effective value (the stored one when the write leaves it blank or absent, none for `null`), so the required URL can be replaced but never erased (`null` → 400); `create` still requires a valid endpoint. Client: the notification editor shows the masked "set" state like for `token`, with no clear action.
25. A `type` switch on update (rule 7) drops the stored `webhookUrl` too. The web editor mirrors it: the stored-secret mask and hints (token, `webhookUrl`) show only while the form type is the connection's stored type.
26. Sender errors, logs and the `test` response never contain the request URL (gotify token in the query, Discord/Slack webhook secret): HTTP status errors keep `Request failed with status code <n>`, transport errors use the OS/DNS text without the URL (free text), a timeout reports `timeout of 10000ms exceeded`.
27. Every sender request has a 10 s total timeout; no retry; `test` reports the timeout as `{ok: false, message}`; `dispatch` still returns only after every sender settled, so it is bounded by 10 s.
28. Discord payloads are `{"username":..., "content": MSG, "allowed_mentions": {"parse": []}}` (no `@everyone`/role/user mention injection); other channels unchanged.
29. A plugin-supplied `event` outside the 18-name vocabulary is rejected with 400 (`{"message": <string[]>, "error": "Bad Request", "statusCode": 400}`) before any sender runs; the dispatcher takes a typed event. Ids beyond int4, non-integer ids and null on non-nullable fields (`events`, `enabled`) on `GET`/`PUT`/`DELETE`/`test:id` answer 400 or 404, never 500. Admin-set endpoints are accepted as given (SSRF accepted, admin only).


## SQL

1. List: `SELECT * FROM notification_connections ORDER BY name ASC`.
2. By id (get, update, delete, test): `SELECT * FROM notification_connections WHERE id = $1`; update = `UPDATE notification_connections SET <changed columns>, "updatedAt" = now WHERE id = $1 RETURNING *`; delete = `DELETE FROM notification_connections WHERE id = $1`; create = `INSERT... RETURNING id, "createdAt", "updatedAt"` (`settings` and `events` as jsonb).
3. Dispatch: `SELECT * FROM notification_connections WHERE enabled = true` (no ORDER BY), `events` filtered in application code (`WHERE enabled AND events ? $1` gives the same result).
4. Setup checklist: `SELECT count(*) FROM notification_connections`.

## Events

none emitted (no SSE, no domain event). Consumers of this module's input are the callers of rule 19. Domain events seen by the request lifecycle that lead to notifications are in `requests.md` (Events).

## Settings keys

none. Each connection carries its own configuration in `settings`: `url` | `webhookUrl` (endpoint), `token` (secret; webhook bearer, gotify app token, ntfy bearer), `topic` (ntfy, default `fliks`), `username` (discord, default `Fliks`); unknown keys are kept verbatim.

## Jobs/timers

none (no retry queue, no periodic job; senders are one-shot with a 10 s timeout, rule 12).

## Vectors/parity

Vector set `notifications` (`server/fixtures/notifications/cases.json`, 410 cases, replayed by `server/crates/domain/tests/notifications.rs`; `BLESS=1` rewrites `expected`). Input `{fn, type, settings, event, payload}`, expected `{message}`, `{url, headers, body}` or `{error}`. Cases:
- `format-<event>`: the 18 rows of rule 16 × 5 channels = 90 cases with payloads from rule 19 (e.g. `request.available {title:'Dune', mediaType:'movie'}` → discord `{username:'Fliks', content:'Request available: Dune', allowed_mentions:{parse:[]}}`, slack `{text}`, webhook `{event:'request.available', title:'Dune', mediaType:'movie'}`, gotify `{title:'Fliks — request.available', message, priority:5}` at `…/message?token=<enc>`, ntfy body + `Title: Fliks - request.available`).
- Edge payloads: missing/`null` title (`New request: `), `title` undefined on `subtitle.upgraded`, missing `language` (`[]`), `health.issue` with and without `message`, missing `sourceName` (`Live TV source ""…`), unknown event default branch (`<event>: {json}`), webhook payload containing an `event` key, non-ASCII title (ntfy body UTF-8, `Title` header stays ASCII).
- Channel config: discord with/without `username`; webhook with/without token; gotify trailing slash, token needing encoding (`a b&c`), missing url/token (`url and token required`); ntfy trailing slash, empty topic → `fliks`, token present/absent/non-string, missing url (`url not configured`); discord/slack/webhook missing endpoint (`webhookUrl not configured`, `webhookUrl not configured`, `url not configured`).
- `normalize-*`: `webhookUrl` folded for webhook/gotify/ntfy; discord/slack stay on `webhookUrl`; `url` wins when both; trimmed endpoint and topic; gotify without token 400; blank token keeps the stored one; `null` erases it (ntfy) / 400 (gotify); `secretsSet` marker never persisted (ntfy and discord); provider switch drops the token; normalize on update.
- `validate-*`: ntfy without endpoint, either key accepted, blank endpoint, scheme-less endpoint (messages of rule 4); every one of the 18 events validates; unknown event rejected; subscribable list = 17 and storable.
- `redact-*`: token present → `secretsSet:['token']`; none → `[]`; endpoint/topic kept; discord/slack `webhookUrl` omitted and listed in `secretsSet` (rule 24); blank write keeps it, `null` fails validation (400).

Rust integration tests (`server/crates/server/tests/it/notifications.rs`, axum mock receiver, no external network) cover transport behaviour the vectors cannot: non-2xx → `Request failed with status code <n>`, closed port, redirect handling, no URL/token in logged or returned error text (rule 26), a receiver that never answers → timeout after 10 s with `ok:false` (rule 27; the test uses a paused clock), the Discord `allowed_mentions` body (rule 28), and the dispatch path (enabled and subscribed connections only, unknown event refused).

Parity scenarios (`server/parity/scenarios/notifications/`, 23 scenarios; the runner has no outbound receiver, so `test-*` scenarios need a loopback mock URL in the seeded connection or run as Rust integration tests): `create-ntfy`, `create-gotify-no-token-400`, `create-validation-400` (bad type, bad event, bad endpoint), `create-webhook-legacy-url`, `list` (token never present, `secretsSet` present), `events-list` (17 names), `get`, `get-404`, `get-badid` (id beyond int4: 400/404), `get-nonnumeric-400`, `update-keeps-token`, `update-null-clears-token`, `update-null-fields`, `update-type-switch`, `update-validation-400`, `update-404`, `webhookurl-masked` (discord: `secretsSet:['webhookUrl']`), `delete`, `delete-404`, `test-404`, `test-fail`, plus `unauthenticated` (401) and `forbidden` (403 for a `user`/`readonly` actor, no `settings.access`).

## Open questions

1. Fire-and-forget callers drop notifications silently when the server is restarting (a dispatch failure is only logged); a restart also loses in-flight ones. Acceptable, confirm.
2. Discord content is not truncated or escaped (rule 15): a 2000+ char payload is delivered as is and rejected by Discord with a 400 (WARN). The `allowed_mentions` field only neutralises mentions. Keep unless a fix is wanted.

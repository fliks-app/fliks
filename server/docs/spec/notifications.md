# Spec: notifications (connections, senders, dispatch bridge)

Sources: `src/modules/notifications/{notifications.controller,notifications.service,notifications.module}.ts`, `src/modules/notifications/dto/create-notification-connection.dto.ts`, `src/modules/notifications/entities/notification-connection.entity.ts`, `src/common/utils/secret-fields.util.ts`, spec `src/modules/notifications/notifications.service.spec.ts`, every `notifications.dispatch` caller (listed in Events). Milestone: S4 (the request callers move in S5, plan §15.3; until then Nest's request code dispatches through the bridge). Tag paths are relative to `backend/`. Auth, CASL, error bodies: `auth.md` ("auth rule N"). Requests that dispatch: `requests.md`.

## Routes

7 routes. Manifest filter: `jq '[.[]|select(.path|test("^/api/notifications"))]|length' server/contract/nest-routes.json` = 7. Class-level guards `JwtOrApiKeyGuard, PoliciesGuard` `[ts:src/modules/notifications/notifications.controller.ts:24]`; `scope:'stream'` tokens are rejected by the Rust extractor (F8). No `httpCode`: POST = 201, DELETE = 200 (empty). Declaration order: `GET events` before `GET :id` (spec asserts it: `[ts:src/modules/notifications/notifications.service.spec.ts:258]`). Read policies need `settings.access` (it grants both `Read` and `Manage` on `Settings`, `casl-ability.factory.ts:132`, auth rule 25).

`ConnectionJSON` = `{id: number, createdAt: ISO, updatedAt: ISO, name: string, type: 'discord'|'slack'|'webhook'|'gotify'|'ntfy', settings: object, events: string[], enabled: boolean}` with `settings` redacted (rule 8; `webhookUrl` of discord/slack is a secret too, F28 rule 24).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `POST /api/notifications` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `(ability) => ability.can(Action.Manage, 'Settings')` | body `CreateNotificationConnectionDto` (rule 2): `name` string, `type` in the 5 types, `settings` object (endpoint rule), `events?` string[] of the 18 names, `enabled?` boolean | 201, `ConnectionJSON` (redacted, saved row) | 400 validation (auth rule 16, C1 rule 29); 400 `gotify requires a non-empty settings.token` | INSERT `notification_connections` |
| `GET /api/notifications` | same; `Action.Read, 'Settings'` | none | `ConnectionJSON[]` `ORDER BY name ASC` | 401, 403 | none |
| `GET /api/notifications/events` | same; `Action.Read, 'Settings'` | none | `string[]`: the 17 subscribable events in vocabulary order (rule 3) | 401, 403 | none |
| `GET /api/notifications/:id` | same; `Action.Read, 'Settings'` | path `id` `ParseIntPipe` | `ConnectionJSON` | 400 `Validation failed (numeric string is expected)`; 404 `Notification connection #<id> not found` | none |
| `PUT /api/notifications/:id` | same; `Action.Manage, 'Settings'` | path `id`; body = the SAME `CreateNotificationConnectionDto` (so `name`, `type`, `settings` are required; `events?`, `enabled?` optional) | 200, `ConnectionJSON` (saved row, redacted) | 400; 404; 400 gotify token | UPDATE (rules 5-7) |
| `DELETE /api/notifications/:id` | same; `Action.Manage, 'Settings'` | path `id` | 200, empty body | 400 numeric; 404 | DELETE |
| `POST /api/notifications/:id/test` | same; `Action.Manage, 'Settings'` | path `id`, no body | 201, `{ok: boolean, message: string}` (always 201, a failed send is `ok:false`, never an HTTP error) | 400 numeric; 404 `Notification connection #<id> not found` | one outbound HTTP request (rule 17) |

Manifest lines: `[ts:src/modules/notifications/notifications.controller.ts:28]`, `:36`, `:43`, `:49`, `:55`, `:64`, `:70`.

## Rules

### A. Entity, vocabulary, validation

1. Table `notification_connections`: `id`, `createdAt`, `updatedAt`, `name` varchar, `type` varchar, `settings` jsonb (default `{}`), `events` jsonb array (default `[]`), `enabled` boolean (default true). `[ts:src/modules/notifications/entities/notification-connection.entity.ts:43]`–`[ts:src/modules/notifications/entities/notification-connection.entity.ts:59]`
2. Vocabulary (`NOTIFICATION_EVENTS`, 18, in this order): `request.created`, `request.approved`, `request.declined`, `request.processing`, `request.available`, `request.delete.created`, `request.delete.approved`, `request.delete.declined`, `grab.started`, `download.complete`, `health.issue`, `subtitle.downloaded`, `subtitle.upgraded`, `subtitle.failed`, `subtitle.synced`, `livetv.account_expiring`, `livetv.account_expired`, `livetv.adult_guard_failed`. Types (`NOTIFICATION_TYPES`): `discord`, `slack`, `webhook`, `gotify`, `ntfy`. DTO: `name` `@IsString`; `type` `@IsIn(types)`; `settings` `@IsObject` + endpoint constraint (rule 4); `events` `@IsArray @IsIn(events,{each:true}) @IsOptional`; `enabled` `@IsBoolean @IsOptional`. An unknown event is a 400 (class-validator default text `each value in events must be one of the following values: <18 values joined ", ">` `[assumed]`, free-text validation message, runner compares status + `error`). `[ts:src/modules/notifications/entities/notification-connection.entity.ts:4]`–`[ts:src/modules/notifications/entities/notification-connection.entity.ts:41]`, `[ts:src/modules/notifications/dto/create-notification-connection.dto.ts:41]`–`[ts:src/modules/notifications/dto/create-notification-connection.dto.ts:60]`
3. `GET /api/notifications/events` = the vocabulary minus `health.issue` (test-only: nothing dispatches it): 17 names, same order. `health.issue` stays a valid stored value (older connections). `[ts:src/modules/notifications/notifications.service.ts:23]`–`[ts:src/modules/notifications/notifications.service.ts:30]`, `[ts:src/modules/notifications/notifications.controller.ts:42]`–`[ts:src/modules/notifications/notifications.controller.ts:47]`
4. Endpoint key per type (`ENDPOINT_KEY`): `discord`, `slack` → `settings.webhookUrl`; `webhook`, `gotify`, `ntfy` → `settings.url`. DTO constraint: the endpoint (for `url` types either `url` or the legacy `webhookUrl`, `url` winning when truthy) trimmed must match `/^https?:\/\//i`, else 400 message `<type> requires settings.<url|webhookUrl> to be an http(s) URL` (e.g. `ntfy requires settings.url to be an http(s) URL`); a blank or scheme-less endpoint fails; an unknown `type` is rejected by `@IsIn`, not by this constraint. `[ts:src/modules/notifications/dto/create-notification-connection.dto.ts:20]`–`[ts:src/modules/notifications/dto/create-notification-connection.dto.ts:39]`, `[ts:src/modules/notifications/entities/notification-connection.entity.ts:10]`–`[ts:src/modules/notifications/entities/notification-connection.entity.ts:16]`, spec `[ts:src/modules/notifications/notifications.service.spec.ts:194]`–`[ts:src/modules/notifications/notifications.service.spec.ts:236]`

### B. Create, update, secrets

5. `create`: row `{name, type, settings: normalizeSettings(type, settings ?? {}), events: events ?? [], enabled: enabled ?? true}`, saved; response redacted. `update`: load by id (404 `Notification connection #<id> not found`), then each of `name`/`type`/`events`/`enabled` is assigned only when `!== undefined`; `settings` (when defined) is `normalizeSettings(dto.type, dto.settings, dto.type === previousType ? stored settings : undefined)`; save; response redacted. Because the DTO requires `name`, `type`, `settings`, in practice `PUT` replaces those three. `[ts:src/modules/notifications/notifications.service.ts:60]`–`[ts:src/modules/notifications/notifications.service.ts:104]`
6. `normalizeSettings(type, settings, existing?)`: (1) every top-level string value is trimmed (nested values untouched); (2) webhook-addressed types (`discord`, `slack`): result = `mergeSecretFields(undefined, trimmed, [token])` (Rust: `mergeSecretFields(existing, trimmed, [token, webhookUrl])`, F28) (so a stored/sent `token` blank is dropped to `undefined`, `null` deleted, and the read-only marker `secretsSet` is removed); (3) server-addressed types: `webhookUrl` is folded onto `url` (`url = rest.url || webhookUrl`, `webhookUrl` removed; if the body has no `webhookUrl` the settings pass unchanged), then `mergeSecretFields(existing, folded, [token])`; (4) `gotify` with an empty merged `token` → 400 `gotify requires a non-empty settings.token` (also when the editor sends `token: null`). Other keys (`topic`, `username`, anything) are stored as sent. `[ts:src/modules/notifications/notifications.service.ts:224]`–`[ts:src/modules/notifications/notifications.service.ts:255]`
7. Provider switch: `update` with a different `type` than the stored one passes `existing = undefined`, so the stored token is NOT carried over to another provider (the new connection starts without one; `gotify` then 400s if none sent). `[ts:src/modules/notifications/notifications.service.ts:92]`–`[ts:src/modules/notifications/notifications.service.ts:99]`, spec `[ts:src/modules/notifications/notifications.service.spec.ts:160]`–`[ts:src/modules/notifications/notifications.service.spec.ts:174]`
8. Secret redaction (the F5 convention, already implemented here and pinned by plan §15.1: secret keys removed from responses and listed under `secretsSet`): in Nest the only secret field is `settings.token` (Rust adds `webhookUrl` of discord/slack, F28, rule 24). Every connection response (`create`, `findAll`, `findOne`, `update`) has `settings` = stored settings with `token` deleted plus `secretsSet: string[]` (`["token"]` when a non-empty token is stored, else `[]`). `redactSecretFields` tests truthiness (`out[key]` set), so an empty-string token reports `[]`. The service's own reads keep the real token (senders need it): redaction happens in the controller only. Write convention (`mergeSecretFields`): incoming `token` absent or blank (any falsy) → keep the stored value; explicit `null` → erase; incoming `secretsSet` is always stripped, never persisted (a client echoing the GET marker back is safe). `[ts:src/modules/notifications/notifications.service.ts:32]`–`[ts:src/modules/notifications/notifications.service.ts:45]`, `[ts:src/common/utils/secret-fields.util.ts:6]`–`[ts:src/common/utils/secret-fields.util.ts:38]`, `[ts:src/common/plugin-contract/ui-contribution.ts:74]`, spec `[ts:src/modules/notifications/notifications.service.spec.ts:94]`–`[ts:src/modules/notifications/notifications.service.spec.ts:158]`, `[ts:src/modules/notifications/notifications.service.spec.ts:385]`–`[ts:src/modules/notifications/notifications.service.spec.ts:405]`
9. Not redacted: `settings.webhookUrl` of `discord`/`slack` (a Discord/Slack webhook URL embeds its credential) and `settings.url` of every type are returned in clear; the comment in the source treats the endpoint as "an address, not a secret". Logs never print settings. Rust changes this for `webhookUrl` (F28, rule 24).

### C. Dispatch and senders

10. `dispatch(event, payload)`: `SELECT * FROM notification_connections WHERE enabled = true`, keep rows whose `events` array contains `event` (exact string match), then `Promise.allSettled` of `send(conn, event, payload)` for all of them concurrently (no order, no limit). A failing sender never affects the others nor the caller; only a failure of the SELECT rejects. Callers do not await it except the plugin host (rule 22). `[ts:src/modules/notifications/notifications.service.ts:115]`–`[ts:src/modules/notifications/notifications.service.ts:123]`
11. `send` logs WARN `Failed to send notification via <conn.name>: <error message>` on any error and rethrows (so `dispatch` swallows it via `allSettled`, `test` reports it). An unknown `type` (impossible through the DTO) logs WARN `Unknown notification type: <type>` and counts as success. Error messages must not contain the request URL: the gotify token travels in the query string (F29, rule 26). `[ts:src/modules/notifications/notifications.service.ts:143]`–`[ts:src/modules/notifications/notifications.service.ts:222]`
12. Common transport: one HTTP `POST` per send via axios 1.x defaults: no timeout (`timeout: 0`), no retry, no backoff, redirects followed (follow-redirects default), any non-2xx status is an error with message `Request failed with status code <n>`, JSON bodies sent as `application/json`. The response body is ignored. There is no rate limit, no batching, no queue, no persistence: a notification missed while the endpoint is down is lost. `[ts:src/modules/notifications/notifications.service.ts:154]`, axios `lib/defaults/index.js:149,162` (`timeout: 0`, `validateStatus` 2xx) `[assumed]` for the redirect default (verify with a mock). Rust: 10 s timeout, no retry (C16, rule 27); redirect policy Q1.
13. Endpoint lookup `endpointOf` = `String(settings[ENDPOINT_KEY[type]] ?? '')` (no trimming at send time; trimmed at save). `[ts:src/modules/notifications/notifications.service.ts:138]`–`[ts:src/modules/notifications/notifications.service.ts:141]`
14. Per-channel request (exact). `MSG` = `formatMessage(event, payload)` (rule 16). Missing-config errors are thrown BEFORE any request, literal strings (surface in the `test` response `message`):

| Type | Preconditions (else `throw new Error(<msg>)`) | URL | Headers (besides axios defaults) | Body |
|---|---|---|---|---|
| `discord` | endpoint non-empty, else `webhookUrl not configured` | endpoint | none | JSON `{"username": String(settings.username ?? "Fliks"), "content": MSG}` |
| `slack` | endpoint non-empty, else `webhookUrl not configured` | endpoint | none | JSON `{"text": MSG}` |
| `webhook` | endpoint non-empty, else `url not configured` | endpoint (as is) | `Authorization: Bearer <token>` only when `settings.token` is truthy | JSON `{"event": <event>, ...payload}` (payload keys spread after `event`: a payload key named `event` would override it; keys with `undefined` values are omitted by JSON) |
| `gotify` | `url = endpoint` minus ONE trailing `/`; `token = String(settings.token ?? "")`; both non-empty, else `url and token required` | `<url>/message?token=<encodeURIComponent(token)>` (e.g. `a b&c` → `a%20b%26c`) | none | JSON `{"title": "Fliks — <event>", "message": MSG, "priority": 5}` (title uses an EM DASH U+2014) |
| `ntfy` | `url = endpoint` minus ONE trailing `/`, non-empty else `url not configured`; `topic = String(settings.topic \|\| "fliks")` (empty/missing → `fliks`); `token` used only if `typeof settings.token === "string"` | `<url>/<topic>` (topic NOT percent-encoded) | `Title: Fliks - <event>` (ASCII hyphen: non-latin1 header chars are dropped by the HTTP layer); `Authorization: Bearer <token>` only when token non-empty | the raw MSG string as body (axios adds `Content-Type: application/x-www-form-urlencoded` for a string body on POST, `[assumed]` from axios `lib/core/dispatchRequest.js:49`; ntfy ignores it, record with a mock server) |

   `[ts:src/modules/notifications/notifications.service.ts:152]`–`[ts:src/modules/notifications/notifications.service.ts:212]`, spec `[ts:src/modules/notifications/notifications.service.spec.ts:311]`–`[ts:src/modules/notifications/notifications.service.spec.ts:383]`
15. No length limit or escaping is applied to MSG (Discord truncates/rejects > 2000 chars with a 400 that becomes a WARN); `title` values are interpolated raw (no Markdown escaping, no mention neutralisation in Nest; Rust Discord payloads add `allowed_mentions`, F30, rule 28). `[ts:src/modules/notifications/notifications.service.ts:257]`–`[ts:src/modules/notifications/notifications.service.ts:303]`
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
| any other string | `<event>: <JSON.stringify(payload)>` | whole payload (unreachable through the DTO; reachable only if a caller passes an unlisted event, rule 24) |

   Other payload keys (`mediaType`, `reason`, `quality`, `sourceTitle`, `provider`, `score`, `oldScore`, `newScore`, `error`, `subtitleId`, `expiresAt`) are NOT in MSG; they reach only the `webhook` channel. `[ts:src/modules/notifications/notifications.service.ts:257]`–`[ts:src/modules/notifications/notifications.service.ts:303]`
17. `POST :id/test`: loads the connection (404), then `send(conn, 'health.issue', {test: true, message: 'Test notification from Fliks'})` regardless of `enabled` and of the connection's `events`; success → `{ok: true, message: 'Test notification sent'}`; any error → `{ok: false, message: <error.message>}` (HTTP 201 both ways). Resulting message per channel: discord `content` / slack `text` / ntfy body / gotify `message` = `Test notification from Fliks`; webhook body `{"event":"health.issue","test":true,"message":"Test notification from Fliks"}`; gotify title `Fliks — health.issue`, ntfy `Title: Fliks - health.issue`. Error `message` texts: the literals of rule 14 for missing config; transport errors are Node/axios text (`Request failed with status code 401`, `connect ECONNREFUSED 127.0.0.1:9`, `getaddrinfo ENOTFOUND host`, `timeout of Nms exceeded`): `Request failed with status code <n>` is matched exactly, the rest is free text. `[ts:src/modules/notifications/notifications.service.ts:125]`–`[ts:src/modules/notifications/notifications.service.ts:136]`
18. `GET /api/notifications` sorts by `name` (DB collation, compared order-insensitively by parity, Rust sorts bytewise); `DELETE` removes the row with no dependants (nothing references `notification_connections`); the setup checklist's `notification` item is `count(*) > 0` (S8). `[ts:src/modules/notifications/notifications.service.ts:73]`–`[ts:src/modules/notifications/notifications.service.ts:75]`, `[ts:src/modules/setup-checklist/setup-checklist.service.ts:93]`–`[ts:src/modules/setup-checklist/setup-checklist.service.ts:96]`

### D. Dispatch callers and the bridge

19. Callers today (all `void notifications.dispatch(...)` fire-and-forget unless noted); payloads exactly as emitted:

| Event | Payload | Caller | Moves in |
|---|---|---|---|
| `request.created` / `request.approved` (create) | `{title, mediaType}` | `[ts:src/modules/requests/requests.service.ts:360]` | S5 (Rust; bridge client until then) |
| `request.approved` (approve) | `{title}` | `[ts:src/modules/requests/requests.service.ts:876]` | S5 |
| `request.delete.created` / `request.delete.approved` | `{title, mediaType}` | `[ts:src/modules/requests/requests.service.ts:434]`, `:926` | S5 |
| `request.declined` / `request.delete.declined` | `{title, reason}` | `[ts:src/modules/requests/requests.service.ts:1055]` | S5 |
| `request.processing` / `request.available` | `{title, mediaType}` | `[ts:src/modules/requests/request-lifecycle.service.ts:209]`, `:246` | S5 |
| `download.complete` | `{title, quality, sourceTitle}` | `[ts:src/modules/plugins/host/fliks-host.service.ts:856]`, `:985` | S8 (bridge) |
| `grab.started` | plugin-supplied free `payload` (host method `notifications.dispatch`, closed to `'grab.started'` by TS type only) | `[ts:src/modules/plugins/host/fliks-host.service.ts:1049]` (awaited), `[ts:src/common/plugin-contract/host-methods.ts:251]` | S8 (bridge) |
| `subtitle.downloaded` | `{title, language, provider, score}` | `[ts:src/modules/scheduler/subtitle-scheduler.service.ts:265]` | S6 |
| `subtitle.failed` | `{title, language, error}` | `[ts:src/modules/scheduler/subtitle-scheduler.service.ts:286]` | S6 |
| `subtitle.upgraded` | `{title (may be undefined), language, oldScore, newScore, provider}` | `[ts:src/modules/scheduler/subtitle-scheduler.service.ts:491]` | S6 |
| `subtitle.synced` | `{language, subtitleId}` | `[ts:src/modules/subtitles/subtitle-sync.service.ts:268]` | S6 |
| `livetv.account_expired` / `livetv.account_expiring` | `{sourceName, expiresAt: ISO\|null}` (only on state transition) | `[ts:src/modules/livetv/services/livetv-sources.service.ts:502]`, `:503` | S7 |
| `livetv.adult_guard_failed` | `{sourceName}` | `[ts:src/modules/livetv/services/livetv-sources.service.ts:466]` | S7 |
| `health.issue` | `{test: true, message}` | `test` route only | S4 |

20. Until the last Nest caller moves (S8, plan §10), Nest's `NotificationsService` is a bridge client with the same `dispatch(event, payload): Promise<void>` signature, so the 11 call sites above are unchanged; Nest's CRUD, senders, `formatMessage` and the controller are deleted in S4.
21. **Bridge `POST /internal/notifications/dispatch`** (Rust endpoint, Nest→Rust; loopback only, `Authorization: Bearer $FLIKS_BRIDGE_TOKEN`, constant-time compare; not under `/api`, public fallback 404s `/internal/**`). Shape is not fixed by Nest `[assumed]` (plan §6.4 names the endpoint only):
   - Request: `Content-Type: application/json`, body `{"event": <one of the 18 vocabulary strings>, "payload": <JSON object>}`; both required; `payload` may be `{}`; no other keys (unknown key = 400).
   - 204, empty body: returned after the dispatch finished, i.e. after every matching sender settled (success or failure), exactly the resolution point of Nest's `dispatch` promise; per-connection failures never change the status (they are logged, rule 11).
   - 400 `{"message": <string[]>, "error": "Bad Request", "statusCode": 400}` (a malformed JSON body: `message` a string) for a missing/non-string `event`, an event outside the vocabulary, or a non-object `payload`; 401 (missing/wrong bridge token, auth rule 14 body); 500 only when the connections SELECT fails (the same condition under which Nest's `dispatch` rejects).
   - Client behaviour (Nest side): `dispatch` catches and logs any failure (fire-and-forget callers `void dispatch(...)`, today an SELECT failure is an unhandled rejection); `dispatchStrict` rethrows and is what the plugin host awaits, so a failure reaches the plugin like today. The HTTP call has a 15 s abort (senders are bounded by 10 s).
   - Removed: when its last caller (plugin host, S8) moves; the livetv (S7) and subtitles (S6) callers disappear earlier.
22. Plugin host path: the awaited `notifications.dispatch` host method (`grab.started`) resolves after all senders settled (`Promise.allSettled`); the `event` string is NOT validated at runtime today, so a plugin can inject any string (e.g. `request.created`) and an unknown string falls to the `default` message (rule 16). The bridge validation of rule 21 and C17 (rule 29) close this. `[ts:src/modules/plugins/host/fliks-host.service.ts:1042]`–`[ts:src/modules/plugins/host/fliks-host.service.ts:1050]`
23. The `notifications` module has no timers, no settings keys, no SSE events and no domain events (it emits none and subscribes to none: callers invoke it directly, hub spec "Not subscribers").

### E. Deviations decided for the port (plan §15.3)

24. [new] F28: `settings.webhookUrl` of `discord` and `slack` is a secret field with `token` (F5 `secretsSet` convention): omitted from every response, `secretsSet` lists it when non-empty (`["webhookUrl"]`, `["token"]` or both), a blank or absent value on write keeps the stored one, an echoed `secretsSet` is stripped; `settings.url` of the other types stays in clear. The DTO endpoint constraint (rule 4) applies to the effective value (the stored one when the write leaves it blank or absent, none for `null`), so the required URL can be replaced but never erased (`null` → 400); `create` still requires a valid endpoint. Client: the notification editor shows the masked "set" state like for `token`, with no clear action.
25. [new] F28 corollary: a `type` switch on update (rule 7) drops the stored `webhookUrl` too. The web editor mirrors it: the stored-secret mask and hints (token, `webhookUrl`) show only while the form type is the connection's stored type.
26. [new] F29: sender errors, logs and the `test` response never contain the request URL (gotify token in the query, Discord/Slack webhook secret): HTTP status errors keep `Request failed with status code <n>`, transport errors use the OS/DNS text without the URL (`connect ECONNREFUSED`, `getaddrinfo ENOTFOUND <host>` forms are not reproduced byte for byte, free text), a timeout reports `timeout of 10000ms exceeded`.
27. [new] C16: every sender request has a 10 s total timeout; no retry (as Nest); `test` reports the timeout as `{ok: false, message}`; `dispatch` still returns only after every sender settled, so it is bounded by 10 s.
28. [new] F30: Discord payloads are `{"username": ..., "content": MSG, "allowed_mentions": {"parse": []}}` (no `@everyone`/role/user mention injection); other channels unchanged.
29. [new] C17: a plugin-supplied (and bridge-supplied) `event` outside the 18-name vocabulary is rejected with 400 (rule 21 body) before any sender runs; the Rust dispatcher takes a typed event. C1 extended: ids beyond int4, non-integer ids and null on non-nullable fields on `GET`/`PUT`/`DELETE`/`test :id` answer 400 or 404, never 500. Kept as is (§15.3): admin-set endpoints are accepted as given (SSRF accepted, admin only).


## SQL

1. List: `SELECT * FROM notification_connections ORDER BY name ASC` `[ts:src/modules/notifications/notifications.service.ts:74]`.
2. By id (get, update, delete, test): `SELECT * FROM notification_connections WHERE id = $1`; update = `UPDATE notification_connections SET <changed columns>, "updatedAt" = now() WHERE id = $1 RETURNING *`; delete = `DELETE FROM notification_connections WHERE id = $1`; create = `INSERT ... RETURNING id, "createdAt", "updatedAt"` (`settings` and `events` as jsonb). `[ts:src/modules/notifications/notifications.service.ts:60]`–`[ts:src/modules/notifications/notifications.service.ts:109]`
3. Dispatch: `SELECT * FROM notification_connections WHERE enabled = true` (no ORDER BY), `events` filtered in application code (Rust may use `WHERE enabled AND events ? $1`, same result). `[ts:src/modules/notifications/notifications.service.ts:119]`–`[ts:src/modules/notifications/notifications.service.ts:120]`
4. Setup checklist (S8): `SELECT count(*) FROM notification_connections`.

## Events

none emitted (no SSE, no domain event). Consumers of this module's input are the callers of rule 19. Domain events seen by the request lifecycle that lead to notifications are in `requests.md` (Events).

## Settings keys

none. Each connection carries its own configuration in `settings`: `url` | `webhookUrl` (endpoint), `token` (secret; webhook bearer, gotify app token, ntfy bearer), `topic` (ntfy, default `fliks`), `username` (discord, default `Fliks`); unknown keys are kept verbatim.

## Jobs/timers

none (no retry queue, no periodic job; senders are one-shot with a 10 s timeout, rule 12, C16).

## Bridges

- **`POST /internal/notifications/dispatch`** (Rust, Nest→Rust, added S4, removed S8 when the plugin host moves): rule 21. Callers: Nest requests code (until S5), livetv (S7), subtitles scheduler + sync (S6), plugin host (S8).
- No Rust→Nest bridge is needed by this module.
- Add the row to `docs/bridge.md`: `| POST /internal/notifications/dispatch | Nest→Rust | {event, payload} → 204 | S4 | S8 |`.

## Deletes in Nest

Milestone S4: delete `src/modules/notifications/notifications.controller.ts`, `dto/create-notification-connection.dto.ts`, `notifications.service.spec.ts` (cases move to the `notifications` vector set and Rust tests), and from `notifications.service.ts` everything except a `dispatch(event, payload)` bridge client (CRUD, `normalizeSettings`, `send`, `formatMessage`, `redactNotificationSecrets`, `SUBSCRIBABLE_NOTIFICATION_EVENTS`, `NOTIFICATION_SECRET_FIELDS`; the `NotificationEvent` type import stays). 7 routes leave the Nest manifest.

Kept (importer rule, plan §15.1):
- `src/modules/notifications/notifications.module.ts` (exports the client): imported by `livetv/livetv.module.ts`, `subtitles/subtitles.module.ts`, `scheduler/scheduler.module.ts`, `plugins/host/plugin-host.module.ts`, `requests/requests.module.ts` (until S5 deletes it), `app.module.ts`. Deleted with the last importer (S8 plugin host); `app.module.ts` import removed with it.
- `src/modules/notifications/entities/notification-connection.entity.ts`: `NOTIFICATION_EVENTS`/`NotificationEvent` type used by the client's signature; the entity is registered/imported by `setup-checklist.service.ts:8` and `setup-checklist.module.ts` (S8); entity files stay until S9.
- The client's importers (`NotificationsService` injectors): `livetv/services/livetv-sources.service.ts:27`, `subtitles/subtitle-sync.service.ts:15`, `scheduler/subtitle-scheduler.service.ts:11`, `plugins/host/fliks-host.service.ts:37` (and `requests/*`, deleted in S5).
- `common/utils/secret-fields.util.ts` stays (used by plugin config and other Nest modules until their milestones).

## Vectors/parity

Vector set `notifications` (plan §5.2: "`formatMessage` per event × channel"), harness `backend/test/server-vectors/notifications.ts` (`formatMessage` and `send` are private: drive them through `service.dispatch` / `testConnection` with `axios.post` mocked, as the Nest spec does) writing `server/fixtures/notifications/*.json`, input `{type, settings, event, payload}`, expected `{url, headers, body}` or `{error}`. Cases:
- `format-<event>`: the 18 rows of rule 16 × 5 channels = 90 cases with payloads from rule 19 (e.g. `request.available {title:'Dune', mediaType:'movie'}` → discord `{username:'Fliks', content:'Request available: Dune'}`, slack `{text}`, webhook `{event:'request.available', title:'Dune', mediaType:'movie'}`, gotify `{title:'Fliks — request.available', message, priority:5}` at `…/message?token=<enc>`, ntfy body + `Title: Fliks - request.available`).
- Edge payloads: missing/`null` title (`New request: `), `title` undefined on `subtitle.upgraded`, missing `language` (`[]`), `health.issue` with and without `message`, missing `sourceName` (`Live TV source ""…`), unknown event default branch (`<event>: {json}`), webhook payload containing an `event` key, non-ASCII title (ntfy body UTF-8, `Title` header stays ASCII).
- Channel config: discord with/without `username`; webhook with/without token; gotify trailing slash, token needing encoding (`a b&c`), missing url/token (`url and token required`); ntfy trailing slash, empty topic → `fliks`, token present/absent/non-string, missing url (`url not configured`); discord/slack/webhook missing endpoint (`webhookUrl not configured`, `webhookUrl not configured`, `url not configured`).
- `normalize-*` (from the spec, names kept): legacy `webhookUrl` folded for webhook/gotify/ntfy; discord/slack stay on `webhookUrl`; `url` wins when both; trimmed endpoint and topic; gotify without token 400; blank token keeps the stored one; `null` erases it (ntfy) / 400 (gotify); `secretsSet` marker never persisted (ntfy and discord); provider switch drops the token; normalize on update.
- `validate-*`: ntfy without endpoint, either key accepted, blank endpoint, scheme-less endpoint (messages of rule 4); every one of the 18 events validates; unknown event rejected; subscribable list = 17 and storable.
- `redact-*`: token present → `secretsSet:['token']`; none → `[]`; endpoint/topic kept; discord/slack `webhookUrl` omitted and listed in `secretsSet` (F28, deviation vectors); blank write keeps it, `null` fails validation (400).
- Deviation cases: Discord body carries `allowed_mentions: {parse: []}` (F30); error texts of a failing gotify/discord send contain no URL and no token (F29); out-of-vocabulary event on the bridge → 400 (C17).

Rust integration tests (axum mock receiver, no external network) cover transport behaviour the vectors cannot: non-2xx → `Request failed with status code <n>`, closed port, redirect handling, no URL/token in logged or returned error text (F29), a receiver that never answers → timeout after 10 s with `ok:false` (C16; the test uses a paused clock).

Parity scenarios (`server/parity/scenarios/notifications/`, recorded on the seed; the runner has no outbound receiver, so `…-test-*` scenarios need a loopback mock URL in the seeded connection or run as Rust integration tests): `notifications-create-ntfy`, `notifications-create-discord`, `notifications-create-gotify-no-token-400`, `notifications-create-validation-400` (bad type, bad event, bad endpoint), `notifications-list` (token never present, `secretsSet` present), `notifications-events-list` (17 names), `notifications-get`, `notifications-get-404`, `notifications-update-keeps-token`, `notifications-update-null-clears-token`, `notifications-update-type-switch`, `notifications-list-webhookurl-masked` (discord: Nest returns the URL, Rust `secretsSet:['webhookUrl']`: `deviation: "F28"`), `notifications-get-badid` (id beyond int4: Nest 500, Rust 400/404: `deviation: "C1"`), `notifications-delete`, `notifications-test-ok` / `notifications-test-fail` (mock), plus 401 on each route and 403 for a `user`/`readonly` actor (no `settings.access`). The `POST /internal/notifications/dispatch` bridge is covered by Rust integration tests (200/204 path with a mock receiver, 400 unknown event, 401 bad token), not parity.

## Open questions (left open by plan §15.3)

Q1. Redirect policy of the senders (rule 12): axios follows redirects (and `follow-redirects` rewrites POST to GET on 301/302); reqwest follows up to 10 with the same rewrite. Implemented "followed, as Nest" (reqwest default; an integration test pins it); disabling is one `redirect(Policy::none())`. TLS: reqwest `rustls-tls-webpki-roots` (ring provider, bundled Mozilla roots), so https works on a minimal Docker image, macOS and Windows without a system store or OpenSSL. S4.
Q2. Fire-and-forget callers drop notifications silently when Rust is down or restarting (bridge failure is only logged); acceptable (today a restart loses in-flight ones too), confirm. S4.
Q3. Discord content is still not truncated or escaped (rule 15): a 2000+ char payload is delivered as is and rejected by Discord with a 400 (WARN). F30 only neutralises mentions. Freeze unless a fix is wanted. S4.

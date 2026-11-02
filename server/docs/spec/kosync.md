# Spec: kosync (KOReader progress sync)

Scope: the server KOReader's "Progress sync" plugin talks to: routes, wire format, authentication by a `kosync` device token, how a document hash names a text file, and how a position lands in the text progression the web reader uses. Credentials are `device-tokens.md`; the hash is `book-ingest.md` rule 13 and `books-files.md` rule 40; the progression is `item-delivery.md` rules 18-24. The wire follows koreader/koreader `plugins/kosync.koplugin` and the reference `koreader/koreader-sync-server`. Plan: `plans/books-audiobooks.plan.md` section 3.9 point 4, item 4.4.

## Routes

KOReader appends the paths of the reference server to the URL the user types (`Custom sync server`). The routes sit under `/kosync`, outside `/api` (so the app's own `/users` page is not shadowed): the URL to type is `https://<host>/kosync`. Credentials travel in headers, never in the URL.

| Method path | Request | Response | Errors |
|---|---|---|---|
| `GET /kosync/users/auth` | auth headers | 200 `{"authorized":"OK"}` | 401, 429 |
| `POST /kosync/users/create` | any | 402 `{"message":"Registration is disabled"}` | none |
| `PUT /kosync/syncs/progress` | auth headers, JSON body (rule 8) | 200 `{"document","timestamp"}` (known document), 202 same body (unknown document, nothing stored) | 400 `{"message":"Invalid request"}`, 401 |
| `GET /kosync/syncs/progress/:document` | auth headers | 200 `{"document","progress","percentage","device","device_id"?,"timestamp"}`, or 200 `{}` | 401 |

Every body is JSON. An error carries `{"message": ...}`. The `Accept: application/vnd.koreader.v1+json` KOReader sends is not checked.

## Status codes

1. KOReader retries every status its plugin does not list as expected for a call; `401` alone makes it ask for the login again. The plugin lists `200/202/401` for the progress calls, `200/401` for `auth` and `201/402` for `create`. So: a bad credential is 401; a refusal of registration is 402 (the reference's "already registered", read by the plugin as a refusal, not a failure to retry); a document the server cannot place is 202 on `PUT` (accepted, not kept) and `{}` on `GET`, never a 404 or a 5xx that KOReader would retry forever. A throttled `auth` is 429 `{"message":"Too many failed attempts, try again later"}`.
2. `POST /users/create` never creates anything and answers 402 without reading the body or the headers: accounts and tokens are made in the profile (`device-tokens.md`).

## Authentication

3. `x-auth-key` is the MD5, in hexadecimal, of the password the user typed in KOReader, and that password is the `kosync` token (`device-tokens.md` rule 3). A key that is not 32 hexadecimal characters is 401 with no lookup (a raw `fkd_...` token pasted as the key is such a key); a valid one is lower-cased, hashed (`device_tokens::hash`) and looked up among the rows of kind `kosync` only. An `opds` row never answers, nor does a token on the data plane (`device-tokens.md` rule 9).
4. `x-auth-user` is a free label: not read, not stored, not required. The token alone names the owner.
5. The owner must be an enabled user; a disabled or deleted one is 401. A hit sets `lastUsedAt` (`device-tokens.md` rule 11), on every call.
6. The three sync routes authenticate on every call and carry no throttle: a key is 256 bits of randomness and many devices share a network. `GET /users/auth` is throttled like the login (`auth.md` rule 39, the same in-process limiter, the client network of `auth.md` rule 63): the attempt is counted before the lookup under a fixed key (never the client's `x-auth-user`, which it could vary to dodge the limit), and a success clears it.
7. Every route answers 401 for any credential failure with the same body `{"message":"Unauthorized"}`: it does not tell a wrong key from a revoked or disabled one.

## Documents

8. `document` names a file by the KOReader partial MD5 (`media_file_hashes`, kind `koreader`): 32 lowercase hexadecimal characters. Anything else (KOReader's "file name" mode sends the file name) names nothing and costs no query; that mode is not supported.
9. The hash is computed at ingest, never in a request: `book-ingest.md` rule 13 writes it when a text file is registered and again when its size or mtime changes. A request-time hash would mean reading the whole library on the first sync, and the `(kind, hash)` index is what makes the lookup one query. No backfill is needed: every text file enters through `register`. A file that was unreadable at ingest has no hash until it changes or a rescan reads it.
10. A document resolves to the lowest-id file with that hash that is the part of an item of a `text` edition and whose edition's library is readable by the token's owner: the rule of `libraries::HIDDEN_FILES_FROM` (`books.md` rule 22), then `assert_file_accessible` for the file. An unreadable library is "unknown", indistinguishable from a hash no file has. Two copies of one file resolve to the first the owner can read.

## PUT /syncs/progress

11. The body is a JSON object, unknown keys ignored: `document` string; `progress` a string, or a number (KOReader sends a page number for fixed-layout documents), at most 4096 bytes once written as text; `percentage` a finite number; `device` a string of 1 to 255 characters after trim; `device_id` optional, a string of at most 255 characters or null. A missing or ill-typed field is 400.
12. An unknown document (rule 10) answers 202 and writes nothing. The `timestamp` of both answers is the server clock, in seconds since the epoch, an integer.
13. For a known document, in this order: `kosync_progress` is upserted by `(userId, document)` with `progress` (the string as received; a number is stored as its JSON text), `percentage` as received (not clamped), `device`, `deviceId`, `mediaFileId` and `syncedAt = now()`; then the position is written to the playback state of the file's item as a text beat (`watched::record_watch`): `progression` = `percentage` clamped to 0..1, `mediaFileId` = the file, no position, no duration, and the finished rule of the text family (`item-delivery.md` rule 22: `progression >= 0.99`, history and auto-playlists as for a web beat). A concurrent insert of the same `(user, item)` state is retried once.
14. `playback_states.locator` is set to NULL by the same write: an XPointer is not a Readium locator and cannot be converted, so a locator left from the web reader would outrank the newer KOReader position; the reader falls back to `progression` when there is no locator. The inverse is not done: a web reader beat does not change the `kosync_progress` row, so KOReader is never offered a position the server cannot express as an XPointer; it keeps the last position KOReader itself sent.
15. The last write wins, whatever its device or timestamp: KOReader decides on its side whether to apply the remote position.

## GET /syncs/progress/:document

16. The row of `(token owner, document)` is answered when the document still resolves (rule 10) and the row exists: `progress` is the stored text byte for byte as a JSON string, `percentage` the stored number, `device`, `device_id` (the key is absent when null) and `timestamp` (`syncedAt` in seconds). Otherwise 200 `{}`. A row of another user is never read: the key holds the user.

## Data

17. `kosync_progress("userId" -> users ON DELETE CASCADE, "document" text, "mediaFileId" -> media_files ON DELETE CASCADE, "progress" text, "percentage" double precision, "device" text, "deviceId" text NULL, "syncedAt" timestamptz)`, primary key `("userId", "document")`, `CK_kosync_progress_document` (`document ~ '^[0-9a-f]{32}$'`), `IDX_kosync_progress_mediaFileId` for the cascade. A file's rows go with it; a user's go with the user. `1789000000460_kosync-progress.sql` creates it and backfills nothing.

## Tests

`tests/it/kosync.rs` replays the requests the plugin sends against a fresh database: the auth handshake, a `PUT` then `GET` round trip with an XPointer and with a page number, an unknown and a non-hex document, a hidden library, an `opds` token and a revoked or disabled owner, the throttle (and that a varying `x-auth-user` does not dodge it), the shared progression (finished at 0.99, locator cleared, history) and concurrent `PUT`s.

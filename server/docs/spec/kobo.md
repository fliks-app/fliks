# Spec: Kobo sync (experimental)

Scope: the emulated Kobo store API a Kobo e-reader talks to once its `api_endpoint` points at Fliks: routes, the credential (a `kobo` device token in the path), the library sync with its token and deletions, covers, reading state, shelves, and the optional proxy to the real store. Credentials are `device-tokens.md`; the progression is `item-delivery.md` rules 18-24 and `kosync.md` rule 13; the ACL is `libraries.md` and `books.md` rule 22. Plan: `plans/books-audiobooks.plan.md` section 3.9 point 5, item 6.1. The wire is reimplemented from the public behaviour of Calibre-Web (`cps/kobo.py`), Komga and Kavita, modelled on the Kobo store API of firmware 4.x (Libra and Clara families); it has not been run against a real device.

Only plain EPUB is delivered (item 6.1). KEPUB (item 6.2) plugs in at one place, `kobo/books.rs::download`, which chooses the format and URL of a book's file.

## Setup

The user creates a device token of kind `kobo` in the profile and puts, in `.kobo/Kobo/Kobo eReader.conf` under `[OneStoreServices]`, the line `api_endpoint=https://<host>/kobo/<token>`. The device then appends `/v1/...` to it. The token is in the path, so it ends up in proxy logs: renewing it (`device-tokens.md` `POST .../renew`) is one click in the profile, and the old one stops at once.

## Credential

1. Every route is `/kobo/<token>/...`. The token must be well formed (`device-tokens.md` rule 12) and hash to a `kobo` row (`opds` and `kosync` rows never match). Nothing else is read: no cookie, no Bearer (the device's own `Authorization` is ignored, except by the proxy, rule 25).
2. An unknown, renewed or revoked token, a malformed one, or one of a disabled user is `401` with an empty body. A role without `media.read` is `403`. A hit stamps `lastUsedAt`.
3. Failure throttle, in-process, per client network, on the limiter of the login (`auth.md` rules 39 and 63) under a key no username can take: a failing token counts before the lookup, the 6th failure within 15 minutes is `429` with `Retry-After: 900`, a valid token is never throttled and clears nothing (a device syncs in parallel).
4. Every answer is `application/json` (images aside) with `Cache-Control: no-store`. The caller is the token's owner with their library ACL: `accessible_library_ids` bounds every list and every lookup (rule 9).

## Routes

Paths are relative to `/kobo/<token>`. The device sends the headers of its firmware (`x-kobo-*`, `User-Agent`); none is required.

| Method path | Answer |
|---|---|
| `GET /v1/initialization` | `{"Resources": {...}}` (rule 5), header `x-kobo-apitoken: e30=` |
| `GET /v1/library/sync` | JSON array of changes (rules 10-17), headers `x-kobo-synctoken` and, when more remain, `x-kobo-sync: continue` |
| `GET /v1/library/{uuid}/metadata` | `[BookMetadata]`, 404 for a book the owner cannot read |
| `GET /v1/library/{uuid}/state` | `[ReadingState]`, 404 likewise |
| `PUT /v1/library/{uuid}/state` | body `{"ReadingStates": [...]}`, answer in rule 20, 404 likewise |
| `DELETE /v1/library/{uuid}` | 204, archives the book for this device (rule 15), 404 for an unknown uuid |
| `GET /{uuid}/{w}/{h}/{greyscale}/image.jpg`, `GET /{uuid}/{w}/{h}/{quality}/{greyscale}/image.jpg` | the cover (rule 8) |
| `GET /v1/library/tags` | `[Tag]` of the owner's shelves (rule 22) |
| `POST /v1/library/tags` | create (rule 23), 201 and the tag id as a JSON string |
| `PUT /v1/library/tags/{id}` | rename, 200 |
| `DELETE /v1/library/tags/{id}` | delete, 200 |
| `POST /v1/library/tags/{id}/items`, `POST /v1/library/tags/{id}/items/delete` | add or remove books, 201 and 200 |
| `GET /v1/user/profile`, `GET /v1/user/loyalty/benefits`, `GET /v1/analytics/gettests`, `POST /v1/auth/device`, `GET /v1/user/wishlist`, `GET /v1/deals`, `GET /v1/products/**` | the stubs of rule 6 |
| any other path under `/v1/`, and the stubs above | the proxy (rule 25) when it is on, else the stub of rule 6 |

5. Initialization: `Resources` points everything the server handles back at the request's own base URL (`X-Forwarded-Proto` and `X-Forwarded-Host`, else `Host`; scheme `http` when none says `https`): `image_host`, `image_url_template` and `image_url_quality_template` (rule 8), `library_sync`, `library_metadata`, `tags`, `user_profile`, `user_loyalty_benefits`, and the `kobo_*_enabled` switches set to `False` (audiobooks, native borrow, subscriptions, superpoints). For the keys it does not serve, the proxy (rule 25) merges the store's own resources when on; off, they point back at the base URL, where rule 6 answers. The set of keys is the one the public reimplementations agree on, written from memory and unverified on a device; a key missing from it is the device's to default.
6. Stubs, so a device does not stall: `profile` `{"UserId": <token owner id as text>, "Email": ""}`-like empty profile, `loyalty/benefits` `{"Benefits": {}}`, `analytics/gettests` `{"Result": "Success", "TestKey": "", "Tests": {}}`, `auth/device` a fixed bearer pair (`AccessToken`, `RefreshToken`, `TokenType: "Bearer"`, `TrackingId`, `UserKey`; none is a secret or is checked), `wishlist` and `deals` `[]`... an unknown path `{}`. A stub never reads the database.

## Books

7. A Kobo book is a text item: the lowest-id item of a `text` edition of a `book` work (`books.md`), whose file is the one the OPDS catalogue links (`item_parts` of the highest `version`, `libraries::HIDDEN_FILES_FROM` applied) and has the extension `.epub`. A work or edition outside the owner's libraries, an item with no readable EPUB (a PDF, a CBZ, a wanted shell) is not a Kobo book: it is in no sync, and its uuid is a 404 everywhere. An edition links its own library (`COALESCE(editions."libraryId", media."libraryId")`) as in the OPDS entries.
8. Identifiers are stateless UUIDs: the book of item `n` is `f11c5b00-0000-4000-8000-` + `n` as 12 hexadecimal digits (`EntitlementId`, `RevisionId`, `CrossRevisionId`, `WorkId`, `CoverImageId`, the uuid of every path); a shelf of playlist `n` is the same with `f11c5a60`. A uuid of another shape names nothing. The cover is the media's local poster (`images.md`), the `thumb` size when `w` is at most 300, else `medium`, else `full`; `h`, quality and greyscale are ignored (the device scales). A book with no poster, or one the owner cannot read, is 404. Covers answer `image/jpeg`, `Cache-Control: private, max-age=86400`.
9. `BookMetadata` carries `Title`, `Contributors` (authors), `Description` (overview), `Language`, `Publisher` `{ "Imprint": "", "Name" }`, `PublicationDate` (Jan 1 of `year`), `CoverImageId`, ids, free prices (`0`), and `DownloadUrls`: one `{ "Format", "Size", "Url", "Platform": "Generic" }` from `kobo/books.rs::download`, today `EPUB3`, the size of the file and `<base>/cred/<token>/api/stream/<fileId>?download=1`: the data plane resolves the path credential (`device-tokens.md` rules 7-10), so the bytes and the ACL are the engine's, never ours. A work with no description or publisher omits the key.

## Library sync

10. The device keeps nothing of what it was sent; the server does, per token, in `kobo_sync_items` (rule 25). The sync token (`x-kobo-synctoken`, request and response) is the base64 of a JSON object `{"v":1,"t":<microseconds>,"b":[item ids],"g":[item ids],"s":[playlist ids],"sg":[playlist ids]}`: what the previous answer sent as books, as removals, as shelves and as shelf removals, and when the server read the library for it. An unreadable token, or a version other than 1, is no token.
11. With no token, the device starts from nothing: every row of this token is deleted (archived books included, so a reset device gets its library back) and every book is new.
12. With a token, the server first acknowledges the batch it names: `b` and `s` become rows with `syncedAt = stateAt = t`, `g` and `sg` delete theirs. Nothing is written when an answer is built, so an answer the device never received is rebuilt identically on its retry with the same token.
13. Then it reads the library as the owner (rule 7) and answers at most 100 entries, in this order: removals, books by item id, reading states, shelf changes. When more remain, `x-kobo-sync: continue` and the next call finishes. Each entry is one object:
    - a book without a row: `{"NewEntitlement": {"BookEntitlement", "BookMetadata", "ReadingState"}}`;
    - a book whose row has `syncedAt` older than the book's last change (`greatest` of the item, the work, and its file): `{"ChangedEntitlement": {...same}}`;
    - a book whose only change is the owner's playback state (`updatedAt` after the row's `stateAt`): `{"ChangedReadingState": {"ReadingState"}}`;
    - a row whose book is no longer readable, or no longer an EPUB, or deleted: `{"ChangedEntitlement": {"BookEntitlement": {..., "IsRemoved": true}}}`, then the row goes at the next acknowledgement.
    `BookEntitlement` is `Accessibility "Full"`, `Status "Active"`, `IsRemoved`, `Created` and `LastModified` (the work's), the ids, `OriginCategory "Imported"`.
14. A change the device itself made to the reading state (rule 19) sets the row's `stateAt` to the state's `updatedAt`, so it is not echoed back. Another reader's change (web, KOReader) is a `ChangedReadingState` carrying a bookmark with the percentage only (rule 21).
15. `DELETE /v1/library/{uuid}` is the user removing the book from the device: the row is kept with `archived = true` and the book is sent no more to this token, whatever changes, until a sync without a token. The library is not touched.
16. A token no sync has acknowledged is cheap: the server holds no cursor, so there is no state to expire or leak between devices; the price is that the read of rule 13 is a full library read per call (a list of ids and dates, not the files), bounded by the ACL.
17. A removed token (`DELETE /api/device-tokens/:id`) takes its rows with it (`ON DELETE CASCADE`).

## Reading state

18. The mapping of the playback state (`playback_states`, `(userId, itemId)`) to a Kobo `ReadingState`: `EntitlementId` the uuid; `StatusInfo.Status` `Finished` when the state is completed, `Reading` when its progression is above 0, else `ReadyToRead`; `CurrentBookmark.ProgressPercent` the progression times 100 (the book-wide percentage, not the chapter's); `LastModified`, `PriorityTimestamp` and each part's `LastModified` the state's `updatedAt` (the item's creation when there is none); `Statistics` zeros.
19. `PUT /v1/library/{uuid}/state` takes the first element of `ReadingStates` whose `EntitlementId` is the path's uuid. Written to the playback state like a web beat (`kosync.md` rule 13: `watched::record_watch`, progression clamped to 0..1, `mediaFileId` the book's file, no position, no duration, the finished rule of the text family, the locator set to NULL because a KoboSpan is no Readium locator): from `CurrentBookmark.ProgressPercent` when it is a finite number; `StatusInfo.Status = "Finished"` writes progression 1; `ReadyToRead` with no bookmark writes nothing. The whole `CurrentBookmark`, `StatusInfo` and `Statistics` objects as received are kept in the row's `state` (at most 16 KiB, else not kept), and `stateAt` is set to the state's new `updatedAt` (rule 14).
20. The answer is `{"RequestResult": "Success", "UpdateResults": [{"EntitlementId", "CurrentBookmarkResult": {"Result": "Success"}, "StatisticsResult": {"Result": "Success"}, "StatusInfoResult": {"Result": "Success"}}]}`. A body that is not that shape is `400 {"message": "Invalid request"}`; an unreadable book is 404 and writes nothing.
21. Reading a state back: when the row holds a `state` whose `stateAt` is not older than the playback state's `updatedAt`, the device's own `CurrentBookmark` (its `Location` included), `StatusInfo` and `Statistics` are returned as it sent them, so it resumes exactly; otherwise (the owner read elsewhere since) only the percentage is returned, and the device decides whether to move. A Kobo location is never converted to a Readium locator, nor the other way.

## Shelves

22. A Kobo shelf (tag) is a playlist the token's owner owns (`playlists.md`, `ownerId`); shared or saved playlists are not shelves. `Tag` is `{ "Id": uuid, "Name", "Created", "LastModified" (the playlist's `updatedAt`), "Type": "UserTag", "Items": [{ "RevisionId": book uuid, "Type": "ProductRevisionTagItem" }] }`, its items the playlist's Kobo books (rule 7) in position order. The sync sends `NewTag` for a playlist without a `shelf` row, `ChangedTag` when `updatedAt` is after the row's `syncedAt`, and `{"DeletedTag": {"Tag": {"Id", "LastModified"}}}` for a row whose playlist is gone.
23. `POST /v1/library/tags` `{"Name", "Items": [{"RevisionId"}]}` creates a private playlist named `Name` (trimmed, 1..255 characters, else 400) for the owner, or reuses the owner's playlist of exactly that name, and adds the readable books named by `Items` (an unreadable or unknown uuid is skipped). `PUT` renames, `DELETE` deletes (cascade to its items), `.../items` adds and `.../items/delete` removes: each only on a playlist the owner owns, else 404. Every write sets the playlist's `updatedAt`. A write by the device does not bring its own change back as a `ChangedTag` (the row's `syncedAt` is set to the new `updatedAt`).
24. A deleted or renamed playlist is seen by the device at its next sync; a book added to a shelf in Fliks appears in the shelf at the next sync even when the book is already on the device.

## Store proxy

25. `app_settings.kobo_store_proxy` = `true` (default off, any other value is off; admin, `settings.md`) lets the server forward to `https://storeapi.kobo.com` what it does not handle: a `/v1/...` path outside the routes above, and the `auth/device`, `initialization` resources merge of rule 5. The request goes with its method, path after the token, query, body and the headers `Authorization`, `Content-Type`, `Accept`, `User-Agent` and every `x-kobo-*`; the answer comes back with its status, `Content-Type` and body. The host is fixed; no redirect is followed; an upstream failure is `502` with an empty body. With the proxy off nothing leaves the server, and the stubs of rule 6 answer. A book the server serves is never proxied.

## Data

26. `kobo_sync_items("tokenId" -> device_tokens ON DELETE CASCADE, "kind" text ('item' | 'shelf'), "refId" integer (item or playlist id, no foreign key: its disappearance is how a removal is detected), "syncedAt" timestamptz, "stateAt" timestamptz, "archived" boolean, "state" jsonb NULL)`, primary key `("tokenId", "kind", "refId")`. `device_token_kind` gains `kobo`.

## Tests

`tests/it/kobo.rs` replays the requests a device sends against a fresh database: initialization and its resources, a full sync with a token round trip, a second sync that is empty, a change, a removal (a book that becomes unreadable), the retry of a lost answer, paging past 100, an archived book, a reset (no token), progress `PUT` then `GET` and its effect on the shared progression, a state written elsewhere coming back, covers by size, shelves in both directions, the ACL on every route, a `kosync`/`opds` token and a revoked or disabled owner, the throttle, and the proxy off by default. `device_tokens` tests cover the kind and the sources.

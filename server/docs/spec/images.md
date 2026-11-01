# Spec: images (serving only)

Scope: the two `/api/images/*` serving routes. They are public, with no auth extractor. 404 bodies and `Cache-Control: no-store` on 4xx/5xx = `bootstrap.md` rule 7.

**Out of scope:** the image store (download, resize, store, delete, the TMDB size map, the `.src.json` sidecars, the `?v=<sha1[0..8]>` cache-busting hash) and every caller that writes images (persons, media import/metadata, requests, live TV logos), see `image-store.md`. Avatar upload/delete is `users.md`. Live TV channel logos are `/api/livetv/channels/:id/logo`, not these routes.

## Routes

2 routes, no guard and no policy: anonymous callers, cookie, Bearer and `scope:'stream'` tokens are all ignored, never 401/403. The 3-segment route is matched first; both are plain `GET`.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/images/:type/:id` | none (public) | path `type` (rule 2), `id` (rule 3); query `size` (rule 4) | 200, the image file bytes (rule 8), `Cache-Control: public, max-age=86400`, `X-Image-Size-Served` when downgraded (rule 6) | 404 bare body (rule 9) | none (read-only) |
| `GET /api/images/:type/:id/:variant` | none (public) | as above plus path `variant` (rule 5) | as above | 404 bare body | none |

## Rules

### A. Request handling

1. Both routes call the same `serve(type, id, variant, size)`; the no-variant route passes no `variant`. Unknown query keys (e.g. the client's `?v=<hash>`) are ignored.
2. `type` must be exactly one of `media`, `person`, `episode`, `season`, `request`, `user`, `party` (case-sensitive), else 404. `livetv` is deliberately absent (its logos can belong to a restricted group and are served by the live TV controller with an access check).
3. `id`: for `request` it must match `^(movie|series)-(tmdb|tvdb|imdb)-[A-Za-z0-9]{1,64}$` or `^(movie|series)-\d+$` (`\d` is ASCII `[0-9]`, no whitespace tolerated; the string key lands in a filesystem path, so this is the traversal guard), else 404. For `party` it is a canonical integer or a 22-character upload key `^[A-Za-z0-9_-]{22}$`; for every other type it must be a canonical integer (rule 16), else 404.
4. `size` query: one of `thumb`, `medium`, `full` (exact, lower-case); anything else, absent, empty, or repeated (`?size=a&size=b` / `size[]=`: an array, not a string) means `full`.
5. `variant` is a raw string. It is used only for `media` and `request` (poster default); for `person`, `episode`, `season`, `user`, `party` it is accepted and ignored (`/api/images/person/5/anything` serves person 5). Well-formed values are `poster`, `fanart`, `fanart-<N>` and `logo` (`logo` selects `.png`, everything else `.jpg`). A path parameter is percent-decoded, so `..%2F..%2Fusers%2F5` would resolve outside `media/<id>/`: for `media` and `request`, `variant` is validated (rule 15).

### B. File resolution and fallback

6. Resolution is purely on disk, no database access. Disk path = `getDiskPath(type, id, variant, size)`; the requested size is `size`. If that file does not exist (`existsSync`) and `size !== 'full'`, retry with `size = 'full'` and set `servedSize = 'full'`. Then if the file still does not exist → 404. `X-Image-Size-Served: full` is sent iff `servedSize !== size` (i.e. a `thumb`/`medium` request that fell back). A request for `full` never carries the header; a `thumb` request whose thumb file exists never carries it.
7. Path table (`<dataDir>` = rule 12; `S` = `''` for `full`, `-thumb` / `-medium` otherwise; `ext` = `png` when `variant === 'logo'` else `jpg`). Only `full` is a "canonical" name; the size files may be absent (hence rule 6).

    | `type` | File |
    |---|---|
    | `media` | `<dataDir>/media/<id>/<variant ?? poster><S>.<ext>` |
    | `request` | `<dataDir>/requests/<id>/<variant ?? poster><S>.jpg` (`.jpg` even for `logo`) |
    | `person` | `<dataDir>/persons/<id><S>.jpg` |
    | `episode` | `<dataDir>/episodes/<id><S>.jpg` |
    | `season` | `<dataDir>/seasons/<id><S>.jpg` |
    | `user` | `<dataDir>/users/<id><S>.jpg` (avatars are a single stored file, so any `?size=thumb|medium` falls back to `full` and carries `X-Image-Size-Served: full`) |
    | `party` | `<dataDir>/parties/<id><S>.jpg` (a party cover uploaded before keys), or `<dataDir>/parties/<key><S>.jpg` where `key` is the 22 characters `[A-Za-z0-9_-]` of its URL (`watch-party.md`; single file like an avatar) |

    `livetv` also has a branch in `getDiskPath` (`livetv/<id><S>.png`) but is unreachable here (rule 2).
8. Success response: status 200, body = the file bytes, headers `Cache-Control: public, max-age=86400` (always, set by the handler), plus the standard static-file headers: `Content-Type` from the extension (`image/jpeg` for `.jpg`, `image/png` for `.png`, no `charset`), `Content-Length`, `Last-Modified` (file mtime), a weak `ETag` derived from the mtime in seconds (rule 17), `Accept-Ranges: bytes`; conditional requests (`If-None-Match`, `If-Modified-Since`) answer 304 and `Range` / `If-Range` answer 206/416.
9. 404 body (type, id regex, missing file): `{"message":"Not Found","statusCode":404}` (no `error` key), with the global `Cache-Control: no-store, no-cache, must-revalidate` on every 4xx/5xx (`bootstrap.md` rule 7; it overrides nothing on 200).
10. A path component starting with `.` is never served (404), so a data directory under a dot-directory, or a `variant` like `.x`, never serves; no real deployment relies on it (Docker `/app/data`). A non-ENOENT read error (directory at the path, permission denied) is not otherwise specified: the server answers 404 for a directory and 500 for other IO errors.
11. Image files are written atomically (temp file + rename), so a reader never sees a partial image; the server opens the final path directly (no copy, no caching of bytes).

### C. Data directory (shared with users avatars)

12. `<dataDir>` is the same directory the avatar upload writes to: one resolution for the whole process, `data_dir()` in `server/crates/server/src/paths.rs`, shared by images and avatars so they can never diverge. `intended_data_dir()`: `FLIKS_DATA_DIR` (trimmed, empty = unset), else deprecated `FLIKS_IMAGES_DIR` (logs a warning), else `./images` if it exists (logs a warning), else `./data`; the first candidate in `[intended, <os tmp>/fliks-data]` that passes a write probe (`.probe` file create/remove) is used, probed once at first call (`OnceLock`), with a warning on fallback. Avatars live at `data_dir()/users/<id><suffix>`.
13. Avatars: `users.md` rules 32-33 store `users.avatar = '/api/images/user/<id>?v=<ms>'` and write `<dataDir>/users/<id>.jpg`; the serving route for that URL is `GET /api/images/user/:id` of this spec (rules 3, 6, 7). After `DELETE /users/me/avatar` the file is gone and the route answers 404. `FLIKS_DATA_DIR` is also read by `config.md`.
14. Stored image URLs (in `media`, `persons`, `requests`, `users` columns) are written through `getApiPath`: `/api/images/media/<id>/<variant ?? poster>`, `/api/images/request/<key>/<variant ?? poster>`, `/api/images/person|episode|season|user/<id>` (plus `?v=<hash>`); clients append `&size=` / `?size=` at request time (client `imageUrlWithSize`, `client/src/app/core/pipes/resolve-url.pipe.ts`). The route set above is what these URLs hit.

### D. Hardening and shared behaviour

15. For `media` and `request`, `variant` must match `^(poster|fanart|fanart-[0-9]+|logo)$`, else 404 (same bare 404 body, rule 9), before any filesystem access; for `person`, `episode`, `season`, `user` it stays accepted and ignored. A `%2F` / `..` variant cannot leave `<dataDir>/media/<id>/`.
16. For every type except `request`, `id` must match `^(0|[1-9][0-9]*)$` (and fit the integer range, else 404); `007`, `0x7`, `7.0`, `+7`, ` 7 ` and `7e0` answer 404 (rule 3 keeps its `request` regex). Clients only emit canonical integers.
17. The weak ETag is derived from the file mtime in seconds, like the other static routes. `Last-Modified`, `Accept-Ranges`, 304 and 206/416 handling as rule 8.
18. Single `data_dir()`: image serving and avatar upload/delete (`users.md` rules 32-33) both call the one shared `data_dir()` (rule 12), so a first-candidate write-probe failure resolves identically for both.

## SQL

none. The serving routes never touch the database.

## Events

none.

## Settings keys

none. The only configuration is the environment (`FLIKS_DATA_DIR`, rule 12, `config.md`).

## Jobs/timers

none.

## Vectors/parity

No fixture set: the pure logic is the `id`/`size` parsing, covered by Rust unit tests (`request` id regex, canonical-id cases of rule 16 (`007`, `0x7`, `7.0`, ` 7 ` give 404), `variant` regex cases of rule 15, size parsing with array values, the path table for each type/variant/size).

Parity scenarios (`server/parity/scenarios/images/`; the seed's data dir is `/tmp/fliks-parity/data` with generated 1x1 JPEG/PNG files, never real artwork; steps run `as: anon`, and each success step lists `expect.headers`): `media-poster` (200, `image/jpeg`, `Cache-Control: public, max-age=86400`, no `X-Image-Size-Served`), `media-poster-thumb-present` (no downgrade header), `media-poster-thumb-fallback` (thumb absent: 200 + `X-Image-Size-Served: full`), `media-medium-fallback`, `media-fanart`, `media-fanart-n` (`fanart-1`), `media-logo-png` (`image/png`), `person`, `episode`, `season`, `request-ok` (`movie-603`), `request-bad-key` (`..%2Fx`, `movie-abc`: 404), `user-avatar` (after an avatar upload on the same stack: 200; `?size=thumb` falls back), `user-avatar-deleted` (404), `bad-type` (`livetv`, `foo`: 404), `missing-id` (404 bare body, `Cache-Control: no-store, no-cache, must-revalidate`), `bad-size` (`?size=huge` serves full, no header), `size-array` (`?size=thumb&size=medium` serves full), `conditional` (second request with `If-None-Match` / `If-Modified-Since`: 304, status only), `range` (206), `anonymous-ok` (no credential: 200), `variant-traversal` (`variant = ..%2F..%2F<an existing .jpg under the parity data dir>`: 404), `id-noncanonical` (`/media/007/poster`, `/person/0x7`: 404), `person-variant-ignored` (`/person/<id>/zzz` 200).

## Open questions

none.

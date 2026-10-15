# Spec: images (serving only)

Sources: `[ts:src/modules/images/image.controller.ts]` (all of it), `[ts:src/modules/images/image.service.ts]` (`getDiskPath`, `getApiPath`, `baseDir` only), `[ts:src/common/constants/paths.ts]`. Milestone: S3 (plan §10 S3 "`/api/images/*` serving only"). F3 is dropped (user decision 2026-10-15, README F3): the routes stay public, no extractor. 404 bodies and `Cache-Control: no-store` on 4xx/5xx = `bootstrap.md` rule 7.

**Out of scope (stays in Nest until S5, plan §10 S3 intro and S5):** `ImageService` download / resize / store (`downloadAndStore`, `storeBuffer`, `storeFromDisk`, `readCacheHit`, `deleteImages`, the `sharp` pipeline, the TMDB size map, the download semaphore, the `.src.json` sidecars and the `?v=<sha1[0..8]>` cache-busting hash, `hasImage`), and every caller that writes images (persons, media import/metadata, requests, live TV logos). Avatar upload/delete is `users.md` (S1, already Rust). Live TV channel logos are `/api/livetv/channels/:id/logo` (S7), not these routes.

## Routes

2 routes (manifest filter: `.[]|select(.path|test("^/api/images"))` = 2; both `ImageController`, `guards: []`, `policies: ""`). No `@UseGuards` anywhere on the controller: anonymous callers, cookie, Bearer and `scope:'stream'` tokens are all ignored, never 401/403 `[ts:src/modules/images/image.controller.ts:20]`. Route order: the 3-segment route is declared first; both are plain `GET` (HEAD answered by the framework) `[ts:src/modules/images/image.controller.ts:24]`–`[ts:src/modules/images/image.controller.ts:43]`.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/images/:type/:id` | none (public; F3 dropped) | path `type` (rule 2), `id` (rule 3); query `size` (rule 4) | 200, the image file bytes (rule 8), `Cache-Control: public, max-age=86400`, `X-Image-Size-Served` when downgraded (rule 6) | 404 bare body (rule 9) | none (read-only) |
| `GET /api/images/:type/:id/:variant` | none (public; F3 dropped) | as above plus path `variant` (rule 5) | as above | 404 bare body | none |

## Rules

### A. Request handling

1. Both routes call the same `serve(type, id, variant, size)`; the no-variant route passes `variant = undefined`. Unknown query keys (e.g. the client's `?v=<hash>`) are ignored. `[ts:src/modules/images/image.controller.ts:45]`–`[ts:src/modules/images/image.controller.ts:51]`
2. `type` must be exactly one of `media`, `person`, `episode`, `season`, `request`, `user` (case-sensitive), else 404. `livetv` is deliberately absent (its logos can belong to a restricted group and are served by the live TV controller with an access check). `[ts:src/modules/images/image.controller.ts:52]`–`[ts:src/modules/images/image.controller.ts:63]`
3. `id`: for `request` it must match `^(movie|series)-\d+$` (JS `.test`, so `\d` is ASCII `[0-9]`, no whitespace tolerated; the string key lands in a filesystem path, so this is the traversal guard), else 404. For every other type `id` is coerced with unary `+`: the file looked up is `String(+id)`, so `"7"`, `"007"`, `"0x7"`, `"7.0"`, `"+7"`, `" 7 "`, `"7e0"` all serve id 7, while `"abc"`, `""`-like or `"-5"` resolve to a name that does not exist (`NaN.jpg`, `-5.jpg`) and end in 404. No integer-range check in Nest; Rust accepts canonical integers only (C9, rule 16). `[ts:src/modules/images/image.controller.ts:65]`–`[ts:src/modules/images/image.controller.ts:74]`
4. `size` query: one of `thumb`, `medium`, `full` (exact, lower-case); anything else, absent, empty, or repeated (`?size=a&size=b` / `size[]=`: an array, not a string) means `full`. `[ts:src/modules/images/image.controller.ts:18]`, `[ts:src/modules/images/image.controller.ts:76]`–`[ts:src/modules/images/image.controller.ts:78]`
5. `variant` is a raw string with NO validation. It is used only for `media` and `request` (poster default); for `person`, `episode`, `season`, `user` it is accepted and ignored (`/api/images/person/5/anything` serves person 5). Well-formed values are `poster`, `fanart`, `fanart-<N>` and `logo` (`logo` selects `.png`, everything else `.jpg`). Because the framework decodes `%2F` in a path parameter and the path is built with `path.join`, a `variant` such as `..%2F..%2Fusers%2F5` resolves outside `media/<id>/` and, with enough `..`, outside the data directory: any readable `*.jpg` (never `.png`, `variant === 'logo'` is exact) on the host can be fetched anonymously. Verified against the repo's Express 5.2.1: `/media/1/..%2F..%2F..%2Fetc%2Fx` yields `variant = "../../../etc/x"` and the path `/etc/x.jpg`. **Security: Rust validates `variant` (F21, rule 15).** `[ts:src/modules/images/image.controller.ts:24]`–`[ts:src/modules/images/image.controller.ts:33]`, `[ts:src/modules/images/image.service.ts:424]`–`[ts:src/modules/images/image.service.ts:446]`

### B. File resolution and fallback

6. Resolution is purely on disk, no database access. Disk path = `getDiskPath(type, id, variant, size)`; the requested size is `size`. If that file does not exist (`existsSync`) and `size !== 'full'`, retry with `size = 'full'` and set `servedSize = 'full'`. Then if the file still does not exist → 404. `X-Image-Size-Served: full` is sent iff `servedSize !== size` (i.e. a `thumb`/`medium` request that fell back). A request for `full` never carries the header; a `thumb` request whose thumb file exists never carries it. `[ts:src/modules/images/image.controller.ts:80]`–`[ts:src/modules/images/image.controller.ts:108]`
7. Path table (`<dataDir>` = rule 12; `S` = `''` for `full`, `-thumb` / `-medium` otherwise; `ext` = `png` when `variant === 'logo'` else `jpg`). Only `full` is a "canonical" name; the size files are written by Nest's S5 pipeline and may be absent (hence rule 6). `[ts:src/modules/images/image.service.ts:424]`–`[ts:src/modules/images/image.service.ts:461]`

    | `type` | File |
    |---|---|
    | `media` | `<dataDir>/media/<id>/<variant ?? poster><S>.<ext>` |
    | `request` | `<dataDir>/requests/<id>/<variant ?? poster><S>.jpg` (`.jpg` even for `logo`) |
    | `person` | `<dataDir>/persons/<id><S>.jpg` |
    | `episode` | `<dataDir>/episodes/<id><S>.jpg` |
    | `season` | `<dataDir>/seasons/<id><S>.jpg` |
    | `user` | `<dataDir>/users/<id><S>.jpg` (avatars are a single stored file, so any `?size=thumb|medium` falls back to `full` and carries `X-Image-Size-Served: full`) |

    `livetv` also has a branch in `getDiskPath` (`livetv/<id><S>.png`) but is unreachable here (rule 2).
8. Success response: status 200, body = the file bytes, headers `Cache-Control: public, max-age=86400` (always, set by the handler), plus what Express `sendFile` adds by default: `Content-Type` from the extension (`image/jpeg` for `.jpg`, `image/png` for `.png`, no `charset`), `Content-Length`, `Last-Modified` (file mtime), a weak `ETag` `W/"<size hex>-<mtimeMs hex>"`, `Accept-Ranges: bytes`; conditional requests (`If-None-Match`, `If-Modified-Since`) answer 304 and `Range` / `If-Range` answer 206/416. `X-Powered-By: Express` is not part of the contract. In Rust the ETag follows C7 (weak, from mtime in seconds; rule 17). `[ts:src/modules/images/image.controller.ts:106]`–`[ts:src/modules/images/image.controller.ts:108]`, `[ts:src/modules/images/image.service.ts:424]`
9. 404 body (type, id regex, missing file): `{"message":"Not Found","statusCode":404}` (bare `NotFoundException()`, no `error` key), with the global `Cache-Control: no-store, no-cache, must-revalidate` on every 4xx/5xx (`bootstrap.md` rule 7; it overrides nothing on 200). `[ts:src/modules/images/image.controller.ts:63]`, `[ts:src/modules/images/image.controller.ts:70]`, `[ts:src/modules/images/image.controller.ts:104]`
10. Express `sendFile` refuses any path component that starts with `.` (default `dotfiles: 'ignore'`, answers 404), so a data directory under a dot-directory, or a `variant` like `.x`, never serves; no real deployment relies on it (Docker `/app/data`). Rust does not need to reproduce the data-directory case. `[assumed]`: from `send@1.2.1` `containsDotFile` (`node_modules/send/index.js:458`), no repo test; behaviour of a non-ENOENT read error after `existsSync` (directory at the path, permission denied) is also not pinned: Rust answers 404 for a directory and 500 for other IO errors.
11. Nest writes the files with `writeFileAtomic` (temp file + rename) while the S3 Rust server reads them, so a reader never sees a partial image; Rust must open the final path directly (no copy, no caching of bytes). `[ts:src/modules/images/image.service.ts:241]`

### C. Data directory (shared with users avatars)

12. [new] Shared data dir (plan §15.3): `<dataDir>` is the same directory the avatar upload writes to: one resolution for the whole process, not one per domain. Nest `getDataDir()`: `FLIKS_DATA_DIR` (trimmed, empty = unset), else deprecated `FLIKS_IMAGES_DIR` (logs a warning), else `./images` if it exists (legacy volume, logs a warning), else `./data`; the first candidate in `[intended, <os tmp>/fliks-data]` that passes a write probe is used, probed once at first call. The Rust equivalent already exists on `server/s1-identity`: `server/crates/server/src/users/routes.rs` `intended_data_dir()` (same env order and `images` then `data` fallback), `data_dir()` (a `OnceLock`, `.probe` file create/remove, fallback `<temp_dir>/fliks-data`, warning) and `avatar_path(id, suffix) = data_dir()/users/<id><suffix>`. Those two functions are private to `users/routes.rs`; the images module must call the same single `data_dir()` (the S3 PR moves it out of `users` into a shared module, e.g. next to `config.rs`; plan §15.3) so avatars written by `POST /api/users/me/avatar` and read by `GET /api/images/user/:id` can never diverge. `[ts:src/common/constants/paths.ts:12]`–`[ts:src/common/constants/paths.ts:41]`, `[ts:src/modules/images/image.service.ts:118]`; Rust `git show origin/server/s1-identity:server/crates/server/src/users/routes.rs` lines 435-478
13. Avatars: `users.md` rules 32-33 store `users.avatar = '/api/images/user/<id>?v=<ms>'` and write `<dataDir>/users/<id>.jpg`; the serving route for that URL is `GET /api/images/user/:id` of this spec (rules 3, 6, 7). After `DELETE /users/me/avatar` the file is gone and the route answers 404. `FLIKS_DATA_DIR` is also read by `config.md`. `[ts:src/modules/images/image.service.ts:458]`–`[ts:src/modules/images/image.service.ts:473]`
14. [ts:src/modules/images/image.service.ts:489] Stored image URLs (in `media`, `persons`, `requests`, `users` columns) are written by Nest in S5 through `getApiPath`: `/api/images/media/<id>/<variant ?? poster>`, `/api/images/request/<key>/<variant ?? poster>`, `/api/images/person|episode|season|user/<id>` (plus `?v=<hash>`); clients append `&size=` / `?size=` at request time (client `imageUrlWithSize`, `client/src/app/core/pipes/resolve-url.pipe.ts`). The route set above is what these URLs hit; no URL shape changes. `[ts:src/modules/images/image.service.ts:489]`–`[ts:src/modules/images/image.service.ts:513]`

### D. Deviations decided for the port (plan §15.3)

15. [new] F21: for `media` and `request`, `variant` must match `^(poster|fanart|fanart-[0-9]+|logo)$`, else 404 (same bare 404 body, rule 9), before any filesystem access; for `person`, `episode`, `season`, `user` it stays accepted and ignored. A `%2F` / `..` variant can no longer leave `<dataDir>/media/<id>/`. Not hotfixed in Nest (user decision): the hole stays open there until S3 ships.
16. [new] C9: for every type except `request`, `id` must match `^(0|[1-9][0-9]*)$` (and fit the integer range, else 404); `007`, `0x7`, `7.0`, `+7`, ` 7 ` and `7e0` answer 404 (rule 3 keeps its `request` regex). Clients only emit canonical integers.
17. [new] C7 extended to images: no Nest-style `W/"<size hex>-<mtimeMs hex>"` ETag; the weak ETag is derived from the file mtime in seconds, as C7 defines for the other static routes. `Last-Modified`, `Accept-Ranges`, 304 and 206/416 handling as rule 8. Browser-cache only: one re-download per image after the upgrade.
18. [new] Single `data_dir()`: image serving and avatar upload/delete (`users.md` rules 32-33) both call the one shared `data_dir()` module (rule 12), moved out of `users/routes.rs` in the S3 PR, so a first-candidate write-probe failure resolves identically for both.

## SQL

none. The serving routes never touch the database.

## Events

none.

## Settings keys

none. The only configuration is the environment (`FLIKS_DATA_DIR`, rule 12, `config.md`).

## Jobs/timers

none.

## Bridges

none. Nest keeps writing images into the shared data directory; Rust reads the same files (rule 11). No endpoint is needed in either direction.

## Deletes in Nest

Milestone S3 (plan §10 S3).

- `backend/src/modules/images/image.controller.ts`: whole file (the 2 routes leave `nest-routes.json`), and `controllers: [ImageController]` in `backend/src/modules/images/image.module.ts` `[ts:src/modules/images/image.module.ts:6]`.
- KEEP `image.service.ts`, its spec `image.service.spec.ts` and `ImageModule` (providers + exports) until S5: `ImageService` is imported by `modules/livetv/controllers/livetv.controller.ts`, `modules/livetv/services/livetv-logo.service.ts`, `modules/media/media-service/media-import.service.ts`, `modules/media/media-service/media-metadata.service.ts`, `modules/persons/persons.service.ts`, `modules/requests/requests.service.ts`, `modules/users/users.service.ts` (the S1 avatar methods there go with `users.md`'s deletes), and `ImageModule` by `app.module.ts`, `livetv`, `media`, `persons`, `requests`, `users` modules. `getDiskPath`/`getApiPath` stay in Nest because the writers use them; the Rust path table (rule 7) is a second copy until S5 (listed duplication, no bridge): any change to the layout in Nest needs the same change in Rust.
- Remaining importers after S3: all of the above; the whole `modules/images/**` is deleted with the last of them (S5 for persons, media, requests; S7 for the live TV logo cache; see plan §10 S5/S7), at which point `ImageService` is re-implemented in Rust (download, `sharp` equivalent resize, atomic writes), which is out of scope here.

## Vectors/parity

No §5.2 fixture set (no pure logic beyond the `id`/`size` parsing, covered by Rust unit tests: `request` id regex, canonical-id cases of rule 16 (`007`, `0x7`, `7.0`, ` 7 ` → 404), `variant` regex cases of rule 15, size parsing with array values, path table for each type/variant/size).

Parity scenarios (`server/parity/scenarios/images/`; the seed's data dir is `/tmp/fliks-parity/data` with generated 1x1 JPEG/PNG files, never real artwork; steps run `as: anon`, and each success step lists `expect.headers`): `images-media-poster` (200, `image/jpeg`, `Cache-Control: public, max-age=86400`, no `X-Image-Size-Served`), `images-media-poster-thumb-present` (no downgrade header), `images-media-poster-thumb-fallback` (thumb absent: 200 + `X-Image-Size-Served: full`), `images-media-medium-fallback`, `images-media-fanart`, `images-media-fanart-n` (`fanart-1`), `images-media-logo-png` (`image/png`), `images-person`, `images-episode`, `images-season`, `images-request-ok` (`movie-603`), `images-request-bad-key` (`..%2Fx`, `movie-abc`: 404), `images-user-avatar` (after an avatar upload on the same stack: 200; `?size=thumb` falls back), `images-user-avatar-deleted` (404), `images-bad-type` (`livetv`, `foo`: 404), `images-missing-id` (404 bare body, `Cache-Control: no-store, no-cache, must-revalidate`), `images-bad-size` (`?size=huge` serves full, no header), `images-size-array` (`?size=thumb&size=medium` serves full), `images-conditional` (second request with `If-None-Match` / `If-Modified-Since`: 304; the ETag value differs from Nest by C7, so only the status is compared: deviation scenario C7), `images-range` (206), `images-anonymous-ok` (no credential: 200, proves F3 dropped), `images-variant-traversal` (`variant = ..%2F..%2F<an existing .jpg under the parity data dir>`: 200 on Nest, 404 on Rust; scenario with `deviation: "F21"` and a hand-written `expect`), `images-id-noncanonical` (`/media/007/poster`, `/person/0x7`: 200 on Nest, 404 on Rust; `deviation: "C9"`), `images-person-variant-ignored` (`/person/<id>/zzz` 200).

## Open questions (left open by plan §15.3)

none. F21, C9, C7 (extended) and the shared `data_dir()` module answer the four questions raised during spec writing (rules 15-18).

# Spec: image store (download, resize, cache sidecar)

Sources: `[ts:src/modules/images/image.service.ts:1-514]` (`ImageService`), `[ts:src/common/utils/atomic-file.ts:1-49]`, `[ts:src/common/constants/paths.ts:40-48]`, `[ts:src/modules/images/image.module.ts:1-10]`, spec `[ts:src/modules/images/image.service.spec.ts:1-196]`. Milestone: S5 (plan §10 S5 "image store (download, resize with `image` crate, jpeg q90 / png logos, cache sidecar, concurrency 1)"). Tag paths are relative to `backend/`. This is the **write side** of the images: serving `GET /api/images/*` is `images.md` (S3, already Rust; its rules 7, 12-14 define the path layout and the shared `data_dir()` used here). Callers: persons (`persons.md`), the media import/refresh code (media spec, same milestone), request art (`requests.md`), live TV logos (`livetv` spec, S7, Nest until then, see Bridges).

## Routes

No public route. The store is an in-process Rust module (`images::store`) with this API (no bridge, see Bridges):

| Function | Args | Returns | Nest origin |
|---|---|---|---|
| `download_and_store` | `url: &str`, `kind: ImageType`, `id: IdKey` (`i64` or the `request` string key `movie-603`), `variant: Option<Variant>` | `Option<String>`: `/api/images/...?v=<hash>` or `None` | `downloadAndStore` `[ts:src/modules/images/image.service.ts:135-151]` |
| `store_from_disk` | `abs_path: &Path`, same | same | `storeFromDisk` `[ts:src/modules/images/image.service.ts:287-303]` |
| `has_image` | `kind`, `id`, `variant` | `bool` (full file exists) | `hasImage` `[ts:src/modules/images/image.service.ts:477-483]` |
| `api_path` / `disk_path` | `kind`, `id`, `variant`, `size` | `String` / `PathBuf` | `getApiPath` / `getDiskPath` `[ts:src/modules/images/image.service.ts:424-461]`, `[ts:src/modules/images/image.service.ts:489-513]`; one module shared with `images.md` rule 7 |

`ImageType` = `media | person | episode | season | request | user | livetv` `[ts:src/modules/images/image.service.ts:47-55]`; `Variant` = `poster | fanart | fanart-<N≥1> | logo` `[ts:src/modules/images/image.service.ts:56-62]`; `ImageSize` = `thumb | medium | full`. Not ported, no callers outside the module (`grep -rn "deleteImages\|storeAvatar" backend/src` = only `image.service.ts`): `deleteImages` `[ts:src/modules/images/image.service.ts:396-417]`, `storeAvatar` `[ts:src/modules/images/image.service.ts:469-474]` (avatars are `users.md` rules 32-33, Rust since S1).

## Rules

### A. Entry, de-duplication, concurrency

1. `download_and_store` and `store_from_disk` return `None` (never an error) when the work failed: unreachable or non-2xx URL, oversize, not an image, unreadable local file, full-size write failure. Partial success (full written, a resized variant failed) is a success. Every failure logs one `warn` (rule 23). `[ts:src/modules/images/image.service.ts:135-140]`, `[ts:src/modules/images/image.service.ts:194-203]`, `[ts:src/modules/images/image.service.ts:242-245]`
2. In-flight de-duplication per `<kind>/<id>/<variant or 'default'>` (shared by both entry points): a second call for the same key while one is running **returns the first call's result** (joins it) even when its URL differs; the entry is removed when the first settles. Two overlapping stores of one target therefore never interleave writes. C32 `[new]`: a second call with a different source waits for the first, then runs its own (today it silently gets the old image's path). `[ts:src/modules/images/image.service.ts:119-123]`, `[ts:src/modules/images/image.service.ts:141-150]`
3. The cache check (rule 10) runs **before** the concurrency gate, so cache hits are never queued. Misses take one slot of a process-wide FIFO semaphore of **3** (download + decode check + resize + writes); `sharp.concurrency(1)` and `sharp.cache(false)` pin libvips to one thread per operation and no decoded-image cache. Plan §10 says "concurrency 1": decided, rule 24 (3 network slots, 1 CPU permit). `[ts:src/modules/images/image.service.ts:10-41]`, `[ts:src/modules/images/image.service.ts:179-207]`

### B. Source download

4. `GET <url>` with a 15 s timeout, response capped at **20 MiB** (`MAX_DOWNLOAD_BYTES`: counted on the received bytes while streaming, no `Content-Length` pre-check; exceeding it fails the download), up to **21** redirects (axios sets no `maxRedirects`, so follow-redirects' default 21 applies), non-2xx fails. Rust: `reqwest` with a total 15 s timeout (axios' is 15 s to the response headers plus a 15 s socket-idle timer on the body: stricter is fine), explicit 20 MiB stream cap (an early reject on `Content-Length` > cap is fine), `redirect::Policy::limited(21)`, scheme must be `http` or `https` (anything else fails like a download error; axios also decodes `data:` URIs, which no caller passes: live TV filters `^https?://`, providers send `https`). No host allow-list (rule 26). `[ts:src/modules/images/image.service.ts:43-45]`, `[ts:src/modules/images/image.service.ts:187-197]`
5. TMDB URLs: when the URL matches `^https?://image\.tmdb\.org/`, the size segment of `/t/p/<size>/<file>` is replaced by the type's `full` token (`original`) before fetching, so `full` is always TMDB's original even when the stored URL was `w500`; a TMDB-host URL not of the `/t/p/<size>/<path>` shape, and every other host (TVDB, live TV logos, arbitrary), is fetched as is. The cache key (rule 10) is the **URL as passed in**, not the rewritten one. The host test follows the configured image base (metadata rule 35) so tests can mock it. `[ts:src/modules/images/image.service.ts:90]`, `[ts:src/modules/images/image.service.ts:102-107]`, `[ts:src/modules/images/image.service.ts:162]`, `[ts:src/modules/images/image.service.ts:183-186]`
6. Decodability: after the download the bytes must be a decodable image header (`sharp(buffer).metadata()`: header parse only, a truncated file passes); otherwise `None` and nothing is written. Rust: header-level format guess + dimensions via the `image` crate with the decoders enabled for JPEG, PNG, WebP and GIF; SVG, AVIF, HEIF, TIFF are rejected (rule 25). `[ts:src/modules/images/image.service.ts:198-203]`

### C. Size pipeline

7. Per-type widths (`TMDB_SIZE_MAP`; `full` is `original` = the downloaded bytes, never resized): `[ts:src/modules/images/image.service.ts:75-88]`

    | Key (`sizeMapKey`) | thumb | medium | full |
    |---|---|---|---|
    | `media/poster`, `request/poster` | w185 | w500 | original |
    | `media/fanart`, `request/fanart` (and `fanart-<N>`, which maps to `fanart`) | w300 | w780 | original |
    | `media/logo` | w185 | w500 | original |
    | `person` | w45 | (none) | original |
    | `episode` | w300 | w780 | original |
    | `season` | w185 | w500 | original |
    | any other key (`livetv`, `user`, `request/logo`) | (none) | (none) | original |

    `sizeMapKey`: `media`/`request` → `<type>/<variant or poster>` with `fanart-<N>` folded to `fanart`; every other type → the type. `[ts:src/modules/images/image.service.ts:92-100]`
8. Targets = the entries other than `full` whose token is `w<px>`; width = `<px>`. A type with no target stores only the full file. `[ts:src/modules/images/image.service.ts:110-113]`, `[ts:src/modules/images/image.service.ts:211-220]`
9. Resize: width fixed, aspect ratio kept (height rounded), **no enlargement** (a source narrower than the target is re-encoded at its own size), Lanczos3, ICC/EXIF stripped, no EXIF auto-orientation, an embedded ICC profile (or CMYK) is converted to sRGB first; alpha is flattened onto **black** for JPEG output (sharp passes RGBA to libvips' `jpegsave`, whose default `background` is 0); sharp's default input limit of 268 402 689 pixels (16383²) makes a larger source fail its resizes (full kept), Rust sets the same `image::Limits`. Output format by variant: `logo` → PNG (default compression), everything else → **JPEG quality 90** (baseline, 4:2:0). The `image` crate is not byte-identical to libvips, so parity compares dimensions and format, never bytes. Each target is written to `<disk_path(kind, id, variant, size)>` atomically; targets run concurrently; a failed target is `warn`ed and skipped (full is already saved). `[ts:src/modules/images/image.service.ts:247-271]`

### D. Writes, sidecar, cache hit

10. Cache hit (`readCacheHit`), all of: sidecar `<full path minus extension>.src.json` exists and parses as `{url: string, hash: string}`; `meta.url` equals the source key exactly (the URL passed in; for `store_from_disk` `file://<absPath>@<mtimeMs>`); the full file exists; every target file (rule 8) exists. Result `<api_path>?v=<hash>` and no network or CPU work. Any read, parse or access error is a miss. The cache never compares bytes, `ETag` or remote freshness: an upstream image replaced at the same URL is not re-fetched. `[ts:src/modules/images/image.service.ts:355-391]`, specs `[ts:src/modules/images/image.service.spec.ts:50-84]`
11. Store order: `mkdir -p` the directory (`<dataDir>/media/<id>/`, `requests/<key>/`, `persons/`, `episodes/`, `seasons/`, `livetv/`), write the **full file with the downloaded bytes unchanged** (not re-encoded: a PNG or WebP source is stored under the `.jpg` name, served with the extension's content type per `images.md` rule 8; `.png` only for `media` with `variant === 'logo'` and for every `livetv` file, rule 18), then the resized targets (rule 9), then the sidecar last. Full write or mkdir failure → `None`. `[ts:src/modules/images/image.service.ts:225-245]`, `[ts:src/modules/images/image.service.ts:276-282]`
12. Atomic writes: every file (full, variants, sidecar) goes through one `write_atomic(dest, bytes)`: temp file `<dir>/.fliks-tmp-<uuid>` in the destination's directory, copy the destination's mode (`& 0o7777`) when it exists, rename over it (retried up to 5 attempts 100 ms apart on `EBUSY`, plus `EPERM`/`EACCES` on Windows), temp removed on failure. Same helper as the file-transfer and companion code (media spec; `ATOMIC_TEMP_PREFIX` is also the prefix `file-transfer` ignores while scanning). Readers (`images.md` rule 11) never see partial files. `[ts:src/common/utils/atomic-file.ts:28-49]`
13. Hash: `sha1(downloaded bytes)` hex, first 8 characters (the original bytes, also for `store_from_disk`), stored in the sidecar and appended as `?v=<hash>` to the returned API path, so the URL changes exactly when the content does. Sidecar content `{"url":<source key>,"hash":"<8 hex>"}` (compact JSON, written after every other file). `[ts:src/modules/images/image.service.ts:273-282]`
14. Return value `<api_path>?v=<hash>` with `api_path` per `getApiPath`: `media` → `/api/images/media/<id>/<variant|poster>`, `request` → `/api/images/request/<key>/<variant|poster>`, `person|episode|season|user` → `/api/images/<type>/<id>`, `livetv` → `/api/livetv/channels/<id>/logo` (served by live TV, not `images.md`; `?v=` appended as for the others). `[ts:src/modules/images/image.service.ts:489-513]`
15. Failure of the sidecar write (after the files are saved) rejects the Nest promise, so a caller gets an exception instead of `None`; callers treat both as "no local image" except `downloadMediaImages`, where the throw aborts the remaining variants. Rust returns `None` and logs (C32). `[ts:src/modules/images/image.service.ts:278-281]`
16. Stale variants: when a re-store succeeds for `full` but a resize fails, the previous `-thumb`/`-medium` of the old image stays on disk and the cache hit (rule 10, existence only) keeps trusting it. C32 `[new]`: remove each target before writing the new full file, so a failed resize leaves the variant absent and `images.md` rule 6 falls back to `full`. `[ts:src/modules/images/image.service.ts:250-271]`

### E. Local artwork

17. `store_from_disk(abs_path, …)`: `stat` (failure → `None`, warn); source key `file://<abs_path>@<mtimeMs>` (`mtimeMs` as JS prints the float, e.g. `1760000000123.456`; Rust formats the same way, and a mismatch only costs one re-store); cache check (rule 10) with that key; then gate, `readFile`, decodability (rule 6), store (rules 9-13). The path is never written to: sibling artwork stays read-only. The module does no path confinement: callers pass only paths the library scan or NFO reader found under a library root (media spec), never request input. `[ts:src/modules/images/image.service.ts:305-353]`, specs `[ts:src/modules/images/image.service.spec.ts:159-196]`

### F. Layout and live TV gap

18. Path layout is `images.md` rule 7 extended with `livetv`: `<dataDir>/livetv/<id><S>.png`; `S` = `''` | `-thumb` | `-medium`; `ext` `png` iff `variant === 'logo'` (`media`), `request` is always `.jpg`; sidecar = full path with the extension replaced by `.src.json` (`media/<id>/poster.src.json`, `persons/<id>.src.json`, `requests/<key>/fanart.src.json`). One `images::paths` module serves both the serving routes and the store; `<dataDir>` is the shared `data_dir()` (`images.md` rules 12, 18), resolved once. `[ts:src/modules/images/image.service.ts:384-391]`, `[ts:src/modules/images/image.service.ts:424-461]`
19. Callers after S5, all in-process: persons avatar (`person`, `persons.md` rule 12), media import/refresh (`media` poster, fanart, logo, `fanart-1..5`; `season` poster; `episode` still; person avatars of cast, 8 at a time), `store_from_disk` for sibling artwork, request art (`request`, key `<mediaType>-<tmdbId>`, `hasImage` first so a repeat request downloads only a missing variant) `[ts:src/modules/requests/requests.service.ts:441-499]`. The live TV logo cache (`LiveTvLogoService.cacheLogos`, 4 workers, Nest until S7) is the only Nest caller: known gap, rule 20.
20. Known gap until S7: no bridge. In S5 Nest's `LiveTvLogoService` (and its `cacheLogos` call in `livetv-sources.service.ts:484-486`) is deleted with `ImageService`, so a source sync no longer caches channel logos: new channels keep the provider's remote `logoPath` (clients hotlink it, which `cacheOne` already does on a failed download). Logos cached before S5 keep `logoPath = /api/livetv/channels/<id>/logo` and stay served: Nest's `GET /api/livetv/channels/:id/logo` reads `<dataDir>/livetv/<id><S>.png` through a 3-line local helper copied from `getDiskPath` (listed duplication until S7, layout change must be mirrored). S7 ports the cache onto `download_and_store(url, livetv, id, logo)`. `[ts:src/modules/livetv/services/livetv-logo.service.ts:23-52]`, `[ts:src/modules/livetv/controllers/livetv.controller.ts:73-99]`
21. Removal: nothing in Nest deletes images when a media, season, episode, person or request is deleted (`deleteImages` has no caller), so files of deleted rows stay on disk. Not part of this port (rule 27).
22. Data safety: the store only writes under `<dataDir>` (computed from numeric ids or the validated `request` key, never from an external string); `request` keys must match `^(movie|series)-[0-9]+$` and `variant` the F21 regex before reaching the path builder (the Rust API takes typed values: `IdKey::Request` is only constructible from a validated pair). Tests run on a temp `FLIKS_DATA_DIR`.
23. Logging: warn lines carry the failure reason and the URL **without userinfo and query string** (`[new]`, live TV logo URLs can embed credentials or tokens; Nest logged the full URL).
24. `[new]` Decided (reviewer recommendation, kept): rule 3 keeps 3 network slots and adds one CPU permit gating decode, resize and encode in `spawn_blocking`: Nest's throughput and the plan's "concurrency 1" intent (libvips threads).
25. Formats (rule 6) are JPEG, PNG, WebP and GIF; SVG, AVIF, HEIF and TIFF are rejected and the image is skipped (TMDB and TVDB serve JPEG and PNG, sibling artwork is user-supplied). No `avif` decoder (needs a native dav1d build).
26. SSRF (rule 4): kept open as in Nest (admin-trusted inputs; blocking private ranges would break home-lab logo hosts): `http(s)` only, 21 redirects, no host restriction, no setting.
27. Orphan files (rule 21): this port does not delete `<dataDir>/media/<id>` or the per-id files of a deleted season, episode or person; request art is shared by key and never deleted. A `remove_media_images(id)` is a media-spec change, not part of S5.
28. C32 (rules 2, 15, 16) is one bundle: an in-flight join with a different URL waits then reruns, a sidecar failure returns `None`, stale variants are removed before a re-store.

## SQL

none. The store never touches the database; callers persist the returned path (`persons."avatarUrl"`, `media."posterUrl"`, …).

## Events

none.

## Settings keys

none. Configuration is environment only: `FLIKS_DATA_DIR` (`config.md`), and the test seam for the TMDB image base (`metadata.md` rule 35).

## Jobs/timers

none. All work is caller-driven (import, refresh, first person view, request creation, live TV sync).

## Bridges

None. Known gap until S7: the Nest live TV logo cache stops caching new logos from S5 (rule 20); no temporary endpoint. Allowed duplication until S7: the `livetv` path of `getDiskPath` in Nest's logo-serving route (rule 20).

## Deletes in Nest

Milestone S5: all of `src/modules/images/**`: `image.service.ts`, `image.service.spec.ts` (ported as Rust tests, same case names), `image.module.ts`; `ImageModule` imports in `app.module.ts:24,78`, `media.module.ts:34,62`, `livetv.module.ts:30,53`, `requests.module.ts:12,33`, `persons.module.ts:8,16`. (`image.controller.ts` is already gone with S3.) `ImageService` importers rewired in the same PR: `livetv.controller.ts:27,50,88-91` (local path helper, rule 20); `livetv-logo.service.ts` is deleted with its registration (`livetv.module.ts:20,69,77`) and its call (`livetv-sources.service.ts:24,145,484-486`) (known gap, rule 20); the rest move with their modules (media, requests, persons). `src/common/utils/atomic-file.ts` (+ its spec) goes with its last importer (`file-transfer.service.ts`, `media-companions.service.ts`, S5). Keep `src/common/constants/paths.ts` `getDataDir` (backups until S5, live TV playlists until S7, and `getCacheDir`, which derives from it). `sharp` leaves `backend/package.json` only if no other importer remains (`grep -rn "from 'sharp'" backend/src`).

## Vectors/parity

No §5.2 TS vector set (output bytes are not comparable between sharp and the `image` crate). Rust unit tests on generated images (built at test time with the `image` crate: gradient JPEG 1200x1800, RGBA PNG with transparency, 1x1, narrower-than-target, truncated JPEG, non-image bytes, a 21 MiB body, a WebP and a GIF) ported from `image.service.spec.ts` with the same case names: `downloads and resizes on a cold call`, `skips the download and resize on a repeat call with the same URL`, `re-downloads when the URL changes`, `re-downloads when a sized variant is missing on disk`, `returns null when the downloaded bytes are not a decodable image`, `serializes two concurrent calls for the same target so the bytes and sidecar agree`, `storeFromDisk writes the full image, its resized variants and the sidecar`, `is a cache hit on a second call with an unchanged file`, `returns null for a path that cannot be read`, `returns null for a file sharp cannot decode as an image`, plus the new ones: size table per key (rule 7), `fanart-3` shares the fanart widths, TMDB URL rewrite and non-TMDB passthrough (rule 5), 20 MiB cap, redirect limit 21, `logo` is PNG and others JPEG q90 (decoded format and dimensions), no enlargement, sidecar JSON exact shape and hash of the original bytes, atomic temp cleanup on a failing rename, C32 stale-variant removal, in-flight join with a different URL (C32), `request` key traversal rejected at construction, write confined to the temp data dir (symlink and `..` ids).

External HTTP is always mocked (loopback server serving `server/parity/external/images/*`, layout in `metadata.md` Vectors/parity; the image base URL override of metadata rule 35 makes the `image.tmdb.org` host test and rewrite hit the mock). There is no HTTP surface, so parity runs through the flows that call the store and asserts the files in `FLIKS_DATA_DIR=/tmp/fliks-parity/data` (runner `files` assertions: existence, image format and dimensions, sidecar JSON, never bytes): `persons-detail-refresh-tmdb` (`persons/<id>.jpg` 600x900 as served, `-thumb.jpg` 45 wide, no `-medium`, `persons/<id>.src.json`, returned `avatarUrl` `?v=` equals the sidecar hash), `persons-detail-avatar-null` (404 image: nothing written), `requests-create-art` (request art keyed `movie-603`: poster and fanart widths 185/500 and 300/780, second request downloads nothing: mock hit counter), `images-store-logo` (media import with a logo: `.png` + `-thumb.png` + `-medium.png`), `images-store-recache` (same URL twice: mock hit counter 1; changed URL: 2), `images-store-not-an-image` (HTML body: nothing written), `images-store-local-artwork` (media import with a sibling `poster.jpg` fixture). Seed delta: none beyond the persons/requests ones.

## Open questions

None.

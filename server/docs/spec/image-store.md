# Spec: image store (download, resize, cache sidecar)

This is the **write side** of the images: serving `GET /api/images/*` is `images.md` (its rules 7, 12-14 define the path layout and the shared `data_dir()` used here). Callers: persons (`persons.md`), the media import/refresh code (media spec), request art (`requests.md`), live TV logos (`livetv-sources.md`).

## Routes

No public route. The store is an in-process Rust module (`images::store`) with this API:

| Function | Args | Returns |
|---|---|---|
| `ImageStore::download_and_store` | `url: &str`, `t: &Target` (`Target::media(id, variant)`, `Target::request(kind, tmdb_id, variant)`, `person`, `episode`, `season`, `livetv`) | `Option<String>`: `/api/images/...?v=<hash>` or `None` |
| `ImageStore::store_from_disk` | `abs: &Path`, `t: &Target` | same |
| `ImageStore::has_image` | `t: &Target` | `bool` (full file exists) |
| `Target::api_path` / `Target::file` (`disk_path`) | `root`, `size` | `String` / `PathBuf` |

`ImageType` = `media | person | episode | season | request | user | livetv`; `Variant` = `poster | fanart | fanart-<N≥1> | logo`; `ImageSize` = `thumb | medium | full`. The store has no image-deletion or avatar function: avatars are `users.md` rules 32-33.

## Rules

### A. Entry, de-duplication, concurrency

1. `download_and_store` and `store_from_disk` return `None` (never an error) when the work failed: unreachable or non-2xx URL, oversize, not an image, unreadable local file, full-size write failure. Partial success (full written, a resized variant failed) is a success. Every failure logs one `warn` (rule 23).
2. In-flight de-duplication per `<kind>/<id>/<variant or 'default'>` (shared by both entry points): a second call for the same key while one is running with the same source joins it and returns its result; with a different source it waits for the first call, then runs its own. Two overlapping stores of one target therefore never interleave writes, and the entry is removed when the call settles.
3. The cache check (rule 10) runs **before** the concurrency gate, so cache hits are never queued. Misses take one slot of a process-wide FIFO semaphore of **3** (download + decode check + resize + writes); decode, resize and encode are further gated by one CPU permit (rule 24).

### B. Source download

4. `GET <url>` with a total 15 s timeout (`reqwest`), response capped at **20 MiB** (`MAX_DOWNLOAD_BYTES`: counted on the received bytes while streaming; an early reject on `Content-Length` > cap is fine; exceeding it fails the download), up to **21** redirects (`redirect::Policy::limited(21)`), non-2xx fails. The scheme must be `http` or `https` (anything else, `data:` included, fails like a download error; no caller passes another scheme: live TV filters `^https?://`, providers send `https`). No host allow-list (rule 26).
5. TMDB URLs: when the URL matches `^https?://image\.tmdb\.org/`, the size segment of `/t/p/<size>/<file>` is replaced by the type's `full` token (`original`) before fetching, so `full` is always TMDB's original even when the stored URL was `w500`; a TMDB-host URL not of the `/t/p/<size>/<path>` shape, and every other host (TVDB, live TV logos, arbitrary), is fetched as is. The cache key (rule 10) is the **URL as passed in**, not the rewritten one. The host test follows the configured image base (metadata rule 35) so tests can mock it.
6. Decodability: after the download the bytes must be a decodable image header (header parse only: a truncated file passes); otherwise `None` and nothing is written. Format and dimensions come from a header-level format guess with the `image` crate, decoders enabled for JPEG, PNG, WebP and GIF; SVG, AVIF, HEIF, TIFF are rejected (rule 25).

### C. Size pipeline

7. Per-type widths (`TMDB_SIZE_MAP`; `full` is `original` = the downloaded bytes, never resized):

    | Key (`sizeMapKey`) | thumb | medium | full |
    |---|---|---|---|
    | `media/poster`, `request/poster` | w185 | w500 | original |
    | `media/fanart`, `request/fanart` (and `fanart-<N>`, which maps to `fanart`) | w300 | w780 | original |
    | `media/logo` | w185 | w500 | original |
    | `person` | w45 | (none) | original |
    | `episode` | w300 | w780 | original |
    | `season` | w185 | w500 | original |
    | any other key (`livetv`, `user`, `request/logo`) | (none) | (none) | original |

    `sizeMapKey`: `media`/`request` → `<type>/<variant or poster>` with `fanart-<N>` folded to `fanart`; every other type → the type.
8. Targets = the entries other than `full` whose token is `w<px>`; width = `<px>`. A type with no target stores only the full file.
9. Resize: width fixed, aspect ratio kept (height rounded), **no enlargement** (a source narrower than the target is re-encoded at its own size), Lanczos3, ICC/EXIF stripped, no EXIF auto-orientation, CMYK JPEGs are decoded to RGB by the decoder, an embedded ICC profile is not applied (the `image` crate has no colour management and TMDB/TVDB artwork is sRGB); alpha is flattened onto **black** for JPEG output; the source is decoded once for all its variants and refused over 40 000 000 pixels (its resizes fail, the full file is kept), with `image::Limits::max_alloc` at 320 MB. Output format by variant: `logo` → PNG (default compression), everything else → **JPEG quality 90** (baseline, 4:2:0). Output bytes are not stable across encoders, so parity compares dimensions and format, never bytes. Each target is written to `<disk_path(kind, id, variant, size)>` atomically; targets run concurrently; a failed target is `warn`ed and skipped (full is already saved).

### D. Writes, sidecar, cache hit

10. Cache hit (`readCacheHit`), all of: sidecar `<full path minus extension>.src.json` exists and parses as `{url: string, hash: string}`; `meta.url` equals the source key exactly (the URL passed in; for `store_from_disk` `file://<absPath>@<mtimeMs>`); the full file exists; every target file (rule 8) exists. Result `<api_path>?v=<hash>` and no network or CPU work. Any read, parse or access error is a miss. The cache never compares bytes, `ETag` or remote freshness: an upstream image replaced at the same URL is not re-fetched.
11. Store order: `mkdir -p` the directory (`<dataDir>/media/<id>/`, `requests/<key>/`, `persons/`, `episodes/`, `seasons/`, `livetv/`), write the **full file with the downloaded bytes unchanged** (not re-encoded: a PNG or WebP source is stored under the `.jpg` name, served with the extension's content type per `images.md` rule 8; `.png` only for `media` with `variant === 'logo'` and for every `livetv` file, rule 18), then the resized targets (rule 9), then the sidecar last. Full write or mkdir failure → `None`.
12. Atomic writes: every file (full, variants, sidecar) goes through one `write_atomic(dest, bytes)`: temp file `<dir>/.fliks-tmp-<uuid>` in the destination's directory, copy the destination's mode (`& 0o7777`) when it exists, rename over it (retried up to 5 attempts 100 ms apart on `EBUSY`, plus `EPERM`/`EACCES` on Windows), temp removed on failure. Same helper as the file-transfer and companion code (media spec; `ATOMIC_TEMP_PREFIX` is also the prefix `file-transfer` ignores while scanning). Readers (`images.md` rule 11) never see partial files.
13. Hash: `sha1(downloaded bytes)` hex, first 8 characters (the original bytes, also for `store_from_disk`), stored in the sidecar and appended as `?v=<hash>` to the returned API path, so the URL changes exactly when the content does. Sidecar content `{"url":<source key>,"hash":"<8 hex>"}` (compact JSON, written after every other file).
14. Return value `<api_path>?v=<hash>` with `api_path` per `getApiPath`: `media` → `/api/images/media/<id>/<variant|poster>`, `request` → `/api/images/request/<key>/<variant|poster>`, `person|episode|season|user` → `/api/images/<type>/<id>`, `livetv` → `/api/livetv/channels/<id>/logo` (served by live TV, not `images.md`; `?v=` appended as for the others).
15. A failure of the sidecar write (after the files are saved) returns `None` and logs.
16. Stale variants: each target is removed before the new full file is written, so a failed resize leaves the variant absent and `images.md` rule 6 falls back to `full`; the cache hit (rule 10, existence only) therefore never trusts a variant of the previous image.

### E. Local artwork

17. `store_from_disk(abs_path, …)`: `stat` (failure → `None`, warn); source key `file://<abs_path>@<mtimeMs>` (`mtimeMs` printed as a JS number, e.g. `1760000000123.456`; a mismatch only costs one re-store); cache check (rule 10) with that key; then gate, `readFile`, decodability (rule 6), store (rules 9-13). The path is never written to: sibling artwork stays read-only. The module does no path confinement: callers pass only paths the library scan or NFO reader found under a library root (media spec), never request input.

### F. Layout, callers, safety

18. Path layout is `images.md` rule 7 extended with `livetv`: `<dataDir>/livetv/<id><S>.png`; `S` = `''` | `-thumb` | `-medium`; `ext` `png` iff `variant === 'logo'` (`media`), `request` is always `.jpg`; sidecar = full path with the extension replaced by `.src.json` (`media/<id>/poster.src.json`, `persons/<id>.src.json`, `requests/<key>/fanart.src.json`). One `images::paths` module serves both the serving routes and the store; `<dataDir>` is the shared `data_dir()` (`images.md` rules 12, 18), resolved once.
19. Callers, all in-process: persons avatar (`person`, `persons.md` rule 12), media import/refresh (`media` poster, fanart, logo, `fanart-1..5`; `season` poster; `episode` still; person avatars of cast, 8 at a time), `store_from_disk` for sibling artwork, request art (`request`, key `<mediaType>-<tmdbId>`, `hasImage` first so a repeat request downloads only a missing variant). The live TV logo cache (`livetv::logos`, 4 workers, `livetv-sources.md` rules 42 and 44) calls `download_and_store(url, Target::livetv(id))` (rule 20).
20. Live TV logos: after a source sync, `livetv::logos::cache_source` takes the enabled channels of the source whose `logoPath` is still a provider URL (`^https?://`) and caches each (4 at a time) with `download_and_store`; a cached logo sets `logoPath = /api/livetv/channels/<id>/logo`; a failed download keeps the provider URL, retried at the next sync. The file is read from `<dataDir>/livetv/<id><S>.png` by the live TV logo route.
21. Removal: nothing deletes images when a media, season, episode, person or request is deleted, so files of deleted rows stay on disk (rule 27).
22. Data safety: the store only writes under `<dataDir>` (computed from numeric ids or the validated `request` key, never from an external string); `request` keys must match `^(movie|series)-[0-9]+$` and `variant` `^(poster|fanart|fanart-[0-9]+|logo)$` before reaching the path builder (the Rust API takes typed values: `IdKey::Request` is only constructible from a validated pair). Tests run on a temp `FLIKS_DATA_DIR`.
23. Logging: warn lines carry the failure reason and the URL **without userinfo and query string** (live TV logo URLs can embed credentials or tokens).
24. Rule 3's 3 network slots overlap downloads; one CPU permit gates decode, resize and encode in `spawn_blocking`, so at most one image is processed on the CPU at a time.
25. Formats (rule 6) are JPEG, PNG, WebP and GIF; SVG, AVIF, HEIF and TIFF are rejected and the image is skipped (TMDB and TVDB serve JPEG and PNG, sibling artwork is user-supplied). No `avif` decoder (needs a native dav1d build).
26. SSRF (rule 4): not restricted (admin-trusted inputs; blocking private ranges would break home-lab logo hosts): `http(s)` only, 21 redirects, no host restriction, no setting.
27. Orphan files (rule 21): the store does not delete `<dataDir>/media/<id>` or the per-id files of a deleted season, episode or person; request art is shared by key and never deleted. A `remove_media_images(id)` would be a media-spec change.
28. Rules 2, 15 and 16 together: an in-flight store with a different source waits then reruns, a sidecar failure returns `None`, stale variants are removed before a re-store.

## SQL

none. The store never touches the database; callers persist the returned path (`persons."avatarUrl"`, `media."posterUrl"`, …).

## Events

none.

## Settings keys

none. Configuration is environment only: `FLIKS_DATA_DIR` (`config.md`), and the test seam for the TMDB image base (`metadata.md` rule 35).

## Jobs/timers

none. All work is caller-driven (import, refresh, first person view, request creation, live TV sync).

## Vectors/parity

No fixture set (output bytes are not comparable between encoders). Rust unit tests in `crates/server/src/images/store.rs` run on generated images (built at test time with the `image` crate: gradient JPEG 1200x1800, RGBA PNG with transparency, 1x1, narrower-than-target, truncated JPEG, non-image bytes, a 21 MiB body, a WebP and a GIF): cold download and resize; repeat call with the same URL skips download and resize; changed URL re-downloads; a missing sized variant re-downloads; undecodable bytes return `None`; two concurrent calls for one target serialise; an in-flight store with another URL waits then stores its own; `store_from_disk` writes the full image, variants and sidecar, is a cache hit on an unchanged file and returns `None` for an unreadable or undecodable path; size table per key (rule 7, `fanart-3` shares the fanart widths); `logo` is PNG and others JPEG q90 without enlargement; WebP and GIF accepted, SVG rejected; TMDB URL rewrite and non-TMDB passthrough (rule 5); 20 MiB cap and redirect limit 21; a failed resize leaves no stale variant (rule 16); `has_image` checks the full file.

External HTTP is always mocked (loopback server; `server/parity/external/img/` serves the artwork fixture, the image base URL override of `metadata.md` rule 35 makes the `image.tmdb.org` host test and rewrite hit the mock). There is no HTTP surface, so parity runs through flows that call the store: `server/parity/scenarios/persons/detail-refresh-tmdb.json` (the avatar is stored as `persons/<id>.jpg` with its `-thumb.jpg`, no `-medium`, and a `persons/<id>.src.json` sidecar; the returned `avatarUrl` `?v=` equals the sidecar hash) and `detail-avatar-null.json` (404 image: nothing written).

## Open questions

None.

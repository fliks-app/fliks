# Spec: library optimization (profiles, difference, preview)

Scope: `optimize_profiles`, the profile document, the comparison of a file with its library's profile, the preview and counter routes. The job queue, lease, commit and worker protocol are out of scope. Module: `crates/server/src/optimize/`.

## Routes

All need a credential. Reads: `Read Settings`; writes: `Manage Settings`.

| Method path | Request | Response | Errors |
|---|---|---|---|
| `GET /api/optimize/presets` | none | 200, `[{key, document}]` for `balanced`, `cleanup_only`, `direct_playback` | 403 |
| `GET /api/optimize/profiles` | none | 200, `Profile[]` by name | 403 |
| `GET /api/optimize/profiles/:id` | path `id` | 200, `Profile` | 400, 403, 404 |
| `POST /api/optimize/profiles` | `{name, document}` | 201, `Profile` | 400 (name 1-120 chars, document rules), 403 |
| `PUT /api/optimize/profiles/:id` | `{name, document}` | 200, `Profile` | 400, 403, 404 |
| `DELETE /api/optimize/profiles/:id` | path `id` | 204; libraries using it fall back to no profile | 403, 404 |
| `GET /api/libraries/:id/optimize/preview?profileId=` | profile defaults to the library's | 200, `Preview` | 400 (no profile), 404 |
| `POST /api/libraries/:id/optimize/preview/file` | `{fileId, profile?}`; `profile` is an unsaved document, the library's profile when absent | 200, the file's `Outcome` (`status` `excluded`/`skipped`/`conform`/`diff`, with `level`, `changes`, `warnings` for a diff) | 400 (no profile, invalid document), 404 (not a candidate of the library) |
| `GET /api/libraries/:id/optimize/summary` | path `id` | 200, `{profileId, filesWithDifference, computedAt}` | 404 |

`Profile` = `{id, name, document, libraryCount, createdAt, updatedAt}`. Libraries are assigned with `PATCH /api/libraries/:id` (`optimizeProfileId`, `optimizeNewFiles`, `allowRename`; see `libraries.md`).

## Rules

1. The document has the six sections of the plan (`eligible`, `video`, `audio`, `subtitles`, `file`, `guards`), all required, unknown keys rejected. Extra rules: `software_max_hours >= 1`, `min_bitrate` null or > 0, `min_savings_pct <= 100`, `video.when.codec` in `h264 hevc av1 vc1 mpeg2 mpeg4`, `audio.drop` in `commentary audio_description`, language tokens are `original`, `media_profile` or an ISO 639 code, and `drop_other_languages` needs a non-empty list.
2. Presets are templates returned by `GET /api/optimize/presets`; no row is created and no library is assigned by default.
3. The comparison reads only the database: `media_files."streamInfo"`, `movie_details`/`series_details."originalLanguage"`, the media's `language_profiles` (library default when unset), `client_codecs` seen in the last 90 days, `playback_qoe_sessions` of the last 30 days. It never reads the disk.
4. Candidates: probed at `PROBE_VERSION` or later, probe without `error`, at least one video stream, no queued/leased/staged/committing job (unless ids are given), and no failed job of class `corrupt` or `damaged` for the same size and mtime. A file outside these, or younger than `eligible.min_age_days`, is not counted.
5. Each candidate is `conform` (no change), `skipped: container` (the extension would change and the library does not allow renaming) or has a `Diff`: its `changes` and `warnings`, and a `level` that is the heaviest change (`metadata` < `remux` < `reencode`). A change on a non-MKV file is at least `remux`.
6. Codec: explicit `hevc`/`av1`, or `auto` by `video.goal` (`space`: AV1 when a worker encodes it and the main engine decodes it in hardware, else HEVC; `compatibility`: the most efficient of AV1/HEVC decoded by every recent device, none when no device is known). The target must be encodable and strictly more efficient than the source (AV1 > HEVC > H.264 > VC-1, MPEG-2, MPEG-4 ASP). AV1 is 10-bit; HEVC keeps the source depth.
7. Video: re-encoded only when `video.enabled`, `when` matches, and the target improves on the source codec or `max_resolution` forces a reduction. `crop_in_file` re-encodes any file with a stable crop (even already in the target codec, ignoring `when`), flagged `cropOnly`. Interlaced sources, Dolby Vision profile 5, and (with `skip_hdr10plus_dv`) Dolby Vision or HDR10+ keep their video and add a `videoCopied` warning.
8. Audio and subtitles follow the plan's "Model" section: unknown languages are never removed (a lone audio track takes the original language), a kept language is never emptied, a file keeps at least one audio track (`noAudioWouldRemain`), the languages of the media's `language_profiles` are always kept for subtitles, image subtitles follow `image`, tracks are reordered by language order then quality.
9. The counter is cached per library and profile, recomputed when the profile, the library or a file row changed, or after 15 minutes.
10. `client_codecs` holds one row per client device id (label and platform when it sends none): the whole `directPlayProfiles` of its last playback-info, replaced by each request. The video codecs and the audio codecs of a video file a device decodes are the union over its entries that list a video codec: the audio-files entry (no video codec) does not count for a video file; a client therefore sends the same full profile on every request (`item-delivery.md` rule 29).

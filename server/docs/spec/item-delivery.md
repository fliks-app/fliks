# Spec: item delivery (audio and text items, item identity on playback routes, finished rules)

Scope: how the host delivers the audio and text items of a book: resolving an item to its parts, the item playback-info and its session, what the engine resolver answers for them, the `itemId` that names an item on the playback routes, the progression and locator of a text item, and the finished rule of each family. The engine side is `fliks-engine` 1.9.0 (`PROTOCOL.md`, `docs/spec/item.md`: `DecideMedia.parts`, `ResolveResponse.parts`, `PlaybackInfo.parts`). Model: `items.md`, `books.md`. The plan is `plans/books-audiobooks.plan.md` sections 3.3 and 3.7, phase items 2.1 and 2.2. No client in this change.

## Routes

| Route | Auth | Shape |
|---|---|---|
| `POST /api/items/:itemId/playback-info` | `StreamAuthed` | body `DeviceProfile`, query of `playback-info.md` rule 1 less `burnInSubtitleId` and `preRollFirst`, plus `version`; 201, the engine decision plus the keys of rule 10 |
| `POST /engine/resolve` | engine host token | `parts` for the files of an audio item (rules 11-12) and `format` for audio and text files (rule 13) |
| `PUT/GET/DELETE /api/playback/media/:mediaId/state`, `POST .../toggle-watched` | as before | `itemId` names the item (rules 15-17); the beat carries `progression` and `locator` (rules 18-21) |

## Resolving an item

1. `resolve(item, version?)` is what the item playback-info and the resolver share. The item must exist, belong to a media the caller can read (`media."libraryId"` among the caller's libraries) and to a visible edition (`COALESCE(editions."libraryId", media."libraryId")`, `books.md` rule 22); anything else is a 404 `Item #<id> not found`, the same for a hidden and a missing item.
2. The edition must be of the `audio` family, else 400 `Item #<id> is not an audio item`. A text item has no playback session: its file is delivered by rule 14.
3. The version is `?version=n` when the item has it, else the version that replaced it (`book-ingest.md` rule 18, `item_version_aliases`), else 404 `Item #<id> has no version <n>`; else the version of the caller's saved state while the item still has it; else the item's highest version (`items.md` rule 35). Parts are that version's `item_parts` in `position` order; no part is a 404 `Item #<id> has no file`.
4. Every part goes through the file gate of `playback-info.md` (`resolve_file`: library ACL, `libraries::assert_file_accessible` on `HIDDEN_FILES_FROM`, file on disk, real path under its folder root); the first part that fails answers its own 404 and the item is not opened.
5. A part's duration is its probe's `streamInfo.durationSeconds` (missing counts 0) and its offset is the sum of the durations before it, the timeline of `books-api.md` A6. A part is a whole file (no slice).
6. The delivery id is the first part's file id: the id of the data-plane URLs (`/api/stream/{id}/item/index.m3u8`, `/api/stream/{id}/parts/{n}`), of the resolver, and of the `mf` of a stream token minted for the item.

## Item playback-info

7. The route resolves the item (rules 1-6), opens one engine session whose `decide.media` is the first part's `{path, ext, contentType}` with `parts = [{path, info}]` of every part (an item of one file included), and answers as `playback-info.md` does for a file. Video behaviour is untouched: the file route never sends `parts`.
8. Not done for an item: scan lookup, burn-in, subtitle renditions, pre-roll, EDL, scan keeping and stale re-probe. `sourceVersion` is the `<size>-<mtimeMs>` of every part joined by `|`, so replacing the bytes of any part forks the engine's cache. `audioStreamIndex` is read against the first part's audio streams and applies to every part (engine rule).
9. Start position: `startAt`, else the saved position of the item when it is more than 10 s and not completed. Unless `download=1`, the state row of the item is ensured with `mediaFileId` = the delivery id and `lastPlayedAt` bumped, like a file's.
10. Answer: the engine decision (its `parts[]` carry the byte-range URLs and offsets) plus `itemId`, `mediaFileId` (the delivery id), `version`, `sessionId`, `playUrl`, `startAtSeconds`, `durationSeconds` (the sum of the part durations), `markers` of the item when it has some, and `chapters`: the `chapter` markers of the version's parts, each shifted by its part's offset and ordered by start. Presence, QoE and the tags are those of a file session, keyed to the delivery id; the heartbeat names the item (rule 15).

## Resolver

11. For `stream` and `download`, a file linked to an item of an `audio` edition answers `parts` beside its own `path` (the engine's file route reads only `path`, so a direct play or download of a part works): the parts of its item (the lowest-numbered one, `items.md` rule 22) in the version the file belongs to, in `position` order, one `{path, durationS?, format}` per part, a one-file item included. Each part passes the file gate of rule 4 (a failing part denies the whole answer). `ttlS` is the usual 60.
12. Every other file answers `path` as before; video is unchanged. `sprite` and `subtitle` purposes are unchanged.
13. `format` is the MIME type of the file for an audio extension (the engine's `audio_mime`: `mp3 audio/mpeg`, `m4a`/`m4b audio/mp4`, `aac audio/aac`, `flac audio/flac`, `ogg`/`oga`/`opus audio/ogg`, `wav audio/wav`) and a text one of the ingest list (`epub application/epub+zip`, `pdf application/pdf`, `azw3 application/vnd.amazon.ebook`, `mobi application/x-mobipocket-ebook`, `fb2 application/x-fictionbook+xml`, `cbz application/vnd.comicbook+zip`, `cb7 application/x-cb7`, `cbr application/vnd.comicbook-rar`); a video file still carries none. The same table gives `DecideMedia.contentType` and each part's `format`.
14. A text file is delivered by the engine's data plane as a Direct Play: `GET /api/stream/{fileId}` and `?download=1`, behind the resolver with `path` and `format`, no session, with a stream token minted for `{mediaFileId}`. A hidden edition's file is denied (`engine-glue.md` rule 41).

## Item identity on the playback routes

15. `itemId` (integer) names the item directly: in the body of the heartbeat and of `toggle-watched`, and in the query of `GET` and `DELETE state`. The item must belong to the path `mediaId` and to a visible edition (`COALESCE(editions."libraryId", media."libraryId")` among the caller's libraries, like rule 1), else it names none (the answer of an unknown pair: empty body, no-op, 404 `not_found`, `{state: null}`). When `itemId` is present `episodeId` is not read. The same gate (media library, then visible edition) applies to the item a `(mediaId, episodeId?)` pair names.
16. Without `itemId` the pair `(mediaId, episodeId?)` resolves as before, so a book with several editions is still `409 ambiguous_item`. The wire `episodeId` of a state, of `remote.state` and of the history is the item's id only when the item is grouped, whatever named it.
17. The heartbeat's debounce key is `<user>:<media>:i<itemId>` when `itemId` is given, so two editions of one book never share a flush. A file-bound token must be a part of the named item (the route's auth in `heartbeat.md`).

## Progression and locator

18. `playback_states."progression"` (`double precision`, null, `CHECK` between 0 and 1) is the share of a text item read; `"locator"` (`jsonb`, null) is the reading position the reader gave (a Readium locator), opaque to the host. Audio and video leave both null.
19. A beat carrying `progression` (a finite number, clamped to 0..1) and `locator` (a JSON object whose serialisation is at most 8 KiB, else ignored) writes them with the row; a beat without them keeps what is stored. A change of `progression` or `locator` since the last write flushes the debounce, so the last reading position is not lost. `positionSeconds` and `durationSeconds` stay as received (a text beat usually sends none).
20. The state row serialises `progression` and `locator` only when not null, so the video payloads keep their keys.
21. Reads of the progress of a book use it: `BookDetail.progress.progression` is 1 when completed, else the row's `progression` when set, else `positionSeconds / durationSeconds` capped at 1; `inProgress=true` (`books-api.md` A1) counts an unfinished state whose `positionSeconds` or `progression` is above 0.

## Finished by family

22. `fliks_domain::media::finish::finished(family, standing)` decides whether a beat completes the item; `standing` is `{position, duration, progression?, lastChapterStart?}` and the family is the item's edition family:
    - `video`: `duration > 0` and `position >= duration - 30` or `position >= duration * 0.9` (the rule of every video heartbeat, unchanged).
    - `audio`: `duration > 0` and `position >= duration * 0.98`; or the position is at or past the start of the last chapter, when the item's version has at least two chapters and that start is above 0 (a one-chapter book, or a part-per-chapter fallback of one part, never finishes by it).
    - `text`: `progression >= 0.99`. The last position of a Readium publication has a `totalProgression` just under 1, so the last page is read as 0.99; no page count is needed.
    - `image`: `progression >= 0.99`, like `text` (a comic reader reports only a progression).
    - `audio` of a track (`standing.music`, the item of an `album`): `duration > 0` and `position >= min(duration / 2, 240)`. A track keeps no resume position (the state stores 0), is excluded from Continue Watching and its resume info, and each completion adds a history row (its play count).
23. The last chapter start of an audio item is read from the `chapter` markers of its version's parts shifted by their offsets (rule 5), when the heartbeat names an audio item.
24. `completed` is recomputed on every written beat, as before; an offline replay keeps its rule (`heartbeat.md` rule 21) with the same family rule. The debounce flushes every beat of the finish zone: the video zone, and a text or image `progression` of 0.99 or more; and a beat whose `progression` or `locator` differs from the last write's (rule 19).

## Migration

25. `1789000000400_playback-progression.sql` adds `progression` and `locator` and the `CHECK`. It backfills nothing and drops nothing. `parity/seed/build.sh` needs no change beyond the migration list.

26. The state row of a beat or replay is one upsert on `("userId", "itemId")`: two first writes at once (two devices, or the web reader and kosync) both succeed, the later one updating the row. `Watch.clear_locator` makes the same statement store a NULL `locator` (`kosync.md` rule 14).

## Not done

- Continue-watching rows, resume info and `GET media/:id` for a text item (they read `positionSeconds`); the mixed Continue row of plan 3.3.
- Chapters for a part-per-chapter fallback, Audnexus chapters in the item playback-info (the chapters route has them), alignment between editions.
- `toggle-series-watched` and the season toggles (video only).

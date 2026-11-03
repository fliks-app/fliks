# Spec: comics in the catalogue

Scope: what the `comic` kind adds to the data model and to the media payloads: the kind and its family, a volume and its issues, `comic_details`, `comic_issues`, arcs and collected editions as collections, the wire shapes of the detail and the list. Archive ingest, the page routes, `ComicInfo.xml` and file-name parsing, metadata providers, acquisition, OPDS and the reader are later work (`plans/books-audiobooks.plan.md`, phase 7). The wire contract shared with the client is `plans/comics-contract.md`; the migration is `1789000000700_comics.sql`.

## Kind and families

1. `MediaKind::Comic`: wire name `comic` (`media.type`, `requests."mediaType"`, `user_quotas.kind`, the `comic` level of `cleanup_rules.levels`), `has_seasons` false, `families` `[Image]`, `count_key` `comics`, `completed_stat_key` `comicsFinished`. Every exhaustive `match` on `MediaKind` has a `comic` arm. The kind CHECKs list `MediaKind::ALL`; the family CHECKs (`editions.family`, `wants.family`, the quality families) gain `image`, the family `Family::Image` was reserved for (`items.md` rule 39).
2. A comic is one `media` row of type `comic`: one series volume (a run, e.g. the one that started in 2016), with the work-level title, overview, year and poster on `media`. A library accepts the type like any kind: `"comic"` in `libraries."mediaTypes"`.
3. `create_shell` for a comic inserts one `image` want (`language` NULL, no quality profile) and no edition and no item, like a book. Ingest creates the volume's `image` edition (format `cbz`, `cb7`, `cbr` or `pdf`, the `editions.format` shape of `books.md` rule 5) and one item per issue.
4. A media cannot become a comic or stop being one: `PUT /api/media/:id` answers `400 A comic cannot change type`.

## Volume and issues

5. `comic_details("mediaId", kind = 'comic', publisher, "startYear", volume, "originalLanguage")` is the volume-level detail row, one per comic, `kind` pinned by a composite foreign key (`media-details.md` rule 12). `"startYear"` is 1 to 9999, `volume` the number printed on the cover (`>= 0`), NULL when unknown. `media_details_json` has a fourth arm for it (every video-only key NULL), and the import of a comic inserts an empty row.
6. An issue is an ungrouped item of the volume's edition (`items.md` rule 4: a comic has no group). A comic therefore never appears in an episode list, count or lookup (`items.md` rule 12), and `item_of(comic, NULL)` answers `NULL` with several issues (`items.md` rule 36): an issue is addressed by its item id.
7. `comic_issues("itemId", "sortNumber", label, annual, "pageCount")` holds the facts of an issue item, one row per item, `ON DELETE CASCADE` with it. `"sortNumber"` is the decimal sort key (`1`, `1.5`, `0`, `-1`), `label` the printed number (`"1"`, `"1.5"`, `"0"`), never empty, `annual` marks annuals and specials, `"pageCount"` is positive or NULL. **Decision:** `items."number"` stays an integer (every series path reads it), so the decimal key and the label live in this table, and annuals are a flag, not an item group: a group makes an item an episode for every query of `items.md` rule 12. `items.title` and `items."airDate"` carry the issue's title and release date; a variant cover of one number is another row with the same `"sortNumber"`, none is unique.
8. Story arcs and collected editions (TPB, omnibus) are `collections` with comic entries: an entry is the volume (`"itemId"` NULL) or one issue (`"itemId"` set, `position` the order in the arc), as `media-details.md` rule 17 and `items.md` rule 38 allow. There is no `collections.kind` column: the collection of a comic is the generic collection page.

## Wire

Keys absent for other kinds: a movie, series or book payload carries no `comic` key.

9. `GET /api/media/:id` of a comic carries `comic: ComicDetail` (`plans/comics-contract.md`): `publisher`, `startYear` and `volume` from `comic_details` (null when no row), and `issues`, the main issues by `"sortNumber"` ascending then the annuals by `"sortNumber"` ascending (ties by item id). An issue is `{itemId, mediaFileId, number (label), sort, annual, title, releaseDate (YYYY-MM-DD or null), pageCount, progression, finished}`.
10. `mediaFileId` is the first part of the issue's highest version (`items.md` rule 35) when the edition is readable by the caller (`COALESCE(editions."libraryId", media."libraryId")` in the caller's libraries), else `null`, which also stands for an issue without a file. `progression` is the caller's `playback_states` row: `1` when completed, else its `progression`, else position over duration, `null` when the caller never opened the issue. `finished` is the row's `completed`.
11. A list item of `GET /api/media?type=comic` (and of every list that returns comics) carries `comic: {publisher, startYear, issueCount, readCount}`: the issues of the volume, and the ones the caller completed.
12. A comic counts in `GET /api/media/counts` and `GET /api/counts` under `comics`, in a user's `comicQuotaLimit` (read and written like `bookQuotaLimit`, `users.md` rule 19) and in the social stats as `comicsFinished`.
13. A comic is `watched` as any non-seasonal kind is: when any of its items is completed (`books.md` rule 15 without the 100 % rule). The per-issue state is on the detail (`finished`, `readCount`).

## Migration

14. `1789000000700_comics.sql` is one transaction: the widened CHECKs, `comic_details`, `media_details_json` and `comic_issues`. It backfills nothing. Numbers `1789000000700` to `709` are reserved by track for comics.

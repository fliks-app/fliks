# Spec: books in the catalogue

Scope: what the `book` kind adds to the data model: the kind and its families, the editions of a work and their facts, the ids of editions and works, `book_details`, series as collections, sort keys, the watched rule. The HTTP shapes are in `books-api.md`, the metadata seams in `book-metadata.md`, the ingest seams in `book-ingest.md`, the file parsers in `books-files.md`, the provider parsers in `book-providers.md`. The plan is `plans/phase1-contracts.md`; the migration is `1789000000200_books.sql`. After the contract PR this file belongs to the data and API track.

## Kind and families

1. `MediaKind::Book`: wire name `book` (`media.type`, `requests."mediaType"`, `user_quotas.kind`, the `book` level of `cleanup_rules.levels`), `has_seasons` false, `families` `[Text, Audio]`, `count_key` `books`, `completed_stat_key` `booksFinished`. Every exhaustive `match` on `MediaKind` has a `book` arm; the kind and family CHECKs list `MediaKind::ALL` and the families some kind is wished in (`items.md` rule 39), widened by the migration to `text` and `audio`.
2. A work is one `media` row of type `book`; an edition is one `editions` row of the work, in one family. A book keeps a work-level title, overview, year and poster on `media`, like any other kind.
3. `create_shell` for a book inserts no edition and no item, and one want per family (`text`, `audio`; `language` NULL, no quality profile). Ingest creates one edition per family it finds, each with one ungrouped item (rule 4). A want whose family has no quality table (`fliks_domain::quality::table(f)` empty, true for `audio` and `text` until phase 3.1) is never an acquisition candidate (`plugins.md` rule 31).
4. A book has one ungrouped item per edition and no group (`items.md` rule 4). `item_of(book, NULL)` with two editions answers `NULL` (`items.md` rule 36), so a book is read through its editions, never through a bare pair. A media cannot become a book or stop being one: `PUT /api/media/:id` answers `400 A book cannot change type`.

## Editions

5. The facts of an edition are nullable columns of `editions`: `language` (a `normalize_language_code` result, NULL unknown), `title` (NULL means the work's title), `format` (a file or medium name, `^[a-z0-9]{1,8}$`: `epub`, `pdf`, `azw3`, `mobi`, `fb2`, `cbz`, `m4b`, `mp3`, `flac`, `ogg`, `opus`, `m4a`, or a provider's `ebook`, `print`, `audio`), `coverUrl` (an image-store path, as `media."posterUrl"`), `publisher`, `durationSeconds` and `pageCount` (positive). They are filled by the edition merge (`book-metadata.md`) and by ingest from the files (`book-ingest.md`); the work keeps its own columns on `media`.
6. `editions."libraryId"` is NULL for "the work's library" (`media."libraryId"`); a value places the edition in another library, which decides who sees it and where its files live. It is `ON DELETE SET NULL`.
7. `edition_external_ids("editionId", "mediaId", provider, value)` holds the ids of an edition: `isbn` (ISBN-13), `asin`, `openlibrary` (`OL...M`), `googlebooks`, `bnf`, each under the `CHECK` shape of `ExternalProvider::normalize`. The primary key is `(editionId, provider, value)`: an edition has several ISBNs. **Decision:** it is not unique on `(provider, value)`: provider catalogues duplicate ISBNs across records, and a unique key would make ingest fail on real data. A lookup by id takes the lowest edition id, like `external-ids.md` rule 6. The index `(provider, value)` serves it.
8. `edition_field_sources("editionId", field, provider, locked)` is `media_field_sources` for an edition: which provider supplied a field, and whether the admin locked it. `field` is a `Field::as_str` name.
9. A release date of an edition is a `media_release_dates` row with its `editionId`; a work-level date has a NULL `editionId`. `UNIQUE NULLS NOT DISTINCT (mediaId, editionId, kind)` replaces the primary key. Every read or write of a work's dates filters `"editionId" IS NULL`, and the upsert names the constraint `UQ_media_release_dates`.

## Work details, ids and series

10. `book_details("mediaId", kind = 'book', subtitle, originalLanguage, subjects jsonb)` is the work-level detail row, one per book, `kind` pinned by a composite foreign key like the other details tables (`media-details.md` rule 12). `media_details_json` has a third arm for it: every video-only key is NULL and `originalLanguage` comes from the row. `subtitle` and `subjects` are read by the book object (`books-api.md`), not by `metadata`.
11. Work ids live in `media_external_ids`: the provider set gains `openlibrary` (`OL...W`, `CK_media_external_ids_openlibrary`). The anchor index `UQ_media_external_ids_anchor` is unique on `(kind, provider, value)` for `tmdb` and `openlibrary`: one work per OpenLibrary id. `ExternalProvider::is_unique` is true for exactly those two (`external-ids.md` rules 2 and 4). A request names a book by `('book', 'openlibrary', OLID)` (`CK_requests_provider` and `CK_requests_externalId` gain it).
12. Person ids (`person_external_ids`) gain `openlibrary` (`OL...A`), `asin` and `bnf` (an authority record number, 6 to 12 digits); collection ids (`collection_external_ids`) gain `asin` and `bnf`.
13. A series is a `collections` row whose entries carry `position` and `positionLabel` (`1.5`, `II`); there is no `collections.kind` column and the series page is the generic collection page.
14. `persons."sortName"` is a nullable sort form of the name (`Le Guin, Ursula K.`); `media."sortCreator"` is the sort name of the work's first author (`COALESCE(persons."sortName", persons.name)` of the lowest-position `author` credit with a NULL `editionId`), NULL when it has none. It is maintained by triggers on `media_credits` (one per insert, update and delete, each `WHEN` the row is an `author`, so a video credit write never runs it) and on `persons` (`name`, `sortName`), through `refresh_media_sort_creator` (the `persons` trigger locks the affected media rows in `id` order, so two concurrent renames cannot deadlock), so no writer has to remember it. A change of `sortCreator` alone does not bump `media."updatedAt"` (`media_set_updated_at`); every other change does. `IDX_media_sortCreator` serves the author sort.

## Behaviour

15. A book is `watched` when any of its items is completed; `progressPercent` is 100 once watched, else the progress of the most recently played item. The progress of each edition stays on the work page (`BookDetail.progress`).
16. The volumes missing from a series are the integers `1..max(position)` that no owned entry covers (`positionEnd` extends an entry to a range). No provider series listing exists in phase 1; the Audible series ASIN is stored for later.
17. Phase 1 adds books, it does not request them: the preview offers "Add" (permission `media.write`), no request button for `book`, and "follow new releases" and series monitoring are hidden (they need `person_follows` and wants, phase 3.3).
18. Cleanup handles a book as a whole media, at the `book` level (`cleanup.md`).
19. A book counts in `GET /api/media/counts` and `GET /api/counts` under `books`, in a user's `bookQuotaLimit` (a `Quotas` serialiser entry per kind) and in the social stats as `booksFinished` (`MediaKind::count_key` and `completed_stat_key`).

## Migration

20. `1789000000200_books.sql` is one transaction: the widened CHECKs, `book_details`, the edition columns and tables, the release-date key, the id providers, `sortName`, `sortCreator` and their triggers. It backfills nothing: no book exists before it, and the `author` credit role was already allowed (`1789000000100`). Numbers `1789000000210` to `289` are reserved by track (`plans/phase1-contracts.md` section 3).

## Reads

21. Progress of a book (rule 15) is read from `playback_states`: `progressPercent` is 100 once watched, else the percentage of the most recently played unfinished item.
22. A work is readable through `media."libraryId"` alone, as any media. An edition is visible when `COALESCE(editions."libraryId", media."libraryId")` is readable: a hidden edition is dropped from every read of the work (`books-api.md` A5), never the work itself.
23. Narrators and the per-edition view: a `narrator` credit belongs to an edition (`editionId` set); a narrator credit with a NULL `editionId` is not read. `author` and `translator` credits belong to the work (NULL `editionId`).

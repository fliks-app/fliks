# Spec: book routes and wire shapes

Scope: the HTTP surface the clients read for books: the `book` object on media payloads, the list filters and sorts, the editions and chapters routes, collections as series, persons as authors and narrators. The data model is `books.md`; the metadata routes (search, preview, sources, import) are `book-metadata.md`. After the contract PR this file belongs to the data and API track (rules A1-A9); the shapes below are frozen and mirrored in the client's `books.models.ts`.

Keys absent for other kinds: a movie or series payload carries no `book` key, so video parity does not move. **Decision:** book objects exist only on book payloads, not as generic `authors` or `series` keys on every media.

## Routes

| Route | Shape | Filled by |
|---|---|---|
| `GET /api/media?type=book&view=grid` | `MediaListItem` with `book: BookListInfo` | track A |
| `GET /api/media/:id` | `MediaDetail` with `book: BookDetail` | track A |
| `GET /api/media/:id/editions/:editionId/chapters` | `BookChapter[]` | track A |
| `GET /api/collections?libraryId=&kind=book&q=&page=&limit=` | `CollectionSummary` page | track A |
| `GET /api/collections/:id` | `CollectionDetail` | track A |
| `GET /api/persons?role=author\|narrator&libraryId=&q=&sortBy=name\|works&page=&limit=` | `PersonListItem` page | track A |
| `GET /api/persons/:id/works?role=author\|narrator` | `PersonWorks` | track A |
| `GET /api/persons/:id/provider-credits` for a person with an `openlibrary` or `asin` id | `BookSearchResult[]` | track D |
| `GET /api/metadata/search/book`, `GET /api/metadata/:provider/book/:externalId`, `POST /api/media/import` with `type: 'book'`, `GET/PUT/DELETE /api/media/:id/sources` | `book-metadata.md` | track D |

Counts: `GET /api/media/counts` and `GET /api/counts` carry `books` (`MediaKind::count_key`); user payloads carry `bookQuotaLimit`; social stats carry `booksFinished`; cleanup rules accept the `book` level (`books.md` rule 19).

## Shapes

```ts
export interface PersonRef { id: number; name: string; sortName: string | null }
export interface SeriesRef { id: number; name: string; position: number | null; positionLabel: string | null }
export type BookFormatFamily = 'text' | 'audio';

// every MLI of a book carries `book`
// New query keys (400 with another type): format=text|audio, language, authorId, narratorId,
// seriesId (collection id), inProgress=true; sortBy adds author (sortCreator), series (name, position), published.
export interface BookListInfo {
  authors: PersonRef[];            // role author, work level, position order, at most 3
  series: SeriesRef | null;        // lowest collection id among the work's series entries
  formats: BookFormatFamily[];     // editions that have a part, ['text','audio'] order
  lastFamily: BookFormatFamily | null; // family of the most recently played item
}

// the MD of a book carries `book`
export interface BookDetail {
  subtitle: string | null;
  originalLanguage: string | null;
  subjects: string[];
  authors: PersonRef[];
  translators: PersonRef[];
  series: (SeriesRef & { previous: BookSibling | null; next: BookSibling | null })[];
  editions: BookEdition[];
  progress: { editionId: number; itemId: number; progression: number; lastPlayedAt: string } | null;
}
export interface BookSibling { id: number; title: string; position: number | null }
export interface BookEdition {
  id: number; itemId: number | null; family: BookFormatFamily; format: string | null;
  language: string | null; title: string | null; publisher: string | null; published: string | null;
  coverUrl: string | null; durationSeconds: number | null; pageCount: number | null;
  libraryId: number | null; label: string | null; narrators: PersonRef[];
  hasFile: boolean; fileIds: number[];
  externalIds: { provider: 'isbn' | 'asin' | 'openlibrary' | 'googlebooks' | 'bnf'; value: string }[];
  fieldSources: { field: string; provider: string | null; locked: boolean }[];
}

// the version timeline: the sum of part durations
export interface BookChapter { title: string | null; startSeconds: number; endSeconds: number; source: 'file' | 'audnexus' }

export interface CollectionSummary { id: number; name: string; count: number; maxPosition: number | null; posters: string[] }
export interface CollectionDetail {
  id: number; name: string; externalIds: { provider: string; value: string }[];
  entries: { position: number | null; positionEnd: number | null; positionLabel: string | null;
             media: { id: number; type: MediaType; title: string; year: number | null; posterUrl: string | null;
                      watched: boolean; progressPercent: number; book?: BookListInfo } }[];
  missingPositions: number[];      // books.md rule 16
  nextUp: number | null;           // media id of the first entry by position that is not watched
}

export interface PersonListItem { id: number; name: string; sortName: string | null; avatarUrl: string | null; workCount: number }
export interface PersonWorks {
  series: { collection: { id: number; name: string }; works: (CollectionDetail['entries'][number])[] }[];
  standalone: CollectionDetail['entries'][number]['media'][];
}
```

`BookSearchResult`, `BookPreview` and `BookSources` are in `book-metadata.md`.

## Rules

Every route below needs `media.read` (`Authed`, 401 first, then 403) and answers 404 for a media or edition the caller cannot read. An edition is *visible* when `COALESCE(editions."libraryId", media."libraryId")` is a library the caller can read (`libraries.md` rules 30-36): the work's own library gates the work, the edition's gates the edition (`books.md` rule 22). A query key unknown to a route is a 400 `property <key> should not exist`, and an integer key that is not an integer is a 400 `<key> must be an integer number` (`media-query.md` rules 4-9).

**A1. List filters** (`GET /api/media`). `format`, `language`, `authorId`, `narratorId`, `seriesId` and `inProgress` are accepted only with `type=book`: with another type or none, each one present is a 400 `<key> is only valid with type=book`. They AND with every other filter and with the library scope.
- `format=text|audio` (400 `format must be one of the following values: text, audio`): the work has a visible edition of that family with a part.
- `language=<code>`: the work has a visible edition whose `language` equals it, compared lowercased.
- `authorId=<person id>`: the person has an `author` credit of the work with a NULL `editionId`.
- `narratorId=<person id>`: the person has a `narrator` credit on a visible edition of the work (`books.md` rule 23).
- `seriesId=<collection id>`: the work has an entry of that collection with a NULL `itemId`.
- `inProgress=true`: the work is not watched (`books.md` rule 15) and the caller has an unfinished playback state (`positionSeconds` above 0) on the item of a visible edition. `inProgress=false` is accepted and filters nothing.

**A2. List sorts.** `sortBy` also takes `author` (`media."sortCreator"`, works with no author last), `series` (the work's first series name, then its position, works with no series last) and `published` (the work-level `release` date, else `media.year` as 1 January, works with neither last). The direction follows `sortOrder`; ties break on `title ASC, id ASC`. These sorts are accepted for any type: a kind without the data sorts as if every key were NULL.

**A3. `book` on a list item.** Every `MediaListItem` of a book (`GET /api/media`, `recently-added`, collection entries, person works) carries `book: BookListInfo`; other kinds carry no `book` key. `authors` are the work-level `author` credits by `position, id`, at most 3; `series` is the entry of the lowest collection id among the work's entries with a NULL `itemId`; `formats` lists, in `text`, `audio` order, the families of the visible editions that have a part; `lastFamily` is the family of the visible edition holding the caller's most recently played item (`lastPlayedAt DESC`), `null` when none was played.

**A4. `book` on the detail.** `GET /api/media/:id` of a book carries `book: BookDetail`. `subtitle`, `originalLanguage` and `subjects` come from `book_details` (`null`, `null`, `[]` when the row is absent); `authors` and `translators` are the work-level credits of that role by `position, id`; `series` has one item per work-level collection entry by collection id, with `previous` and `next` the readable books of the same collection with the greatest position below and the least above (equal positions excluded), both `null` when the entry has no position; `editions` are the visible editions, `text` before `audio`, then by id.
- An edition: `itemId` is its ungrouped item (lowest id), `libraryId` the raw column (`null` means the work's), `published` the `release` date of the edition (`YYYY-MM-DD`), `label` the `editions.label` column, `narrators` its `narrator` credits by `position, id`, `hasFile` whether an item of it has a part, `fileIds` the files of its parts ordered by `version`, `position`, id, `externalIds` ordered by `provider, value` and `fieldSources` by `field`.
- `progress` is the caller's most recently played state (`lastPlayedAt DESC`) among the items of the visible editions: `progression` is 1 when completed, else `positionSeconds / durationSeconds` capped at 1 (0 when the duration is missing or 0), `lastPlayedAt` in the `%Y-%m-%dT%H:%M:%S%.3fZ` form; `null` with no state.

**A5. Edition ACL.** A hidden edition appears nowhere: not in `editions`, `formats`, `lastFamily`, `progress`, the filters of A1, the persons lists, the `files` and `fileCount` of the work's payloads (media list, detail, recently added), nor on the chapters route (404 `Edition #<id> not found`, also for an edition of another media). A work whose own library the caller cannot read is a 404 whatever its editions' libraries are.

**A6. Chapters** (`GET /api/media/:id/editions/:editionId/chapters`). The timeline is the edition's ungrouped item in its highest `version` (`items.md` rule 35), parts in `position` order; a part starts where the previous parts' `streamInfo.durationSeconds` sum ends (a missing duration counts 0). When that version has `chapter` markers, the answer is each one shifted by its part's start, `source: 'file'`, ordered by the shifted start. Otherwise, when the edition has an `asin` id (lowest value) and a snapshot `('audnexus', 'chapters', 'book', <asin>, '')` exists, the answer is its `chapters` (`startMs / 1000`, `(startMs + lengthMs) / 1000`), `source: 'audnexus'`, in snapshot order. Otherwise `[]`. The route reads the snapshot, never calls a provider and writes nothing (`items.md` rule 26).

**A7. Collections list** (`GET /api/collections`). Query `libraryId` (narrows like `media-query.md` rule 38, an unreadable one answers `[]`), `kind` (a media kind), `q` (the name contains it, case-insensitive, `%`, `_` and `\` literal), `page` and `limit` (no `limit`, or 0, answers every row; a `page` below 1 is the paging 400 of `media-query.md`). A collection counts through its work-level entries (NULL `itemId`) whose media is readable and of `kind` when given, and is listed only with at least one. Rows are ordered `name ASC, id ASC`: `count` is its entries, `maxPosition` the largest `COALESCE(positionEnd, position)` or `null`, `posters` the first 4 poster paths by `position` (NULLs last), media id.

**A8. Collection detail** (`GET /api/collections/:id`, generic: also TMDB collections). 404 `Collection #<id> not found` when it does not exist or has no readable entry. `externalIds` by provider; `entries` are the readable work-level entries by `position` (NULLs last), release date (NULLs last), `year`, media id, each with the media summary (`type`, `watched` and `progressPercent` of the caller by `books.md` rule 15, and `book` for a book); `missingPositions` follow `books.md` rule 16; `nextUp` is the media id of the first entry in that order that is not watched, `null` when all are.

**A9. Persons.** `GET /api/persons?role=author|narrator` (`role` required: 400 `role must be one of the following values: author, narrator`; `libraryId`, `page`, `limit` like A7; `q` the prefix words of `persons.md` rule 5, a `q` with no usable word answers `[]`; `sortBy=name|works`, default `name`). A person is listed with at least one readable book credited in that role (`author`: a work-level credit; `narrator`: a credit on a visible edition); `workCount` counts those books; `name` sorts on `COALESCE(sortName, name)`, `works` on `workCount DESC` then that, then id. `GET /api/persons/:id/works?role=` (404 `Person #<id> not found`) answers the readable books of the person in that role: `series` has one group per collection the books sit in (by name, id), its `works` the person's entries of it by `position` (NULLs last), media id, and `standalone` the books in no collection by `title, id`; a book in two collections is in both groups and not in `standalone`.

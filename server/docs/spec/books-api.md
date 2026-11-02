# Spec: book routes and wire shapes

Scope: the HTTP surface the clients read for books: the `book` object on media payloads, the list filters and sorts, the editions and chapters routes, collections as series, persons as authors and narrators. The data model is `books.md`; the metadata routes (search, preview, sources, import) are `book-metadata.md`. After the contract PR this file belongs to the data and API track, which fills rules A1-A9 and the routes marked *track A*; the shapes below are frozen and mirrored in the client's `books.models.ts`.

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

A1-A9 are reserved for the data and API track: list filters and sorts, the `book` objects, the collections routes (generic, also TMDB collections), the persons list and works, the chapters route (Audnexus chapters from the snapshot when the version has no probe chapters; nothing writes them into `item_markers`, `items.md` rule 26).

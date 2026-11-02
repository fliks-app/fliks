import type { MediaType } from '../../enums/media-type.enum';

// Shared
export interface PersonRef { id: number; name: string; sortName: string | null }
export interface SeriesRef { id: number; name: string; position: number | null; positionLabel: string | null }
export type BookFormatFamily = 'text' | 'audio';

// GET /api/media?type=book&view=grid&... : every MLI of a book carries `book` (key absent for other kinds)
// New query keys (400 when used with another type): format=text|audio, language, authorId, narratorId,
// seriesId (collection id), inProgress=true; sortBy adds author (sortCreator), series (name, position), published.
export interface BookListInfo {
  authors: PersonRef[];            // role author, work level, position order, at most 3
  series: SeriesRef | null;        // lowest collection id among the work's series entries
  formats: BookFormatFamily[];     // editions that have a part, ['text','audio'] order
  lastFamily: BookFormatFamily | null; // family of the most recently played item
}

// GET /api/media/:id : the MD of a book carries `book`
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
  externalIds: { provider: string; value: string }[];
  fieldSources: { field: string; provider: string | null; locked: boolean }[];
}

// GET /api/media/:id/editions/:editionId/chapters : the version timeline (sum of part durations)
export interface BookChapter { title: string | null; startSeconds: number; endSeconds: number; source: 'file' | 'audnexus' }

// GET /api/collections?libraryId=&kind=book&q=&page=&limit=
export interface CollectionSummary { id: number; name: string; count: number; maxPosition: number | null; posters: string[] }
// GET /api/collections/:id  (generic: also TMDB collections)
export interface CollectionDetail {
  id: number; name: string; externalIds: { provider: string; value: string }[];
  entries: { position: number | null; positionEnd: number | null; positionLabel: string | null;
             media: { id: number; type: MediaType; title: string; year: number | null; posterUrl: string | null;
                      watched: boolean; progressPercent: number; book?: BookListInfo } }[];
  missingPositions: number[];      // integers 1..max(position) not covered by an entry
  nextUp: number | null;           // media id of the first entry by position that is not watched
}

// GET /api/persons?role=author|narrator&libraryId=&q=&sortBy=name|works&page=&limit=
export interface PersonListItem { id: number; name: string; sortName: string | null; avatarUrl: string | null; workCount: number }
// GET /api/persons/:id/works?role=author|narrator  (owned works, ACL-scoped)
export interface PersonWorks {
  series: { collection: { id: number; name: string }; works: (CollectionDetail['entries'][number])[] }[];
  standalone: CollectionDetail['entries'][number]['media'][];
}
// GET /api/persons/:id/provider-credits for a person with an openlibrary/asin id answers BookSearchResult[]

// GET /api/metadata/search/book?q=&title=&author=&isbn=&language=&page=
export interface BookSearchResult {
  provider: string; externalId: string; kind: 'book';
  title: string; subtitle: string | null; authors: string[]; year: number | null; coverUrl: string | null;
  series: { name: string; position: string | null } | null; editionCount: number | null;
  mediaId: number | null;          // already in a library the caller can read
}
// GET /api/metadata/{provider}/book/{externalId} : the add preview
export interface BookPreview extends BookSearchResult {
  description: string | null; subjects: string[]; published: string | null; language: string | null;
  editions: { provider: string; externalId: string; family: BookFormatFamily; format: string | null;
              language: string | null; title: string | null; publisher: string | null; published: string | null;
              isbn13: string[]; asin: string | null; coverUrl: string | null; narrators: string[];
              durationSeconds: number | null; pageCount: number | null }[];
  unofficial: boolean;             // true when a field comes from Audible or Audnexus (UI mention)
}
// POST /api/media/import  body adds: { type: 'book', provider, externalId, libraryId?, folderId? }
//   201 = the MD of the created book. Requests for books are phase 3.4: the preview offers Add only.
export interface BookImportBody {
  type: 'book'; provider: string; externalId: string; libraryId?: number; folderId?: number;
}

// GET/PUT/DELETE /api/media/:id/sources  (Sources panel)
export interface BookSources {
  work: { provider: string; value: string } | null;
  editions: { editionId: number; ids: BookEdition['externalIds'] }[];
}
// PUT  /api/media/:id/sources -> BookSources (relinks and refreshes)
export interface BookSourcePut {
  level: 'work' | 'edition'; editionId?: number; provider: string; value: string;
}
// DELETE /api/media/:id/sources?level=&editionId=&provider=&value= -> BookSources
export type BookSourceDelete = BookSourcePut;

// Settings (GET/PUT /api/settings): metadata_contact_email (plain), google_books_api_key (secret, secretsSet)

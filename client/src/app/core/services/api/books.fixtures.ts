import type {
  BookChapter, BookDetail, BookEdition, BookListInfo, BookPreview, BookSearchResult, BookSources,
  CollectionDetail, CollectionSummary, PersonListItem, PersonRef, PersonWorks, SeriesRef,
} from './books.models';

export const personRefFixture: PersonRef = { id: 1, name: 'Author One', sortName: 'One, Author' };
export const narratorRefFixture: PersonRef = { id: 2, name: 'Narrator One', sortName: 'One, Narrator' };
export const seriesRefFixture: SeriesRef = { id: 10, name: 'Series One', position: 1, positionLabel: '1' };

export const bookListInfoFixture: BookListInfo = {
  authors: [personRefFixture],
  series: seriesRefFixture,
  formats: ['text', 'audio'],
  lastFamily: 'audio',
};

export const textEditionFixture: BookEdition = {
  id: 100, itemId: 1000, family: 'text', format: 'epub', language: 'en', title: 'Book One',
  publisher: 'Publisher One', published: '2020-01-01', coverUrl: null, durationSeconds: null,
  pageCount: 320, libraryId: 1, label: null, narrators: [], hasFile: true, fileIds: [5000],
  externalIds: [{ provider: 'isbn', value: '9780000000002' }],
  fieldSources: [{ field: 'title', provider: 'openlibrary', locked: false }],
};

export const audioEditionFixture: BookEdition = {
  ...textEditionFixture, id: 101, itemId: 1001, family: 'audio', format: 'm4b', pageCount: null,
  durationSeconds: 36000, narrators: [narratorRefFixture], fileIds: [5001],
  externalIds: [{ provider: 'asin', value: 'B000000001' }], fieldSources: [],
};

export const bookDetailFixture: BookDetail = {
  subtitle: null,
  originalLanguage: 'en',
  subjects: ['Fiction'],
  authors: [personRefFixture],
  translators: [],
  series: [{ ...seriesRefFixture, previous: null, next: { id: 2, title: 'Book Two', position: 2 } }],
  editions: [textEditionFixture, audioEditionFixture],
  progress: { editionId: 101, itemId: 1001, progression: 0.25, lastPlayedAt: '2026-01-01T00:00:00Z' },
};

export const bookChaptersFixture: BookChapter[] = [
  { title: 'Chapter 1', startSeconds: 0, endSeconds: 1800, source: 'file' },
  { title: 'Chapter 2', startSeconds: 1800, endSeconds: 3600, source: 'file' },
];

export const collectionSummaryFixture: CollectionSummary = {
  id: 10, name: 'Series One', count: 2, maxPosition: 3, posters: [],
};

export const collectionDetailFixture: CollectionDetail = {
  id: 10, name: 'Series One', externalIds: [],
  entries: [
    { position: 1, positionEnd: null, positionLabel: '1',
      media: { id: 1, type: 'book', title: 'Book One', year: 2020, posterUrl: null, watched: true,
               progressPercent: 100, book: bookListInfoFixture } },
    { position: 3, positionEnd: null, positionLabel: '3',
      media: { id: 3, type: 'book', title: 'Book Three', year: 2022, posterUrl: null, watched: false,
               progressPercent: 0, book: { ...bookListInfoFixture, lastFamily: null } } },
  ],
  missingPositions: [2],
  nextUp: 3,
};

export const personListItemFixture: PersonListItem = {
  id: 1, name: 'Author One', sortName: 'One, Author', avatarUrl: null, workCount: 2,
};

export const personWorksFixture: PersonWorks = {
  series: [{ collection: { id: 10, name: 'Series One' }, works: [collectionDetailFixture.entries[0]] }],
  standalone: [{ id: 4, type: 'book', title: 'Book Four', year: 2023, posterUrl: null, watched: false,
                 progressPercent: 0, book: { ...bookListInfoFixture, series: null } }],
};

export const bookSearchResultFixture: BookSearchResult = {
  provider: 'openlibrary', externalId: 'OL1W', kind: 'book', title: 'Book One', subtitle: null,
  authors: ['Author One'], year: 2020, coverUrl: null, series: { name: 'Series One', position: '1' },
  editionCount: 2, mediaId: null,
};

export const bookPreviewFixture: BookPreview = {
  ...bookSearchResultFixture,
  description: 'A placeholder description.', subjects: ['Fiction'], published: '2020-01-01', language: 'en',
  editions: [{
    provider: 'openlibrary', externalId: 'OL1M', family: 'text', format: 'epub', language: 'en',
    title: 'Book One', publisher: 'Publisher One', published: '2020-01-01', isbn13: ['9780000000002'],
    asin: null, coverUrl: null, narrators: [], durationSeconds: null, pageCount: 320,
  }],
  unofficial: false,
};

export const bookSourcesFixture: BookSources = {
  work: { provider: 'openlibrary', value: 'OL1W' },
  editions: [{ editionId: 100, ids: textEditionFixture.externalIds }],
};

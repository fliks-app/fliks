import {
  DEFAULT_LIST_KIND,
  KIND_REGISTRY,
  MEDIA_KINDS,
  canMarkWatched,
  isMediaKind,
  kindFromProviderSegment,
  kindFromSegment,
  kindOfListFilter,
  mediaDetailLink,
} from './media-kinds';

describe('media kind registry', () => {
  it('describes every kind', () => {
    expect(MEDIA_KINDS).toEqual(['movie', 'series', 'book', 'comic', 'album']);
    expect(KIND_REGISTRY.album).toMatchObject({ segment: 'albums', providerSegment: 'album', families: ['audio'] });
    expect(KIND_REGISTRY.comic).toMatchObject({ segment: 'comics', providerSegment: 'comic', hasSeasons: false });
    expect(KIND_REGISTRY.book).toMatchObject({ segment: 'books', providerSegment: 'book', hasSeasons: false });
    expect(KIND_REGISTRY.movie).toMatchObject({ segment: 'movies', providerSegment: 'movie', hasSeasons: false });
    expect(KIND_REGISTRY.series).toMatchObject({ segment: 'series', providerSegment: 'tv', hasSeasons: true });
  });

  it('builds detail links', () => {
    expect(mediaDetailLink('movie', 7)).toEqual(['/movies', '7']);
    expect(mediaDetailLink('series', '9')).toEqual(['/series', '9']);
  });

  it('resolves segments and guards kinds', () => {
    expect(kindFromSegment('movies')).toBe('movie');
    expect(kindFromSegment('series')).toBe('series');
    expect(kindFromSegment('nope')).toBeUndefined();
    expect(isMediaKind('movie')).toBe(true);
    expect(isMediaKind('toString')).toBe(false);
  });

  it('narrows wire strings', () => {
    expect(kindFromProviderSegment('tv')).toBe('series');
    expect(kindFromProviderSegment('series')).toBeUndefined();
  });

  it('maps a list filter to a kind, "all" onto the default', () => {
    expect(kindOfListFilter('all')).toBe(DEFAULT_LIST_KIND);
    expect(kindOfListFilter('series')).toBe('series');
    expect(kindOfListFilter('movie')).toBe('movie');
  });
});

describe('canMarkWatched', () => {
  it('is video only: a series, or a movie with a file', () => {
    expect(canMarkWatched({ type: 'series' })).toBe(true);
    expect(canMarkWatched({ type: 'movie', files: [{}] })).toBe(true);
    expect(canMarkWatched({ type: 'movie', files: [] })).toBe(false);
    for (const type of ['book', 'comic', 'album'] as const) expect(canMarkWatched({ type, files: [{}] })).toBe(false);
  });
});

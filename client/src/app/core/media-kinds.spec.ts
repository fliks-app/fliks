import {
  DEFAULT_LIST_KIND,
  KIND_REGISTRY,
  MEDIA_KINDS,
  canMarkWatched,
  isMediaKind,
  videoKindOf,
  kindOf,
  kindFromSegment,
  kindOfListFilter,
  mediaDetailLink,
  playsInAudioPlayer,
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

  it('plays an album and a book in the audio player, a video kind or an unknown one elsewhere', () => {
    expect(['album', 'book', 'movie', 'series', 'comic', 'podcast', null].map(playsInAudioPlayer)).toEqual([true, true, false, false, false, false, false]);
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

describe('a kind the client predates', () => {
  const unknown = 'podcast' as never;
  it('has no watched toggle and falls back on the movie descriptor', () => {
    expect(canMarkWatched({ type: unknown, files: [{}] })).toBe(false);
    expect(kindOf(unknown)).toBe(KIND_REGISTRY.movie);
    expect(kindOf(undefined)).toBe(KIND_REGISTRY.movie);
    expect(mediaDetailLink(unknown, 3)).toEqual(['/movies', '3']);
  });
});

describe('videoKindOf', () => {
  it('is the episodic video kind for an episode and the single-file one otherwise', () => {
    expect(videoKindOf(true)).toBe('series');
    expect(videoKindOf(false)).toBe('movie');
  });
});

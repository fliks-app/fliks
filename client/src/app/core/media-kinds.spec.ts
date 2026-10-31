import {
  DEFAULT_LIST_KIND,
  KIND_REGISTRY,
  MEDIA_KINDS,
  asKind,
  isMediaKind,
  kindFromProviderSegment,
  kindFromSegment,
  kindOfListFilter,
  mediaDetailLink,
} from './media-kinds';

describe('media kind registry', () => {
  it('describes every kind', () => {
    expect(MEDIA_KINDS).toEqual(['movie', 'series']);
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
    expect(asKind('series')).toBe('series');
    expect(asKind('')).toBeUndefined();
    expect(asKind(null)).toBeUndefined();
    expect(kindFromProviderSegment('tv')).toBe('series');
    expect(kindFromProviderSegment('series')).toBeUndefined();
  });

  it('maps a list filter to a kind, "all" onto the default', () => {
    expect(kindOfListFilter('all')).toBe(DEFAULT_LIST_KIND);
    expect(kindOfListFilter('series')).toBe('series');
    expect(kindOfListFilter('movie')).toBe('movie');
  });
});

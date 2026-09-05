import {
  buildMediaProgressSubject,
  formatMediaProgressSubject,
} from './media-progress-subject.util';

describe('buildMediaProgressSubject', () => {
  it('returns just the title with no episode arg', () => {
    expect(buildMediaProgressSubject({ title: 'Movie' })).toEqual({
      title: 'Movie',
    });
  });

  it('returns just the title when the episode has no season', () => {
    expect(
      buildMediaProgressSubject(
        { title: 'Movie' },
        { seasonNumber: null, episodeNumber: 3, title: 'Ep' },
      ),
    ).toEqual({ title: 'Movie' });
  });

  it('carries the season alone for a whole-season task', () => {
    expect(
      buildMediaProgressSubject(
        { title: 'Show' },
        { seasonNumber: 1, episodeNumber: null, title: null },
      ),
    ).toEqual({ title: 'Show', seasonNumber: 1, episodeNumber: undefined, episodeTitle: undefined });
  });

  it('carries season + episode + episode title', () => {
    expect(
      buildMediaProgressSubject(
        { title: 'Show' },
        { seasonNumber: 1, episodeNumber: 3, title: 'Pilot' },
      ),
    ).toEqual({
      title: 'Show',
      seasonNumber: 1,
      episodeNumber: 3,
      episodeTitle: 'Pilot',
    });
  });

  it('omits a null episode title rather than sending null', () => {
    expect(
      buildMediaProgressSubject(
        { title: 'Show' },
        { seasonNumber: 1, episodeNumber: 3, title: null },
      ),
    ).toEqual({
      title: 'Show',
      seasonNumber: 1,
      episodeNumber: 3,
      episodeTitle: undefined,
    });
  });
});

describe('formatMediaProgressSubject', () => {
  it('formats a title-only subject', () => {
    expect(formatMediaProgressSubject({ title: 'Movie' })).toBe('Movie');
  });

  it('formats a season-only subject', () => {
    expect(formatMediaProgressSubject({ title: 'Show', seasonNumber: 1 })).toBe(
      'Show S01',
    );
  });

  it('formats season + episode with no episode title', () => {
    expect(
      formatMediaProgressSubject({ title: 'Show', seasonNumber: 1, episodeNumber: 3 }),
    ).toBe('Show S01E03');
  });

  it('formats season + episode + episode title', () => {
    expect(
      formatMediaProgressSubject({
        title: 'Show',
        seasonNumber: 1,
        episodeNumber: 3,
        episodeTitle: 'Pilot',
      }),
    ).toBe('Show S01E03: Pilot');
  });
});

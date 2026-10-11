import {
  parseSeasonEpisode,
  releaseCoverage,
  within,
} from './season-episode.parser';

describe('parseSeasonEpisode', () => {
  it('parses SxxExx', () => {
    expect(parseSeasonEpisode('Show.Name.S01E02.1080p.WEB-DL')).toEqual({
      season: 1,
      episode: 2,
      isFullSeason: false,
      seasonEnd: null,
      episodeEnd: null,
      isCompleteSeries: false,
    });
  });

  it('parses lowercase sxxexx', () => {
    expect(parseSeasonEpisode('show.name.s10e11.HDTV')).toEqual({
      season: 10,
      episode: 11,
      isFullSeason: false,
      seasonEnd: null,
      episodeEnd: null,
      isCompleteSeries: false,
    });
  });

  it('parses season-only Sxx as a pack', () => {
    expect(parseSeasonEpisode('Show.Name.S01.1080p.WEB-DL.PACK')).toEqual({
      season: 1,
      episode: null,
      isFullSeason: true,
      seasonEnd: null,
      episodeEnd: null,
      isCompleteSeries: false,
    });
  });

  it('parses Season xx keyword as a pack', () => {
    expect(parseSeasonEpisode('Show Name Season 03 Complete')).toEqual({
      season: 3,
      episode: null,
      isFullSeason: true,
      seasonEnd: null,
      episodeEnd: null,
      isCompleteSeries: false,
    });
  });

  it('parses 1x02 form', () => {
    expect(parseSeasonEpisode('Show.Name.1x02.DVDRip')).toEqual({
      season: 1,
      episode: 2,
      isFullSeason: false,
      seasonEnd: null,
      episodeEnd: null,
      isCompleteSeries: false,
    });
  });

  it('returns nulls for movie-style titles', () => {
    expect(parseSeasonEpisode('Inception.2010.1080p.BluRay.x264')).toEqual({
      season: null,
      episode: null,
      isFullSeason: false,
      seasonEnd: null,
      episodeEnd: null,
      isCompleteSeries: false,
    });
  });

  it('does not confuse SxxExx with season-only Sxx', () => {
    const r = parseSeasonEpisode('Show.S02E05.1080p');
    expect(r.isFullSeason).toBe(false);
    expect(r.season).toBe(2);
    expect(r.episode).toBe(5);
  });

  it('parses season-only Sxx before x265 codec tags', () => {
    expect(
      parseSeasonEpisode('Show.Name.Spinoff.S01.1080p.x265-GROUP'),
    ).toEqual({
      season: 1,
      episode: null,
      isFullSeason: true,
      seasonEnd: null,
      episodeEnd: null,
      isCompleteSeries: false,
    });
  });

  it('does not treat x265 codec as a season×episode tag', () => {
    expect(parseSeasonEpisode('Show.Name.S09.1080p.x265-GROUP')).toEqual({
      season: 9,
      episode: null,
      isFullSeason: true,
      seasonEnd: null,
      episodeEnd: null,
      isCompleteSeries: false,
    });
  });
});

describe('releaseCoverage', () => {
  const season = (from: number, to = from) => ({ from, to });
  const cases: [string, ReturnType<typeof releaseCoverage>][] = [
    [
      'Show.S01E05.1080p',
      { seasons: season(1), episodes: season(5), completeSeries: false },
    ],
    [
      'Show.S01E04E05.1080p',
      { seasons: season(1), episodes: season(4, 5), completeSeries: false },
    ],
    [
      'Show.S01E04-E05.1080p',
      { seasons: season(1), episodes: season(4, 5), completeSeries: false },
    ],
    [
      'Show.S01E04-05.1080p',
      { seasons: season(1), episodes: season(4, 5), completeSeries: false },
    ],
    [
      'Show.S01E01E02E03.1080p',
      { seasons: season(1), episodes: season(1, 3), completeSeries: false },
    ],
    [
      'Show.1x04-05.DVDRip',
      { seasons: season(1), episodes: season(4, 5), completeSeries: false },
    ],
    [
      'Show.S02.1080p',
      { seasons: season(2), episodes: null, completeSeries: false },
    ],
    [
      'Show.S01-S04.1080p',
      { seasons: season(1, 4), episodes: null, completeSeries: false },
    ],
    [
      'Show.S01-04.1080p',
      { seasons: season(1, 4), episodes: null, completeSeries: false },
    ],
    [
      'Show S01 to S04 1080p',
      { seasons: season(1, 4), episodes: null, completeSeries: false },
    ],
    [
      'Show Season 1-4 1080p',
      { seasons: season(1, 4), episodes: null, completeSeries: false },
    ],
    [
      'Show Seasons 1 to 4 1080p',
      { seasons: season(1, 4), episodes: null, completeSeries: false },
    ],
    [
      'Show.Complete.Series.1080p',
      { seasons: null, episodes: null, completeSeries: true },
    ],
    [
      'The.Complete.Series.1080p',
      { seasons: null, episodes: null, completeSeries: true },
    ],
    [
      'Show.Intégrale.1080p',
      { seasons: null, episodes: null, completeSeries: true },
    ],
    [
      'Show.INTEGRALE.FRENCH',
      { seasons: null, episodes: null, completeSeries: true },
    ],
    [
      'Show Saison 1 à 4',
      { seasons: season(1, 4), episodes: null, completeSeries: false },
    ],
    [
      'Show.Saisons.1-4.MULTI',
      { seasons: season(1, 4), episodes: null, completeSeries: false },
    ],
    [
      'Show.Saison.1.a.4',
      { seasons: season(1, 4), episodes: null, completeSeries: false },
    ],
    [
      'Show.Integrale.Saisons.1.a.4',
      { seasons: season(1, 4), episodes: null, completeSeries: false },
    ],
    [
      '[SubsPlease] Show S2 - 04 (1080p)',
      { seasons: season(2), episodes: season(4), completeSeries: false },
    ],
    [
      '[Grp] Show S01 - 12 [1080p]',
      { seasons: season(1), episodes: season(12), completeSeries: false },
    ],
    [
      'Show Season 2 - 05 [1080p]',
      { seasons: season(2), episodes: season(5), completeSeries: false },
    ],
    [
      'Show.S01.S02.S03.1080p',
      { seasons: season(1, 3), episodes: null, completeSeries: false },
    ],
  ];
  it.each(cases)('%s', (title, expected) => {
    expect(releaseCoverage(title)).toEqual(expected);
  });

  const none = { seasons: null, episodes: null, completeSeries: false };
  it.each([
    'Show.2019-2020.1080p.WEB-DL.x265',
    'Show.1080p.DDP5.1.10bit.x265-GRP',
    'Movie.2019.2160p.BluRay.5.1',
    'Show.Complete.Edition.2010',
    'Show.Complete.Collection',
    'Show.1080p.Complete.Pack',
    'Show.COMPLETE.720p',
    'Show.E01-E12.1080p',
    'Show.S05x265.1080p',
    'Show.1920x1080.WEB',
  ])('reads nothing into %s', (title) => {
    expect(releaseCoverage(title)).toEqual(none);
  });

  it.each([
    ['Show.S01-1080p.WEB', season(1)],
    ['Show.S01.2019-2020.1080p', season(1)],
    ['Show.S01-10bit.x265', season(1)],
    ['Show.S01.COMPLETE.1080p', season(1)],
    ['Show.S04-S02.1080p', season(4)],
    ['Show S01 - 5.1 AAC', season(1)],
    ['Show.S01.S03.1080p', season(1)],
    ['Show.S01,S03,S05.1080p', season(1)],
    ['Show.S01 to 04.1080p', season(1)],
  ])('keeps %s a single season', (title, seasons) => {
    expect(releaseCoverage(title)).toEqual({
      seasons,
      episodes: null,
      completeSeries: false,
    });
  });

  it('keeps a lone episode on a resolution tail', () => {
    expect(releaseCoverage('Show.S01E04-1080p.WEB')).toEqual({
      seasons: season(1),
      episodes: season(4),
      completeSeries: false,
    });
  });
});

describe('episode under-claims', () => {
  it.each([
    ['Show.S01E01-S02E05.1080p', 1, 1],
    ['Show.S01E04.E05.1080p', 1, 4],
  ])('%s covers one episode', (title, seasonNo, ep) => {
    expect(releaseCoverage(title)).toEqual({
      seasons: { from: seasonNo, to: seasonNo },
      episodes: { from: ep, to: ep },
      completeSeries: false,
    });
  });
});

describe('within', () => {
  it('is inclusive on both ends', () => {
    expect([1, 2, 4, 5].map((n) => within({ from: 2, to: 4 }, n))).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
});

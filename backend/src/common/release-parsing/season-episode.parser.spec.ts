import { matchesSeasonPack, parseSeasonEpisode } from './season-episode.parser';

describe('parseSeasonEpisode', () => {
  it('parses SxxExx', () => {
    expect(parseSeasonEpisode('Show.Name.S01E02.1080p.WEB-DL')).toEqual({
      season: 1,
      episode: 2,
      isFullSeason: false,
    });
  });

  it('parses lowercase sxxexx', () => {
    expect(parseSeasonEpisode('show.name.s10e11.HDTV')).toEqual({
      season: 10,
      episode: 11,
      isFullSeason: false,
    });
  });

  it('parses season-only Sxx as a pack', () => {
    expect(parseSeasonEpisode('Show.Name.S01.1080p.WEB-DL.PACK')).toEqual({
      season: 1,
      episode: null,
      isFullSeason: true,
    });
  });

  it('parses Season xx keyword as a pack', () => {
    expect(parseSeasonEpisode('Show Name Season 03 Complete')).toEqual({
      season: 3,
      episode: null,
      isFullSeason: true,
    });
  });

  it('parses legacy 1x02 form', () => {
    expect(parseSeasonEpisode('Show.Name.1x02.DVDRip')).toEqual({
      season: 1,
      episode: 2,
      isFullSeason: false,
    });
  });

  it('returns nulls for movie-style titles', () => {
    expect(parseSeasonEpisode('Inception.2010.1080p.BluRay.x264')).toEqual({
      season: null,
      episode: null,
      isFullSeason: false,
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
    });
  });

  it('does not treat x265 codec as a legacy season×episode tag', () => {
    expect(parseSeasonEpisode('Show.Name.S09.1080p.x265-GROUP')).toEqual({
      season: 9,
      episode: null,
      isFullSeason: true,
    });
  });
});

describe('matchesSeasonPack', () => {
  const s01Pack = 'Show.Name.Spinoff.S01.1080p.x265-GROUP';

  it('matches the parsed season', () => {
    expect(matchesSeasonPack(s01Pack, 1)).toBe(true);
  });

  it('rejects a different target season', () => {
    expect(matchesSeasonPack(s01Pack, 9)).toBe(false);
  });
});

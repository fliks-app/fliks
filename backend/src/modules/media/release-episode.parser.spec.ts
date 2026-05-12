import { parseSeasonEpisode } from './release-episode.parser';

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
});

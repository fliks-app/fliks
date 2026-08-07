import { DataSource } from 'typeorm';
import { NamingService } from './naming.service';

// Mirrors the DEFAULT_FORMATS constant at the top of naming.service.ts.
const DEFAULT_MOVIE_FORMAT = '{Movie Title} ({Release Year}) {Quality Full}';
const DEFAULT_MOVIE_FOLDER_FORMAT = '{Movie Title} ({Release Year})';
const DEFAULT_SERIES_FORMAT =
  '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}';
const DEFAULT_SERIES_FOLDER_FORMAT = '{Series Title}';
const DEFAULT_SEASON_FOLDER_FORMAT = 'Season {season:00}';

function buildService(query: jest.Mock = jest.fn()) {
  return new NamingService({ query } as unknown as DataSource);
}

describe('NamingService', () => {
  describe('getFormats', () => {
    it('reads the five naming_* keys in one query and returns stored values', async () => {
      const rows = [
        { key: 'naming_movie_format', value: '{Movie Title} [{Quality Full}]' },
        { key: 'naming_movie_folder_format', value: '{Movie Title}' },
        { key: 'naming_series_format', value: '{Series Title} E{episode:00}' },
        { key: 'naming_series_folder_format', value: '{Series Title} Show' },
        { key: 'naming_season_folder_format', value: 'S{season:00}' },
      ];
      const query = jest.fn().mockResolvedValue(rows);
      const svc = buildService(query);

      const formats = await svc.getFormats();

      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(
        `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
        [
          [
            'naming_movie_format',
            'naming_movie_folder_format',
            'naming_series_format',
            'naming_series_folder_format',
            'naming_season_folder_format',
          ],
        ],
      );
      expect(formats).toEqual({
        movie: '{Movie Title} [{Quality Full}]',
        movieFolder: '{Movie Title}',
        series: '{Series Title} E{episode:00}',
        seriesFolder: '{Series Title} Show',
        seasonFolder: 'S{season:00}',
      });
    });

    it('falls back to the documented defaults when no rows exist', async () => {
      const svc = buildService(jest.fn().mockResolvedValue([]));

      const formats = await svc.getFormats();

      expect(formats).toEqual({
        movie: DEFAULT_MOVIE_FORMAT,
        movieFolder: DEFAULT_MOVIE_FOLDER_FORMAT,
        series: DEFAULT_SERIES_FORMAT,
        seriesFolder: DEFAULT_SERIES_FOLDER_FORMAT,
        seasonFolder: DEFAULT_SEASON_FOLDER_FORMAT,
      });
    });

    it('defaults per-key when only some rows are stored', async () => {
      const rows = [{ key: 'naming_movie_format', value: '{Movie Title}' }];
      const svc = buildService(jest.fn().mockResolvedValue(rows));

      const formats = await svc.getFormats();

      expect(formats).toEqual({
        movie: '{Movie Title}',
        movieFolder: DEFAULT_MOVIE_FOLDER_FORMAT,
        series: DEFAULT_SERIES_FORMAT,
        seriesFolder: DEFAULT_SERIES_FOLDER_FORMAT,
        seasonFolder: DEFAULT_SEASON_FOLDER_FORMAT,
      });
    });
  });

  describe('applyMovieFormat', () => {
    const svc = buildService();

    it('renders the default format with all fields present', () => {
      const out = svc.applyMovieFormat(DEFAULT_MOVIE_FORMAT, {
        title: 'Nova Skyline',
        year: 2023,
        quality: '1080p',
      });
      expect(out).toBe('Nova Skyline (2023) 1080p');
    });

    it('drops the now-empty parentheses when year is null', () => {
      const out = svc.applyMovieFormat(DEFAULT_MOVIE_FORMAT, {
        title: 'Nova Skyline',
        year: null,
        quality: '1080p',
      });
      expect(out).toBe('Nova Skyline 1080p');
    });

    it('trims the trailing space when quality is empty', () => {
      const out = svc.applyMovieFormat(DEFAULT_MOVIE_FORMAT, {
        title: 'Nova Skyline',
        year: 2023,
        quality: '',
      });
      expect(out).toBe('Nova Skyline (2023)');
    });

    it('substitutes {Movie Title}', () => {
      expect(
        svc.applyMovieFormat('{Movie Title}', { title: 'Nova Skyline', quality: '' }),
      ).toBe('Nova Skyline');
    });

    it('{Movie Title} renders empty for an empty title', () => {
      expect(svc.applyMovieFormat('{Movie Title}', { title: '', quality: '' })).toBe('');
    });

    it('substitutes {Original Title} when present', () => {
      expect(
        svc.applyMovieFormat('{Original Title}', {
          title: 'Nova Skyline',
          originalTitle: 'Orig Nova',
          quality: '',
        }),
      ).toBe('Orig Nova');
    });

    it('{Original Title} falls back to the title when absent', () => {
      expect(
        svc.applyMovieFormat('{Original Title}', { title: 'Nova Skyline', quality: '' }),
      ).toBe('Nova Skyline');
    });

    it('substitutes {Release Year}', () => {
      expect(
        svc.applyMovieFormat('{Release Year}', { title: 'x', year: 2023, quality: '' }),
      ).toBe('2023');
    });

    it('{Release Year} renders empty when year is null', () => {
      expect(
        svc.applyMovieFormat('{Release Year}', { title: 'x', year: null, quality: '' }),
      ).toBe('');
    });

    it('{Release Year} renders empty for year 0 (falsy check, pinned as-is)', () => {
      expect(
        svc.applyMovieFormat('{Release Year}', { title: 'x', year: 0, quality: '' }),
      ).toBe('');
    });

    it('substitutes {Quality Full} and {Quality Title} identically', () => {
      expect(
        svc.applyMovieFormat('{Quality Full} {Quality Title}', {
          title: 'x',
          quality: '720p',
        }),
      ).toBe('720p 720p');
    });

    it('substitutes {Release Group} when present', () => {
      expect(
        svc.applyMovieFormat('{Release Group}', {
          title: 'x',
          quality: '',
          releaseGroup: 'RELGRP',
        }),
      ).toBe('RELGRP');
    });

    it('{Release Group} renders empty when absent', () => {
      expect(svc.applyMovieFormat('{Release Group}', { title: 'x', quality: '' })).toBe('');
    });

    it('substitutes {TMDB Id}', () => {
      expect(
        svc.applyMovieFormat('{TMDB Id}', { title: 'x', quality: '', tmdbId: 12345 }),
      ).toBe('12345');
    });

    it('{TMDB Id} renders empty for id 0 (falsy check, pinned as-is)', () => {
      expect(
        svc.applyMovieFormat('{TMDB Id}', { title: 'x', quality: '', tmdbId: 0 }),
      ).toBe('');
    });

    it('{MediaInfo AudioCodec} and {MediaInfo VideoCodec} always render empty', () => {
      const out = svc.applyMovieFormat(
        '{Movie Title} [{MediaInfo VideoCodec} {MediaInfo AudioCodec}]',
        { title: 'Nova Skyline', quality: '' },
      );
      expect(out).toBe('Nova Skyline');
    });

    it('an unknown token is silently stripped', () => {
      expect(
        svc.applyMovieFormat('{Movie Title} {Unknown Token}', {
          title: 'Nova Skyline',
          quality: '',
        }),
      ).toBe('Nova Skyline');
    });

    it('strips illegal path characters from the title (colon)', () => {
      expect(
        svc.applyMovieFormat('{Movie Title}', {
          title: 'Nova Skyline: Requiem',
          quality: '',
        }),
      ).toBe('Nova Skyline Requiem');
    });

    it('strips illegal path characters and collapses the resulting double space (slash)', () => {
      expect(
        svc.applyMovieFormat('{Movie Title}', { title: 'Nova / Skyline', quality: '' }),
      ).toBe('Nova Skyline');
    });

    it('leaves a trailing dot in the title untouched (pinned as-is, invalid on Windows)', () => {
      expect(
        svc.applyMovieFormat('{Movie Title}', { title: 'Nova Skyline.', quality: '' }),
      ).toBe('Nova Skyline.');
    });

    it('strips a literal "undefined" substring anywhere in the output (pinned as-is)', () => {
      expect(
        svc.applyMovieFormat('{Movie Title} undefined', {
          title: 'Nova Skyline',
          quality: '',
        }),
      ).toBe('Nova Skyline');
    });
  });

  describe('applySeriesFormat', () => {
    const svc = buildService();

    it('renders the default format with all fields present', () => {
      const out = svc.applySeriesFormat(DEFAULT_SERIES_FORMAT, {
        seriesTitle: 'Nova Skyline',
        season: 1,
        episode: 2,
        episodeTitle: 'Pilot Run',
        quality: '720p',
      });
      expect(out).toBe('Nova Skyline - S01E02 - Pilot Run 720p');
    });

    it('leaves a stray "- " separator when {Episode Title} is empty (pinned as-is)', () => {
      const out = svc.applySeriesFormat(DEFAULT_SERIES_FORMAT, {
        seriesTitle: 'Nova Skyline',
        season: 1,
        episode: 2,
        quality: '720p',
      });
      expect(out).toBe('Nova Skyline - S01E02 - 720p');
    });

    it('substitutes {Series Title}', () => {
      expect(
        svc.applySeriesFormat('{Series Title}', {
          seriesTitle: 'Nova Skyline',
          season: 1,
          episode: 1,
          quality: '',
        }),
      ).toBe('Nova Skyline');
    });

    it('pads {season:00} and {episode:00} to two digits', () => {
      expect(
        svc.applySeriesFormat('S{season:00}E{episode:00}', {
          seriesTitle: 'x',
          season: 3,
          episode: 7,
          quality: '',
        }),
      ).toBe('S03E07');
    });

    it('does not truncate a three-digit season/episode (pinned as-is)', () => {
      expect(
        svc.applySeriesFormat('S{season:00}E{episode:00}', {
          seriesTitle: 'x',
          season: 100,
          episode: 250,
          quality: '',
        }),
      ).toBe('S100E250');
    });

    it('substitutes {Episode Title}', () => {
      expect(
        svc.applySeriesFormat('{Episode Title}', {
          seriesTitle: 'x',
          season: 1,
          episode: 1,
          episodeTitle: 'Pilot Run',
          quality: '',
        }),
      ).toBe('Pilot Run');
    });

    it('substitutes {Quality Full} and {Quality Title} identically', () => {
      expect(
        svc.applySeriesFormat('{Quality Full} {Quality Title}', {
          seriesTitle: 'x',
          season: 1,
          episode: 1,
          quality: 'HDTV',
        }),
      ).toBe('HDTV HDTV');
    });

    it('substitutes {Release Group} when present', () => {
      expect(
        svc.applySeriesFormat('{Release Group}', {
          seriesTitle: 'x',
          season: 1,
          episode: 1,
          quality: '',
          releaseGroup: 'RELGRP',
        }),
      ).toBe('RELGRP');
    });

    it('substitutes {Air Date} when present', () => {
      expect(
        svc.applySeriesFormat('{Air Date}', {
          seriesTitle: 'x',
          season: 1,
          episode: 1,
          quality: '',
          airDate: '2023-05-01',
        }),
      ).toBe('2023-05-01');
    });

    it('{Air Date} renders empty when absent', () => {
      expect(
        svc.applySeriesFormat('{Air Date}', {
          seriesTitle: 'x',
          season: 1,
          episode: 1,
          quality: '',
        }),
      ).toBe('');
    });

    it('{MediaInfo AudioCodec} and {MediaInfo VideoCodec} always render empty', () => {
      const out = svc.applySeriesFormat(
        '{Series Title} [{MediaInfo VideoCodec} {MediaInfo AudioCodec}]',
        { seriesTitle: 'Nova Skyline', season: 1, episode: 1, quality: '' },
      );
      expect(out).toBe('Nova Skyline');
    });
  });

  describe('applyMovieFolderFormat', () => {
    const svc = buildService();

    it('renders the default format with all fields present', () => {
      expect(
        svc.applyMovieFolderFormat(DEFAULT_MOVIE_FOLDER_FORMAT, {
          title: 'Nova Skyline',
          year: 2023,
        }),
      ).toBe('Nova Skyline (2023)');
    });

    it('drops the now-empty parentheses when year is null', () => {
      expect(
        svc.applyMovieFolderFormat(DEFAULT_MOVIE_FOLDER_FORMAT, {
          title: 'Nova Skyline',
          year: null,
        }),
      ).toBe('Nova Skyline');
    });

    it('substitutes {Movie Title}', () => {
      expect(svc.applyMovieFolderFormat('{Movie Title}', { title: 'Nova Skyline' })).toBe(
        'Nova Skyline',
      );
    });

    it('{Original Title} falls back to the title when absent', () => {
      expect(svc.applyMovieFolderFormat('{Original Title}', { title: 'Nova Skyline' })).toBe(
        'Nova Skyline',
      );
    });

    it('substitutes {TMDB Id}', () => {
      expect(svc.applyMovieFolderFormat('{TMDB Id}', { title: 'x', tmdbId: 555 })).toBe('555');
    });
  });

  describe('applySeriesFolderFormat', () => {
    const svc = buildService();

    it('renders the default format', () => {
      expect(
        svc.applySeriesFolderFormat(DEFAULT_SERIES_FOLDER_FORMAT, {
          seriesTitle: 'Nova Skyline',
        }),
      ).toBe('Nova Skyline');
    });

    it('{Original Title} falls back to the series title when absent', () => {
      expect(
        svc.applySeriesFolderFormat('{Original Title}', { seriesTitle: 'Nova Skyline' }),
      ).toBe('Nova Skyline');
    });

    it('substitutes {Release Year}', () => {
      expect(
        svc.applySeriesFolderFormat('({Release Year})', { seriesTitle: 'x', year: 2024 }),
      ).toBe('(2024)');
    });

    it('substitutes {TMDB Id}', () => {
      expect(
        svc.applySeriesFolderFormat('{TMDB Id}', { seriesTitle: 'x', tmdbId: 777 }),
      ).toBe('777');
    });
  });

  describe('applySeasonFolderFormat', () => {
    const svc = buildService();

    it('renders the default format, padded to two digits', () => {
      expect(svc.applySeasonFolderFormat(DEFAULT_SEASON_FOLDER_FORMAT, { season: 3 })).toBe(
        'Season 03',
      );
    });

    it('supports the unpadded {season} token', () => {
      expect(svc.applySeasonFolderFormat('S{season}', { season: 3 })).toBe('S3');
    });
  });

  describe('parseQuality', () => {
    const svc = buildService();

    it.each([
      ['Nova.Skyline.2023.2160p.WEB-DL.mkv', '2160p'],
      ['Nova.Skyline.2023.4K.mkv', '2160p'],
      ['Nova.Skyline.2023.UHD.BluRay.mkv', '2160p'],
      ['Nova.Skyline.2023.720p.HDTV.x264-GRP2', '720p'],
      ['Nova.Skyline.2023.480p.mkv', '480p'],
      ['Nova.Skyline.2023.BluRay.mkv', 'Bluray'],
      ['Nova.Skyline.2023.Blu-Ray.mkv', 'Bluray'],
      ['Nova.Skyline.2023.BDRip.mkv', 'BDRip'],
      ['Nova.Skyline.2023.BRRip.mkv', 'BRRip'],
      ['Nova.Skyline.2023.WEBRip.mkv', 'WEBRip'],
      ['Nova.Skyline.2023.WEB-DL.mkv', 'WEB-DL'],
      ['Nova.Skyline.2023.WEBDL.mkv', 'WEB-DL'],
      ['Nova.Skyline.2023.WEB.mkv', 'WEB'],
      ['Nova.Skyline.2023.HDTV.mkv', 'HDTV'],
      ['Nova.Skyline.2023.DVDRip.mkv', 'DVDRip'],
      ['Nova.Skyline.2023.DVDSCR.mkv', 'DVDSCR'],
      ['Nova.Skyline.2023.HDCAM.mkv', 'HDCAM'],
      ['Nova.Skyline.2023.HD-CAM.mkv', 'HDCAM'],
      ['Nova.Skyline.2023.CAM.mkv', 'CAM'],
      ['Nova.Skyline.2023.CAMRIP.mkv', 'CAM'],
      ['Nova.Skyline.2023.HDTS.mkv', 'Telesync'],
      ['Nova.Skyline.2023.TELESYNC.mkv', 'Telesync'],
      ['Nova.Skyline.2023.REMUX.mkv', 'Remux'],
    ])('parses %s as %s', (title, expected) => {
      expect(svc.parseQuality(title)).toBe(expected);
    });

    it('returns empty string when no quality token is present', () => {
      expect(svc.parseQuality('Nova.Skyline.2023.mkv')).toBe('');
    });

    it('resolution wins over source when both are present, dropping Remux (pinned as-is)', () => {
      expect(svc.parseQuality('Nova.Skyline.2023.1080p.BluRay.REMUX.mkv')).toBe('1080p');
    });
  });

  describe('extractReleaseGroup', () => {
    const svc = buildService();

    it('extracts the group before the extension', () => {
      expect(
        svc.extractReleaseGroup('Nova.Skyline.2023.1080p.WEB-DL-RELGRP.mkv'),
      ).toBe('RELGRP');
    });

    it('extracts the group with no extension', () => {
      expect(svc.extractReleaseGroup('Nova.Skyline.2023.720p.BluRay.x264-GRP2')).toBe(
        'GRP2',
      );
    });

    it('extracts a lowercase group untouched', () => {
      expect(
        svc.extractReleaseGroup('Nova.Skyline.2023.1080p.web-dl-lowergrp.mkv'),
      ).toBe('lowergrp');
    });

    it('returns empty string when there is no trailing -group', () => {
      expect(svc.extractReleaseGroup('Nova Skyline 2023 1080p')).toBe('');
    });

    it('returns empty string when the title has no dash at all', () => {
      expect(svc.extractReleaseGroup('Nova.Skyline.2023.mkv')).toBe('');
    });

    it('misreads a trailing quality tag as the release group when no real group follows it (pinned as-is)', () => {
      expect(svc.extractReleaseGroup('Nova.Skyline.2023.WEBDL-1080p.mkv')).toBe('1080p');
    });
  });

  describe('parseEpisodeNumbers', () => {
    const svc = buildService();

    it('parses standard SxxExx', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.S01E05.WEBDL.mkv')).toEqual({
        season: 1,
        episode: 5,
      });
    });

    it('parses lowercase sxxexx', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.s01e05.mkv')).toEqual({
        season: 1,
        episode: 5,
      });
    });

    it('parses single-digit SxEx', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.S1E5.mkv')).toEqual({
        season: 1,
        episode: 5,
      });
    });

    it('parses a dot/space separated S01.E05', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.S01.E05.mkv')).toEqual({
        season: 1,
        episode: 5,
      });
    });

    it('parses an underscore-separated S01_E05', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.S01_E05.mkv')).toEqual({
        season: 1,
        episode: 5,
      });
    });

    it('parses a multi-episode range S01E05E06', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.S01E05E06.WEBDL.mkv')).toEqual({
        season: 1,
        episode: 5,
        episodeEnd: 6,
      });
    });

    it('parses a multi-episode range S01E05-E06', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.S01E05-E06.WEBDL.mkv')).toEqual({
        season: 1,
        episode: 5,
        episodeEnd: 6,
      });
    });

    it('parses a multi-episode range S01E05-06', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.S01E05-06.WEBDL.mkv')).toEqual({
        season: 1,
        episode: 5,
        episodeEnd: 6,
      });
    });

    it('drops the range end for an underscore-separated multi-episode S01E05_06 (pinned as-is)', () => {
      // Normalization turns `_` into a space before the range regex runs, so the
      // trailing episode never matches even though the pattern lists `_` as a separator.
      expect(svc.parseEpisodeNumbers('Nova.Skyline.S01E05_06.mkv')).toEqual({
        season: 1,
        episode: 5,
      });
    });

    it('parses cross notation 1x05', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.1x05.mkv')).toEqual({
        season: 1,
        episode: 5,
      });
    });

    it('parses cross notation 01x05', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.01x05.mkv')).toEqual({
        season: 1,
        episode: 5,
      });
    });

    it('parses a bare compact "title 103" as season 1 episode 03', () => {
      expect(svc.parseEpisodeNumbers('Nova Skyline 103.mkv')).toEqual({
        season: 1,
        episode: 3,
      });
    });

    it('parses "Part 3" defaulting to season 1', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.Part.3.mkv')).toEqual({
        season: 1,
        episode: 3,
      });
    });

    it('parses "Pt3" defaulting to season 1', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.Pt3.mkv')).toEqual({
        season: 1,
        episode: 3,
      });
    });

    it('parses "Episode 3" defaulting to season 1', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.Episode.3.mkv')).toEqual({
        season: 1,
        episode: 3,
      });
    });

    it('parses "Ep3" defaulting to season 1', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.Ep3.mkv')).toEqual({
        season: 1,
        episode: 3,
      });
    });

    it('parses anime-style " - 03" defaulting to season 1', () => {
      expect(svc.parseEpisodeNumbers('Nova Skyline - 03.mkv')).toEqual({
        season: 1,
        episode: 3,
      });
    });

    it('parses a standalone E03 with no season prefix, defaulting to season 1', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.E03.mkv')).toEqual({
        season: 1,
        episode: 3,
      });
    });

    it('returns null for a season-only pack (no episode number)', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.S02.COMPLETE.mkv')).toBeNull();
    });

    it('returns null for episode 0 (S00E00)', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.S00E00.mkv')).toBeNull();
    });

    it('returns null when a bare release year is the only number present', () => {
      expect(svc.parseEpisodeNumbers('Nova.Skyline.2023.1080p.mkv')).toBeNull();
    });

    it('returns null when there is no number at all', () => {
      expect(svc.parseEpisodeNumbers('Nova Skyline Collection.mkv')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(svc.parseEpisodeNumbers('')).toBeNull();
    });
  });
});

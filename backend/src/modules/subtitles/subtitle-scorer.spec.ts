import {
  EPISODE_WEIGHTS,
  MAX_EPISODE_SCORE,
  MAX_MOVIE_SCORE,
  MOVIE_WEIGHTS,
  scoreSubtitle,
} from './subtitle-scorer';

const EPISODE_CTX = {
  kind: 'episode' as const,
  videoReleaseName: 'Sample.Show.S01E01.1080p.BluRay.x265.DTS-CtrlHD',
  title: 'Sample Show',
  year: 2015,
  season: 1,
  episode: 1,
  imdbId: 'tt0000001',
};

const MOVIE_CTX = {
  kind: 'movie' as const,
  videoReleaseName: 'Sample.Movie.2021.2160p.UHD.BluRay.x265.DV.HDR.DTS-HD.MA.7.1-CtrlHD',
  title: 'Sample Movie',
  year: 2021,
  imdbId: 'tt0000002',
};

describe('subtitle-scorer', () => {
  describe('hash match', () => {
    it('scores an episode hash match as a perfect 100% on hash alone', () => {
      // A hash collision is exclusive: it discards every other match.
      const s = scoreSubtitle({ hashMatched: true }, {
        ...EPISODE_CTX,
        videoReleaseName: null,
      });
      expect(s.matches).toEqual(['hash']);
      expect(s.raw).toBe(EPISODE_WEIGHTS.hash);
      expect(s.max).toBe(MAX_EPISODE_SCORE);
      expect(s.percent).toBe(100);
    });

    it('scores a movie hash match as a perfect 100% on hash alone', () => {
      const s = scoreSubtitle({ hashMatched: true }, {
        ...MOVIE_CTX,
        videoReleaseName: null,
      });
      expect(s.matches).toEqual(['hash']);
      expect(s.raw).toBe(MOVIE_WEIGHTS.hash);
      expect(s.max).toBe(MAX_MOVIE_SCORE);
      expect(s.percent).toBe(100);
    });

    it('ignores release-name attributes once the hash matches', () => {
      const s = scoreSubtitle(
        {
          hashMatched: true,
          releaseName: 'Sample.Movie.2021.2160p.UHD.BluRay.x265-CtrlHD',
        },
        MOVIE_CTX,
      );
      expect(s.matches).toEqual(['hash']);
    });
  });

  describe('release-name matching', () => {
    it('matches release group, source, resolution, codecs on an exact episode release', () => {
      const s = scoreSubtitle(
        { releaseName: 'Sample.Show.S01E01.1080p.BluRay.x265.DTS-CtrlHD' },
        EPISODE_CTX,
      );
      expect(s.matches).toEqual(
        expect.arrayContaining([
          'series',
          'season',
          'episode',
          'releaseGroup',
          'source',
          'resolution',
          'videoCodec',
          'audioCodec',
        ]),
      );
    });

    it('scores lower when the source/resolution differ', () => {
      const good = scoreSubtitle(
        { releaseName: 'Sample.Show.S01E01.1080p.BluRay.x265-CtrlHD' },
        EPISODE_CTX,
      );
      const bad = scoreSubtitle(
        { releaseName: 'Sample.Show.S01E01.720p.WEB-DL.x264-FGT' },
        EPISODE_CTX,
      );
      expect(good.raw).toBeGreaterThan(bad.raw);
    });
  });

  describe('imdb equivalence', () => {
    it('credits series + year when imdb matches and release name is empty', () => {
      const s = scoreSubtitle({ imdbId: EPISODE_CTX.imdbId }, EPISODE_CTX);
      expect(s.matches).toContain('series');
      expect(s.matches).toContain('year');
    });

    it('strips tt prefix for comparison', () => {
      const s = scoreSubtitle({ imdbId: MOVIE_CTX.imdbId }, MOVIE_CTX);
      expect(s.matches).toContain('title');
    });
  });

  describe('hearing-impaired bit', () => {
    it('awards non-HI by default (avoid mode)', () => {
      const s = scoreSubtitle({ hearingImpaired: false }, EPISODE_CTX);
      expect(s.matches).toContain('hearingImpaired');
    });

    it('does not award HI to non-HI candidate in `prefer` mode', () => {
      const s = scoreSubtitle(
        { hearingImpaired: false },
        { ...EPISODE_CTX, hearingImpairedMode: 'prefer' },
      );
      expect(s.matches).not.toContain('hearingImpaired');
    });

    it('awards HI when mode is `prefer`', () => {
      const s = scoreSubtitle(
        { hearingImpaired: true },
        { ...EPISODE_CTX, hearingImpairedMode: 'prefer' },
      );
      expect(s.matches).toContain('hearingImpaired');
    });

    it('treats `require` like `prefer` for the bit', () => {
      const s = scoreSubtitle(
        { hearingImpaired: true },
        { ...EPISODE_CTX, hearingImpairedMode: 'require' },
      );
      expect(s.matches).toContain('hearingImpaired');
    });
  });

  describe('non-hash normalisation', () => {
    it('scores a movie title+year (imdb) match at 76%', () => {
      const s = scoreSubtitle({ imdbId: MOVIE_CTX.imdbId }, MOVIE_CTX);
      expect(s.matches).toEqual(expect.arrayContaining(['title', 'year']));
      expect(s.matches).not.toContain('hash');
      expect(s.percent).toBe(76);
    });

    it('scores a loose title-only movie match at 51%', () => {
      const s = scoreSubtitle({ releaseName: MOVIE_CTX.title }, MOVIE_CTX);
      expect(s.matches).toContain('title');
      expect(s.matches).not.toContain('year');
      expect(s.percent).toBe(51);
    });

    it('scores a perfect non-hash episode release at 100%', () => {
      const s = scoreSubtitle(
        {
          releaseName: EPISODE_CTX.videoReleaseName,
          imdbId: EPISODE_CTX.imdbId,
          hearingImpaired: false,
        },
        EPISODE_CTX,
      );
      expect(s.matches).not.toContain('hash');
      expect(s.percent).toBe(100);
    });
  });

  describe('percent normalisation', () => {
    it('returns 100 for a hash match', () => {
      const s = scoreSubtitle({ hashMatched: true }, EPISODE_CTX);
      expect(s.percent).toBe(100);
    });

    it('caps percent at 0..100', () => {
      const s = scoreSubtitle({}, EPISODE_CTX);
      expect(s.percent).toBeGreaterThanOrEqual(0);
      expect(s.percent).toBeLessThanOrEqual(100);
    });

    it('uses different max for movie kind', () => {
      const s = scoreSubtitle({ hashMatched: true }, MOVIE_CTX);
      expect(s.max).toBe(MAX_MOVIE_SCORE);
    });
  });
});

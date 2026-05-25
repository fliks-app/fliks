import {
  EPISODE_WEIGHTS,
  MAX_EPISODE_SCORE,
  MAX_MOVIE_SCORE,
  MOVIE_WEIGHTS,
  scoreSubtitle,
} from './subtitle-scorer';

const EPISODE_CTX = {
  kind: 'episode' as const,
  videoReleaseName: 'Mr.Robot.S01E01.1080p.BluRay.x265.DTS-CtrlHD',
  title: 'Mr. Robot',
  year: 2015,
  season: 1,
  episode: 1,
  imdbId: 'tt4158110',
};

const MOVIE_CTX = {
  kind: 'movie' as const,
  videoReleaseName: 'Dune.2021.2160p.UHD.BluRay.x265.DV.HDR.DTS-HD.MA.7.1-CtrlHD',
  title: 'Dune',
  year: 2021,
  imdbId: 'tt1160419',
};

describe('subtitle-scorer', () => {
  describe('hash match', () => {
    it('awards near-max score for an episode hash match', () => {
      // No releaseName / videoReleaseName here so only hash + id-style
      // bonuses + the default-non-HI bit are credited.
      const s = scoreSubtitle({ hashMatched: true }, {
        ...EPISODE_CTX,
        videoReleaseName: null,
      });
      expect(s.matches).toContain('hash');
      expect(s.matches).toContain('series');
      expect(s.matches).toContain('season');
      expect(s.matches).toContain('episode');
      expect(s.matches).toContain('year');
      const expectedRaw =
        EPISODE_WEIGHTS.hash +
        EPISODE_WEIGHTS.series +
        EPISODE_WEIGHTS.season +
        EPISODE_WEIGHTS.episode +
        EPISODE_WEIGHTS.year +
        EPISODE_WEIGHTS.hearingImpaired;
      expect(s.raw).toBe(expectedRaw);
      expect(s.max).toBe(MAX_EPISODE_SCORE);
    });

    it('awards hash + title + year for a movie hash match', () => {
      const s = scoreSubtitle({ hashMatched: true }, {
        ...MOVIE_CTX,
        videoReleaseName: null,
      });
      expect(s.matches).toEqual(
        expect.arrayContaining(['hash', 'title', 'year']),
      );
      expect(s.raw).toBe(
        MOVIE_WEIGHTS.hash +
          MOVIE_WEIGHTS.title +
          MOVIE_WEIGHTS.year +
          MOVIE_WEIGHTS.hearingImpaired,
      );
    });
  });

  describe('release-name matching', () => {
    it('matches release group, source, resolution, codecs on an exact episode release', () => {
      const s = scoreSubtitle(
        { releaseName: 'Mr.Robot.S01E01.1080p.BluRay.x265.DTS-CtrlHD' },
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
        { releaseName: 'Mr.Robot.S01E01.1080p.BluRay.x265-CtrlHD' },
        EPISODE_CTX,
      );
      const bad = scoreSubtitle(
        { releaseName: 'Mr.Robot.S01E01.720p.WEB-DL.x264-FGT' },
        EPISODE_CTX,
      );
      expect(good.raw).toBeGreaterThan(bad.raw);
    });
  });

  describe('imdb equivalence', () => {
    it('credits series + year when imdb matches and release name is empty', () => {
      const s = scoreSubtitle({ imdbId: 'tt4158110' }, EPISODE_CTX);
      expect(s.matches).toContain('series');
      expect(s.matches).toContain('year');
    });

    it('strips tt prefix for comparison', () => {
      const s = scoreSubtitle({ imdbId: 'tt1160419' }, MOVIE_CTX);
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

  describe('percent normalisation', () => {
    it('returns 100 when every applicable attribute matches an episode', () => {
      const s = scoreSubtitle(
        {
          hashMatched: true,
          releaseName: 'Mr.Robot.S01E01.1080p.BluRay.x265.DTS-CtrlHD',
          imdbId: 'tt4158110',
          hearingImpaired: false,
        },
        EPISODE_CTX,
      );
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

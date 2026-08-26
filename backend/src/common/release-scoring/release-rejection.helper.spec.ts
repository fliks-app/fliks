import {
  computeRejections,
  releaseMatchesMedia,
  resolveSearchTitles,
  sortReleasesByRelevance,
  titleMatchesExpectation,
} from './release-rejection.helper';

type Row = Parameters<typeof sortReleasesByRelevance>[0][number];

function row(over: Partial<Row> & { id: string }): Row & { id: string } {
  return {
    rank: 100,
    allowed: true,
    blocklisted: false,
    languageAllowed: true,
    rejections: [],
    customFormatScore: 0,
    seeders: 10,
    leechers: 0,
    freeleech: false,
    sizeDeviation: 0,
    ...over,
  };
}

/** Order the rows and return their ids for terse assertions. */
function order(rows: ReturnType<typeof row>[]): string[] {
  return sortReleasesByRelevance(rows).map((r) => r.id);
}

describe('sortReleasesByRelevance', () => {
  it('sinks a dead release below a lower-quality live one', () => {
    const deadHd = row({ id: 'dead-1080p', rank: 200, seeders: 0 });
    const liveSd = row({ id: 'live-720p', rank: 100, seeders: 5 });
    expect(order([deadHd, liveSd])).toEqual(['live-720p', 'dead-1080p']);
  });

  it('keeps quality first between two live releases', () => {
    const liveHdFewSeeds = row({ id: 'hd', rank: 200, seeders: 5 });
    const liveSdManySeeds = row({ id: 'sd', rank: 100, seeders: 500 });
    expect(order([liveSdManySeeds, liveHdFewSeeds])).toEqual(['hd', 'sd']);
  });

  it('orders by seeders within the same quality tier, above size proximity', () => {
    // The worse-seeded row sits closer to the preferred size; seeders win.
    const fewSeedsBetterSize = row({
      id: 'few',
      seeders: 5,
      sizeDeviation: 0,
    });
    const manySeedsWorseSize = row({
      id: 'many',
      seeders: 200,
      sizeDeviation: 0.4,
    });
    expect(order([fewSeedsBetterSize, manySeedsWorseSize])).toEqual([
      'many',
      'few',
    ]);
  });

  it('breaks a seeder tie toward the busier swarm (more leechers)', () => {
    const quiet = row({ id: 'quiet', seeders: 100, leechers: 1 });
    const busy = row({ id: 'busy', seeders: 100, leechers: 80 });
    expect(order([quiet, busy])).toEqual(['busy', 'quiet']);
  });

  it('still ranks a clean release above a rejected one', () => {
    const rejected = row({
      id: 'rejected',
      rank: 300,
      seeders: 999,
      rejections: [{ code: 'QUALITY_NOT_ALLOWED' }],
    });
    const clean = row({ id: 'clean', rank: 100, seeders: 1 });
    expect(order([rejected, clean])).toEqual(['clean', 'rejected']);
  });
});

describe('releaseMatchesMedia', () => {
  const movie = {
    title: 'Titre localisé',
    originalTitle: 'Original Movie Title',
    year: 2004,
    alternativeTitles: null,
  };

  it('rejects an unrelated same-year theatrical', () => {
    expect(
      releaseMatchesMedia(
        'Other.Movie.2004.2160p.UHD.BluRay.x265-GROUP',
        movie,
        { requireYearInTitle: true },
      ),
    ).toBe(false);
  });

  it('accepts a release named after the original title', () => {
    expect(
      releaseMatchesMedia(
        'Original.Movie.Title.2004.1080p.WEB-DL.x264-GROUP',
        movie,
        { requireYearInTitle: true },
      ),
    ).toBe(true);
  });

  // A movie routinely carries TMDB alternative titles in other scripts. Those
  // tokenize to nothing, and must not turn the matcher into a wildcard that
  // claims every same-year release — otherwise RSS/SearchMissing grab an
  // unrelated film that merely shares the year.
  const withNonLatinAlt = {
    title: 'Original Movie Title',
    originalTitle: 'Original Movie Title',
    year: 1985,
    alternativeTitles: ['作品タイトル', 'Original Movie Title'],
  };

  it('rejects an unrelated same-year release despite a non-Latin alternative title', () => {
    expect(
      releaseMatchesMedia(
        'Unrelated.Other.Film.1985.1080p.BluRay.x264-GROUP',
        withNonLatinAlt,
        { requireYearInTitle: true },
      ),
    ).toBe(false);
  });

  it('still accepts the real title when a non-Latin alternative title is stored', () => {
    expect(
      releaseMatchesMedia(
        'Original.Movie.Title.1985.1080p.BluRay.x264-GROUP',
        withNonLatinAlt,
        { requireYearInTitle: true },
      ),
    ).toBe(true);
  });
});

describe('resolveSearchTitles + titleMatchesExpectation', () => {
  const localizedShow = {
    title: 'Série localisée',
    originalTitle: 'Original Show Title',
    alternativeTitles: null,
  };

  it('matches an English scene release when the library title is localized', () => {
    const { expectedTitles } = resolveSearchTitles(localizedShow);
    expect(
      titleMatchesExpectation(
        'Original.Show.Title.S09E04.1080p.WEB-DL.x264-GROUP',
        expectedTitles,
      ),
    ).toBe(true);
  });

  it('does not match an unrelated show', () => {
    const { expectedTitles } = resolveSearchTitles(localizedShow);
    expect(
      titleMatchesExpectation(
        'Other.Series.S05E10.1080p.x264-GROUP',
        expectedTitles,
      ),
    ).toBe(false);
  });

  // Release groups drop the English possessive apostrophe and glue the
  // letters ("Owner's" → "Owners"), so the stored original title must still
  // match a release spelled without it — and vice-versa for the French
  // elision, which splits on the apostrophe ("l'éditeur" → "l editeur").
  const possessiveShow = {
    title: "Titre localisé de l'éditeur",
    originalTitle: "Owner's Original Title",
    alternativeTitles: null,
  };

  it('matches a release that drops the possessive apostrophe', () => {
    const { expectedTitles } = resolveSearchTitles(possessiveShow);
    expect(
      titleMatchesExpectation(
        'Owners.Original.Title.S01E04.1080p.HDTV.x264-GROUP',
        expectedTitles,
      ),
    ).toBe(true);
  });

  it('matches an English-titled release even when its audio is localized', () => {
    const { expectedTitles } = resolveSearchTitles(possessiveShow);
    expect(
      titleMatchesExpectation(
        'Owners.Original.Title.S01E04.MULTI.VF.1080p.HDTV-GROUP',
        expectedTitles,
      ),
    ).toBe(true);
  });

  it('still matches the localized title with an elided article', () => {
    const { expectedTitles } = resolveSearchTitles(possessiveShow);
    expect(
      titleMatchesExpectation(
        'Titre.localise.de.l.editeur.S01E04.AD.HDTV.x264-GROUP',
        expectedTitles,
      ),
    ).toBe(true);
  });

  it('skips a non-Latin candidate instead of matching everything', () => {
    expect(
      titleMatchesExpectation('Unrelated.Other.Film.1985.1080p.x264-GROUP', [
        'Original Movie Title',
        '作品タイトル',
      ]),
    ).toBe(false);
  });

  it("VERDICT: an unreadable expectation claims nothing when the caller is identifying", () => {
    // Identification: the first such row would otherwise answer for every unmatched release.
    expect(
      titleMatchesExpectation('Anything.1985.1080p.x264-GROUP', ['作品タイトル', '作品'], 'no-match'),
    ).toBe(false);
  });

  it('an unreadable expectation vetoes nothing when the caller is a rejection net', () => {
    // Scoring already knows the media; a net that cannot read the title must not reject its releases.
    expect(titleMatchesExpectation('Anything.1985.1080p.x264-GROUP', ['作品タイトル', '作品'])).toBe(true);
  });

  it('still tokenizes the Latin portion of a mixed-script title', () => {
    expect(
      titleMatchesExpectation('Tokyo.Story.S01E01.1080p.WEB-DL.x264-GROUP', [
        '東京 Tokyo Story',
      ]),
    ).toBe(true);
  });
});

describe('computeRejections — episode targeting', () => {
  const reject = (releaseTitle: string, expectedSeason?: number, expectedEpisode?: number) =>
    computeRejections({
      qualityId: 1,
      allowed: new Set([1]),
      languageId: 1,
      allowedLangs: new Set<number>(),
      isBlocklisted: false,
      sizeBytes: 0,
      runtimeMinutes: 30,
      sizeByQuality: new Map(),
      seeders: 10,
      sourceId: 0,
      sourceMinSeeders: new Map(),
      releaseTitle,
      expectedSeason,
      expectedEpisode,
    }).map((r) => r.code);

  it('rejects a release for another episode of the same season', () => {
    expect(reject('Some.Show.S04E02.1080p.WEB-DL.x264', 4, 3)).toEqual([
      'EPISODE_MISMATCH',
    ]);
  });

  it('accepts the requested episode', () => {
    expect(reject('Some.Show.S04E03.1080p.WEB-DL.x264', 4, 3)).toEqual([]);
  });

  // A pack has no episode number, so the season/episode comparison alone never objected to one
  // — and the size limits, the only other thing that would have, need a runtime the provider
  // often does not give for a series. Hence a rule of its own.
  it('VERDICT: rejects a full-season pack when one episode was asked for', () => {
    expect(reject('Some.Show.S04.COMPLETE.1080p.WEB-DL', 4, 3)).toEqual([
      'FULL_SEASON_FOR_EPISODE',
    ]);
  });

  it('leaves a pack alone when the request is the season itself', () => {
    expect(reject('Some.Show.S04.COMPLETE.1080p.WEB-DL', 4, undefined)).toEqual([]);
  });

  it('rejects a pack from another season on both counts', () => {
    expect(reject('Some.Show.S03.COMPLETE.1080p.WEB-DL', 4, 3)).toEqual([
      'EPISODE_MISMATCH',
      'FULL_SEASON_FOR_EPISODE',
    ]);
  });

  it('names both sides in the rejection params', () => {
    const [rejection] = computeRejections({
      qualityId: 1,
      allowed: new Set([1]),
      languageId: 1,
      allowedLangs: new Set<number>(),
      isBlocklisted: false,
      sizeBytes: 0,
      runtimeMinutes: 30,
      sizeByQuality: new Map(),
      seeders: 10,
      sourceId: 0,
      sourceMinSeeders: new Map(),
      releaseTitle: 'Some.Show.S04E02.1080p.WEB-DL.x264',
      expectedSeason: 4,
      expectedEpisode: 3,
    });
    expect(rejection.params).toEqual({ expected: 'S04E03', actual: 'S04E02' });
  });

  it('leaves an unreadable title alone rather than guessing', () => {
    expect(reject('Some.Show.1080p.WEB-DL.x264', 4, 3)).toEqual([]);
  });

  it('ignores episode numbers when no episode is targeted', () => {
    expect(reject('Some.Show.S04E02.1080p.WEB-DL.x264')).toEqual([]);
  });
});

describe('sortReleasesByRelevance — season-scoped pack preference', () => {
  const pack = (over: Partial<Row> & { id: string }) =>
    row({ isFullSeason: true, ...over });

  it('prefers a pack over a single episode of the same quality', () => {
    const single = row({ id: 'single', seeders: 5000 });
    const seasonPack = pack({ id: 'pack', seeders: 20 });
    expect(
      sortReleasesByRelevance([single, seasonPack], {
        preferFullSeason: true,
      }).map((r) => r.id),
    ).toEqual(['pack', 'single']);
  });

  it('keeps a better-quality single episode above a weaker pack', () => {
    const single = row({ id: 'single-1080p', rank: 200 });
    const seasonPack = pack({ id: 'pack-720p', rank: 100 });
    expect(
      sortReleasesByRelevance([seasonPack, single], {
        preferFullSeason: true,
      }).map((r) => r.id),
    ).toEqual(['single-1080p', 'pack-720p']);
  });

  it('ignores pack status when the search is not season-scoped', () => {
    const single = row({ id: 'single', seeders: 5000 });
    const seasonPack = pack({ id: 'pack', seeders: 20 });
    expect(order([single, seasonPack])).toEqual(['single', 'pack']);
  });
});

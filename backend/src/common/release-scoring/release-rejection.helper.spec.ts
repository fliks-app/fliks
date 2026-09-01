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
    qualityId: 16, // WEBDL-1080p
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

  it('puts the custom-format score above the freeleech bonus', () => {
    // Freeleech is expressible as a `release_flag` condition, so a configured score
    // has to outrank the hardcoded preference rather than be overridden by it.
    const free = row({ id: 'freeleech', freeleech: true });
    const scored = row({ id: 'scored', customFormatScore: 100 });
    expect(order([free, scored])).toEqual(['scored', 'freeleech']);
  });

  it('still prefers freeleech at an equal custom-format score', () => {
    const free = row({ id: 'freeleech', freeleech: true, customFormatScore: 100 });
    const paid = row({ id: 'paid', customFormatScore: 100 });
    expect(order([free, paid])).toEqual(['freeleech', 'paid']);
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

/**
 * The title check is a token-inclusion test, so a sequel passes it: every token of the title we
 * asked for is there, the release simply says more. That is how a sequel with the most seeders
 * came out first for the film it is a sequel of.
 */
describe('computeRejections — the wrong work under the right title', () => {
  const reject = (
    releaseTitle: string,
    expectedTitle: string | string[] = ['Nova Skyline', 'La voix du succès'],
    expectedYear: number | null = 2012,
    scope: { expectedSeason?: number; expectedEpisode?: number } = {},
  ) =>
    computeRejections({
      qualityId: 1,
      allowed: new Set([1]),
      languageId: 1,
      allowedLangs: new Set<number>(),
      isBlocklisted: false,
      sizeBytes: 0,
      runtimeMinutes: 112,
      sizeByQuality: new Map(),
      seeders: 10,
      sourceId: 0,
      sourceMinSeeders: new Map(),
      releaseTitle,
      expectedTitle,
      expectedYear,
      ...scope,
    }).map((r) => r.code);

  it('VERDICT: refuses a sequel of the film that was asked for', () => {
    expect(reject('Nova.Skyline.2.2015.1080p.BluRay.x264-GRP')).toEqual([
      'SEQUEL_MISMATCH',
      'YEAR_MISMATCH',
    ]);
  });

  it('VERDICT: refuses a multi-film pack when one film was asked for', () => {
    expect(reject('Nova.Skyline.Collection.(2012-2017).MULTi.1080p.BluRay.x264-GRP')).toEqual([
      'COLLECTION_PACK',
    ]);
  });

  it.each([
    'Nova.Skyline.2012.1080p.BluRay.DD.7.1.x265-GRP',
    'Nova Skyline (2012) 1080p BrRip x264 GRP',
    'Nova-Skyline-(2012)[1080p-BDRip--Original-Auds-]',
    'La.voix.du.succes.(2012).[1080p].MULTI.VF2.Bluray.x264-GRP',
    'Nova.Skyline.2012.UNRATED.1080p',
  ])('takes the film that was asked for — %s', (title) => {
    expect(reject(title)).toEqual([]);
  });

  it('VERDICT: takes its own release for a media whose title ends in a number', () => {
    expect(reject('Nova.Skyline.2.2015.1080p.BluRay.x264-GRP', ['Nova Skyline 2'], 2015)).toEqual(
      [],
    );
    // …and still refuses the film it is a sequel of.
    expect(reject('Nova.Skyline.2012.1080p.BluRay', ['Nova Skyline 2'], 2015)).toEqual([
      'YEAR_MISMATCH',
    ]);
  });

  it('judges no year on a release that states none', () => {
    expect(reject('Nova.Skyline.1080p.BluRay.x264-GRP')).toEqual([]);
  });

  it('allows a year one off, which a staggered release date produces', () => {
    expect(reject('Nova.Skyline.2013.1080p.BluRay')).toEqual([]);
    expect(reject('Nova.Skyline.2014.1080p.BluRay')).toEqual(['YEAR_MISMATCH']);
  });

  it('reads a resolution or a codec as neither a year nor a sequel number', () => {
    expect(reject('Nova.Skyline.2012.2160p.x264.DDP5.1.HDR10')).toEqual([]);
  });

  it('VERDICT: leaves a title that is itself a year, or itself a pack word, alone', () => {
    expect(reject('2012.2009.1080p.BluRay', ['2012'], 2009)).toEqual([]);
    expect(reject('The.Collection.2012.1080p', ['The Collection'], 2012)).toEqual([]);
  });

  it('takes a season pack for a season-scoped search, pack word and all', () => {
    expect(
      reject('Nova.Skyline.Complete.Collection.1080p', ['Nova Skyline'], null, {
        expectedSeason: 4,
      }),
    ).toEqual([]);
  });

  it('says nothing about a release the title check already refused', () => {
    expect(reject('Other.Show.2.2015.1080p')).toEqual(['TITLE_MISMATCH', 'YEAR_MISMATCH']);
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

  it('keeps a higher-resolution single episode above a weaker pack', () => {
    const single = row({ id: 'single-1080p', qualityId: 16, rank: 200 });
    const seasonPack = pack({ id: 'pack-720p', qualityId: 12, rank: 100 });
    expect(
      sortReleasesByRelevance([seasonPack, single], {
        preferFullSeason: true,
      }).map((r) => r.id),
    ).toEqual(['single-1080p', 'pack-720p']);
  });

  it('prefers a weaker-source pack at the same resolution', () => {
    // WEBRip-1080p ranks below WEBDL-1080p, same 1080p resolution.
    const single = row({ id: 'single-webdl', qualityId: 16, rank: 62 });
    const seasonPack = pack({ id: 'pack-webrip', qualityId: 17, rank: 60 });
    expect(
      sortReleasesByRelevance([single, seasonPack], {
        preferFullSeason: true,
      }).map((r) => r.id),
    ).toEqual(['pack-webrip', 'single-webdl']);
  });

  it('ignores pack status when the search is not season-scoped', () => {
    const single = row({ id: 'single', seeders: 5000 });
    const seasonPack = pack({ id: 'pack', seeders: 20 });
    expect(order([single, seasonPack])).toEqual(['single', 'pack']);
  });
});

/**
 * `resolutionUpgradeOnly` survived the acquisition split as data and nothing else: core shipped
 * `want.minResolution` over the seam, the plugin's own note assumed core folded it into the
 * rejections, and core never did. The toggle was inert for every profile.
 */
describe('computeRejections — resolution upgrade only', () => {
  const base = {
    qualityId: 9,
    allowed: new Set([9]),
    languageId: 1,
    allowedLangs: new Set<number>(),
    isBlocklisted: false,
    sizeBytes: 0,
    runtimeMinutes: 0,
    sizeByQuality: new Map(),
    seeders: 10,
    sourceId: 0,
    sourceMinSeeders: new Map<number, number>(),
  };

  const codes = (releaseTitle: string, minResolution?: number) =>
    computeRejections({ ...base, releaseTitle, minResolution }).map((r) => r.code);

  it('VERDICT: refuses a same-resolution release when only a resolution upgrade is allowed', () => {
    expect(codes('Show.S01E01.1080p.BluRay.x264', 1080)).toEqual(['RESOLUTION_NOT_UPGRADED']);
  });

  it('accepts a higher resolution', () => {
    expect(codes('Show.S01E01.2160p.WEB-DL.x265', 1080)).toEqual([]);
  });

  it('refuses a lower resolution too, not just an equal one', () => {
    expect(codes('Show.S01E01.720p.WEB-DL.x264', 1080)).toEqual(['RESOLUTION_NOT_UPGRADED']);
  });

  it('does not apply when the profile asks nothing — a missing grab must stay open', () => {
    expect(codes('Show.S01E01.1080p.BluRay.x264', 0)).toEqual([]);
    expect(codes('Show.S01E01.1080p.BluRay.x264', undefined)).toEqual([]);
  });
});

describe('computeRejections — the quality profile', () => {
  // 12 WEBDL-720p (45), 16 WEBDL-1080p (62), 18 Bluray-1080p (68), 19 Remux-1080p (72).
  const codeFor = (qualityId: number, allowed: number[]) =>
    computeRejections({
      qualityId,
      allowed: new Set(allowed),
      languageId: 1,
      allowedLangs: new Set<number>(),
      isBlocklisted: false,
      sizeBytes: 0,
      runtimeMinutes: 112,
      sizeByQuality: new Map(),
      seeders: 10,
      sourceId: 0,
      sourceMinSeeders: new Map(),
    }).map((r) => r.code);

  it('an allowed quality is not rejected on quality', () => {
    expect(codeFor(16, [16, 18])).toEqual([]);
  });

  it('VERDICT: membership, not a ceiling — above and below the profile read alike', () => {
    expect(codeFor(19, [16, 18])).toEqual(['QUALITY_NOT_ALLOWED']);
    expect(codeFor(12, [16, 18])).toEqual(['QUALITY_NOT_ALLOWED']);
  });

  it('an empty profile allows nothing', () => {
    expect(codeFor(16, [])).toEqual(['QUALITY_NOT_ALLOWED']);
  });
});

describe('computeRejections — custom format floor', () => {
  const base = {
    qualityId: 1,
    allowed: new Set([1]),
    languageId: 1,
    allowedLangs: new Set<number>(),
    isBlocklisted: false,
    sizeBytes: 0,
    runtimeMinutes: 112,
    sizeByQuality: new Map(),
    seeders: 10,
    sourceId: 0,
    sourceMinSeeders: new Map(),
  };
  const codes = (customFormatScore: number, minCustomFormatScore?: number) =>
    computeRejections({ ...base, customFormatScore, minCustomFormatScore }).map((r) => r.code);

  it('rejects a release scoring below the profile floor', () => {
    expect(codes(-50, 0)).toContain('CUSTOM_FORMAT_SCORE_TOO_LOW');
    expect(codes(0, 0)).not.toContain('CUSTOM_FORMAT_SCORE_TOO_LOW');
    expect(codes(10, 50)).toContain('CUSTOM_FORMAT_SCORE_TOO_LOW');
  });

  it('applies no floor when the profile declares none', () => {
    expect(codes(-9999)).not.toContain('CUSTOM_FORMAT_SCORE_TOO_LOW');
  });
});

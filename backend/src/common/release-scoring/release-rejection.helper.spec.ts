import {
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

  it('stays permissive when every candidate is non-Latin', () => {
    // A work stored only under a non-Latin name yields no comparable tokens;
    // acceptance falls back to permissive so it remains grabbable.
    expect(
      titleMatchesExpectation('Anything.1985.1080p.x264-GROUP', [
        '作品タイトル',
        '作品',
      ]),
    ).toBe(true);
  });
});

import {
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

describe('resolveSearchTitles + titleMatchesExpectation', () => {
  const rickFr = {
    title: 'Rick et Morty',
    originalTitle: 'Rick and Morty',
    alternativeTitles: null,
  };

  it('matches an English scene release when the library title is localized', () => {
    const { expectedTitles } = resolveSearchTitles(rickFr);
    expect(
      titleMatchesExpectation(
        'Rick.and.Morty.S09E04.1080p.WEB-DL.x264-GROUP',
        expectedTitles,
      ),
    ).toBe(true);
  });

  it('does not match an unrelated show', () => {
    const { expectedTitles } = resolveSearchTitles(rickFr);
    expect(
      titleMatchesExpectation(
        'Abbott.Elementary.S05E10.1080p.x264-GROUP',
        expectedTitles,
      ),
    ).toBe(false);
  });
});

import { AcquisitionCandidatesService, type EpisodeTarget } from './acquisition-candidates.service';
import { Media } from './entities/media.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';

/**
 * `groupIntoSeasonPacks` decided on "two or more episodes wanted", which fires for two missing
 * episodes of twenty-four — a gap to fill, not a season to acquire — and for a season still
 * airing, which no full-season release exists for at all.
 */

const media = { id: 1, title: 'Show' } as unknown as Media;

function season(id: number): Season {
  return { id, seasonNumber: 1, mediaId: 1 } as unknown as Season;
}

function target(seasonRow: Season, episodeNumber: number): EpisodeTarget {
  return {
    media,
    season: seasonRow,
    episode: { id: 100 + episodeNumber, episodeNumber } as unknown as Episode,
    files: [],
  };
}

/** Answers the two grouped counts this method runs: episodes per season, then unaired per season. */
function serviceWith(opts: { total: number; unaired: number; seasonId: number }) {
  const rawManyBySql: unknown[][] = [
    [{ seasonId: opts.seasonId, cnt: String(opts.total) }],
    opts.unaired ? [{ seasonId: opts.seasonId, cnt: String(opts.unaired) }] : [],
  ];
  let call = 0;
  const qb = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'innerJoin']) {
      b[m] = () => b;
    }
    b.getRawMany = () => Promise.resolve(rawManyBySql[call++] ?? []);
    return b;
  };
  const episodeRepo = { createQueryBuilder: qb } as never;
  return new AcquisitionCandidatesService(
    null as never,
    episodeRepo,
    null as never,
    null as never,
  );
}

describe('AcquisitionCandidatesService.groupIntoSeasonPacks', () => {
  it('VERDICT: refuses a pack for a season wanted only in part', async () => {
    const s = season(20);
    const service = serviceWith({ total: 24, unaired: 0, seasonId: 20 });
    // Two of twenty-four: a pack would fetch twenty-two episodes already on disk.
    const packs = await service.groupIntoSeasonPacks([target(s, 3), target(s, 7)]);
    expect(packs).toEqual([]);
  });

  it('builds a pack once most of the season is wanted', async () => {
    const s = season(20);
    const service = serviceWith({ total: 4, unaired: 0, seasonId: 20 });
    const packs = await service.groupIntoSeasonPacks([target(s, 1), target(s, 2), target(s, 3)]);
    expect(packs).toHaveLength(1);
    expect(packs[0].totalEpisodeCount).toBe(4);
  });

  it('VERDICT: refuses a pack for a season still airing, whatever share is wanted', async () => {
    const s = season(20);
    // Every aired episode wanted, but six have not aired: no full-season release exists yet.
    const service = serviceWith({ total: 8, unaired: 6, seasonId: 20 });
    const packs = await service.groupIntoSeasonPacks([target(s, 1), target(s, 2)]);
    expect(packs).toEqual([]);
  });

  it('still needs two wanted episodes before a pack is considered at all', async () => {
    const s = season(20);
    const service = serviceWith({ total: 1, unaired: 0, seasonId: 20 });
    expect(await service.groupIntoSeasonPacks([target(s, 1)])).toEqual([]);
  });
});

import { SubtitleSchedulerService } from './subtitle-scheduler.service';
import { SubtitleStatus } from '../../common/enums';

/**
 * The upgrade pass walks the rows it mutates: a successful upgrade raises the
 * score past the threshold, so the row leaves the filtered set mid-walk. A
 * positional cursor then steps over the rows that moved up under it — with 25
 * eligible rows and batches of 10, offset 10 lands on the 21st, and rows 11-20
 * are never visited. An id cursor cannot do that.
 */
describe('SubtitleSchedulerService.upgradeSubtitles — walking a shrinking set', () => {
  const THRESHOLD = 90;

  /** Rows must outnumber the service's own batch size, or the whole set arrives
   *  in one query and the walk is never exercised. */
  const ROWS = 250;

  /** Query-builder stub that re-filters a live table per batch, honouring
   *  whichever cursor the service uses: `andWhere(sf.id > :lastId)` or `skip()`. */
  function fakeSubtitleRepo(
    table: { id: number; score: number }[],
    profileItem: Record<string, unknown> = { isoCode: 'fr', name: 'French' },
  ) {
    const seen: number[] = [];
    const createQueryBuilder = () => {
      let lastId = 0;
      let offset = 0;
      let take = Number.MAX_SAFE_INTEGER;
      const qb: Record<string, unknown> = {};
      for (const m of ['where', 'leftJoinAndSelect', 'orderBy']) qb[m] = () => qb;
      qb.andWhere = (_sql: string, params?: Record<string, unknown>) => {
        if (params && 'lastId' in params) lastId = Number(params.lastId);
        return qb;
      };
      qb.skip = (n: number) => {
        offset = Number(n);
        return qb;
      };
      qb.take = (n: number) => {
        take = Number(n);
        return qb;
      };
      qb.getMany = () => {
        const rows = table
          .filter((r) => r.score < THRESHOLD && r.id > lastId)
          .sort((a, b) => a.id - b.id)
          .slice(offset, offset + take)
          .map((r) => ({
            id: r.id,
            score: r.score,
            language: 'fr',
            hashMatched: false,
            status: SubtitleStatus.DOWNLOADED,
            media: {
              title: 'T',
              tmdbId: 1,
              languageProfile: { subtitleLanguages: [profileItem] },
            },
            mediaFile: { id: 500 + r.id, relativePath: 'a/b.mkv' },
          }));
        rows.forEach((r) => seen.push(r.id));
        return Promise.resolve(rows);
      };
      return qb;
    };
    return {
      seen,
      repo: {
        createQueryBuilder,
        // buildMissingLangsByFile: every file already covers its required language
        find: () =>
          Promise.resolve(
            table.map((r) => ({
              mediaFile: { id: 500 + r.id },
              language: 'fr',
              status: SubtitleStatus.DOWNLOADED,
            })),
          ),
      },
    };
  }

  function makeService(
    table: { id: number; score: number }[],
    profileItem?: Record<string, unknown>,
  ) {
    const { seen, repo } = fakeSubtitleRepo(table, profileItem);
    const service = new SubtitleSchedulerService(
      {} as never,
      {} as never,
      repo as never,
      {
        // always a better candidate, so every visited row is upgraded out of the set
        searchSubtitles: () =>
          Promise.resolve([{ score: 99, providerName: 'p', hashMatched: false }]),
        upgradeSubtitle: (id: number) => {
          const row = table.find((r) => r.id === id);
          if (row) row.score = 99;
          return Promise.resolve({ id });
        },
      } as never,
      { reencodeToUtf8: jest.fn(), syncSubtitle: jest.fn() } as never,
      { dispatch: jest.fn() } as never,
      {
        get: (k: string) =>
          Promise.resolve(k === 'subtitle_upgrade_threshold' ? String(THRESHOLD) : undefined),
      } as never,
      {} as never,
      {} as never,
      { dispatch: jest.fn() } as never,
    );
    return { service, seen, table };
  }

  it('VERDICT: visits every eligible row once even as upgrades remove them', async () => {
    const table = Array.from({ length: ROWS }, (_, i) => ({ id: i + 1, score: 10 }));
    const { service, seen, table: live } = makeService(table);

    await service.upgradeSubtitles();

    expect([...seen].sort((a, b) => a - b)).toEqual(live.map((r) => r.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(live.every((r) => r.score === 99)).toBe(true);
  });

  it('VERDICT: never replaces a full subtitle with a forced-only candidate', async () => {
    // rows carry forced=false; the profile asks for a forced track, so no
    // profile item matches and `upgradeSubtitle` — which deletes the file on
    // disk — must never run.
    const table = [{ id: 1, score: 10 }];
    const { service } = makeService(table, {
      isoCode: 'fr',
      name: 'French',
      forced: true,
      hi: false,
    });

    await service.upgradeSubtitles();

    expect(table[0].score).toBe(10);
  });

  it('terminates when nothing is eligible', async () => {
    const { service, seen } = makeService([{ id: 1, score: 99 }]);

    await service.upgradeSubtitles();

    expect(seen).toEqual([]);
  });
});

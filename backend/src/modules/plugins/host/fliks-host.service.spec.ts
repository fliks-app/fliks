import { FliksHostImpl } from './fliks-host.service';
import { PluginCountsCacheService } from './plugin-counts-cache.service';
import { MediaType } from '../../../common/enums';
import type { Media } from '../../media/entities/media.entity';
import type { Season } from '../../media/entities/season.entity';
import type { Episode } from '../../media/entities/episode.entity';

/** Round-trips `value` through JSON and asserts nothing was lost or mutated —
 *  the property that matters once the transport becomes a socket (Phase 10.4).
 *  Catches what a naive `toEqual` misses: a `Date` (becomes a string), `Infinity`
 *  / `NaN` (become `null`), and a circular reference (throws outright). */
function expectJsonSafe(value: unknown): void {
  const roundTripped: unknown = JSON.parse(JSON.stringify(value));
  expect(roundTripped).toEqual(value);
}

function fakeQueryBuilder(rawMany: unknown[] = [], one: unknown = null) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'orderBy',
    'leftJoin',
    'innerJoin',
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rawMany);
  qb.getRawOne = jest.fn().mockResolvedValue(null);
  qb.getOne = jest.fn().mockResolvedValue(one);
  qb.getCount = jest.fn().mockResolvedValue(0);
  return qb;
}

function fakeRepo() {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    save: jest.fn(),
    create: jest.fn((x: unknown) => x),
    createQueryBuilder: jest.fn(() => fakeQueryBuilder()),
  };
}

function makeMedia(overrides: Record<string, unknown> = {}): Media {
  return {
    id: 1,
    type: MediaType.MOVIE,
    title: 'A Movie',
    originalTitle: null,
    alternativeTitles: [],
    year: 2020,
    runtime: 100,
    imdbId: 'tt1',
    tmdbId: 42,
    tvdbId: null,
    libraryId: 7,
    monitored: true,
    releaseDate: null,
    qualityProfile: null,
    languageProfile: null,
    library: { id: 7, path: '/lib' },
    ...overrides,
  } as unknown as Media;
}

function makeSeason(overrides: Partial<Season> = {}): Season {
  return {
    id: 10,
    mediaId: 1,
    seasonNumber: 1,
    monitored: true,
    ...overrides,
  } as unknown as Season;
}

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 100,
    episodeNumber: 1,
    endEpisodeNumber: null,
    airDate: '2020-01-01',
    monitored: true,
    hasFile: false,
    title: 'Pilot',
    ...overrides,
  } as unknown as Episode;
}

interface Harness {
  host: FliksHostImpl;
  mediaRepo: ReturnType<typeof fakeRepo>;
  seasonRepo: ReturnType<typeof fakeRepo>;
  episodeRepo: ReturnType<typeof fakeRepo>;
  mediaFileRepo: ReturnType<typeof fakeRepo>;
  pluginRegistrationRepo: ReturnType<typeof fakeRepo>;
  notifications: { dispatch: jest.Mock; dispatchStrict: jest.Mock };
  settings: { get: jest.Mock; getAll: jest.Mock; set: jest.Mock };
  events: {
    emit: jest.Mock;
    emitToUsers: jest.Mock;
    emitDomain: jest.Mock;
    emitRaw: jest.Mock;
  };
  sseAudience: { recipientsForMedia: jest.Mock; viewersForMedia: jest.Mock };
  countsCache: PluginCountsCacheService;
  progressCache: { current: jest.Mock };
}

function makeHarness(pluginId: string | null = 'test.plugin'): Harness {
  const mediaRepo = fakeRepo();
  const seasonRepo = fakeRepo();
  const episodeRepo = fakeRepo();
  const mediaFileRepo = fakeRepo();
  const pluginRegistrationRepo = fakeRepo();
  const notifications = { dispatch: jest.fn(), dispatchStrict: jest.fn() };
  const settings = {
    get: jest.fn().mockResolvedValue(null),
    getAll: jest.fn().mockResolvedValue({}),
    set: jest.fn(),
  };
  const events = {
    emit: jest.fn(),
    emitToUsers: jest.fn(),
    emitDomain: jest.fn(),
    emitRaw: jest.fn(),
  };
  const sseAudience = {
    recipientsForMedia: jest.fn().mockResolvedValue([9]),
    viewersForMedia: jest.fn().mockResolvedValue([9]),
  };
  const countsCache = new PluginCountsCacheService();
  const progressCache = { current: jest.fn().mockResolvedValue(undefined) };

  // Fakes stand in for the constructor params — a plain unit test of the class,
  // not a DI-resolved instance (the DI graph itself is proven by the boot check).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const host = new (FliksHostImpl as any)(
    pluginId,
    mediaRepo,
    seasonRepo,
    episodeRepo,
    mediaFileRepo,
    pluginRegistrationRepo,
    notifications,
    settings,
    events,
    sseAudience,
    countsCache,
    progressCache,
  ) as FliksHostImpl;

  return {
    host,
    countsCache,
    progressCache,
    mediaRepo,
    seasonRepo,
    episodeRepo,
    mediaFileRepo,
    pluginRegistrationRepo,
    notifications,
    settings,
    events,
    sseAudience,
  };
}

describe('FliksHostImpl', () => {
  // ===========================================================================
  // A1 — media.acquisitionContext
  // ===========================================================================

  // ===========================================================================
  // A2 — acquisition.candidates
  // ===========================================================================

  // ===========================================================================
  // A3 — releases.match
  // ===========================================================================

  // ===========================================================================
  // A4 — releases.score
  // ===========================================================================

  // ===========================================================================
  // A5 — media.resolve
  // ===========================================================================

  describe('requests.markInProgress', () => {
    it('publishes acquisition.grabbed for fliks-server to read', async () => {
      const { host, events } = makeHarness();
      await expect(
        host['requests.markInProgress']({
          idempotencyKey: 'k',
          mediaId: 5,
          seasonNumber: 2,
        }),
      ).resolves.toBeUndefined();
      expect(events.emitDomain).toHaveBeenCalledWith({
        type: 'acquisition.grabbed',
        mediaId: 5,
        seasonNumber: 2,
      });
    });
  });

  describe('media.resolve', () => {
    it('resolves media/season/episode ids under prefixed keys', async () => {
      const h = makeHarness();
      const media = makeMedia({ id: 5, library: { id: 7, path: '/lib' } });
      const season = makeSeason({ id: 50, media });
      const episode = makeEpisode({ id: 500, season, episodeNumber: 3 });
      h.mediaRepo.find.mockResolvedValue([media]);
      h.seasonRepo.find.mockResolvedValue([season]);
      h.episodeRepo.find.mockResolvedValue([episode]);

      const result = await h.host['media.resolve']({
        mediaIds: [5],
        seasonIds: [50],
        episodeIds: [500],
      });
      expect(Object.keys(result).sort()).toEqual([
        'episode:500',
        'media:5',
        'season:50',
      ]);
      expect(result['episode:500'].episodeNumber).toBe(3);
      expectJsonSafe(result);
    });

    it('refuses a batch bigger than the queue page bound', async () => {
      const h = makeHarness();
      const mediaIds = Array.from({ length: 101 }, (_, i) => i + 1);
      await expect(h.host['media.resolve']({ mediaIds })).rejects.toThrow(
        /limit/,
      );
    });
  });

  // ===========================================================================
  // A6 — media.exists
  // ===========================================================================

  describe('media.exists', () => {
    it('returns only the ids that exist', async () => {
      const h = makeHarness();
      h.mediaRepo.find.mockResolvedValue([{ id: 2 }, { id: 3 }]);
      const result = await h.host['media.exists']({ mediaIds: [1, 2, 3] });
      expect(result).toEqual([2, 3]);
      expectJsonSafe(result);
    });

    it('short-circuits on an empty input without querying', async () => {
      const h = makeHarness();
      const result = await h.host['media.exists']({ mediaIds: [] });
      expect(result).toEqual([]);
      expect(h.mediaRepo.find).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // B1 — requests.markInProgress
  // ===========================================================================

  // ===========================================================================
  // C1 — library.ingest
  // ===========================================================================

  // ===========================================================================
  // D1 — events.publish
  // ===========================================================================

  describe('events.publish', () => {
    it('emits only the domain event for acquisition.grabbed — no direct call site emits queue.updated', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia());
      await h.host['events.publish']([
        { type: 'acquisition.grabbed', mediaId: 1, seasonNumber: 4, episodeNumber: 8 },
      ]);
      expect(h.events.emitDomain).toHaveBeenCalledWith({
        type: 'acquisition.grabbed',
        mediaId: 1,
        seasonNumber: 4,
        episodeNumber: 8,
      });
      expect(h.events.emit).not.toHaveBeenCalled();
    });

    // The badge has to come up on the grab: the acquisition plugin's own poll
    // can be a minute out, and a direct grab matches no request, so nothing
    // else would speak for it.
    // The optimistic badge extends the media's last known set instead of replacing it. A push
    // states the whole set, so stating this grab alone would retire every other download the
    // media has in flight — the exact failure the snapshot shape exists to prevent.
    it('VERDICT: a grab keeps the downloads the media already had in flight', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia({ type: MediaType.SERIES }));
      await h.host['progress.set']({
        mediaId: 1,
        downloads: [{ ref: 'live', seasonNumber: 4, episodeNumber: 1, progress: 0.3, state: 'active' }],
      });
      h.progressCache.current.mockResolvedValue(h.events.emitToUsers.mock.calls[0][1]);
      h.events.emitToUsers.mockClear();

      await h.host['events.publish']([
        { type: 'acquisition.grabbed', mediaId: 1, seasonNumber: 4, episodeNumber: 8 },
      ]);

      const refs = h.events.emitToUsers.mock.calls[0][1].downloads.map((d: { ref: string }) => d.ref);
      expect(refs).toEqual(['live', 'pending:4:8']);
    });

    it('pushes a queued 0% for the grabbed scope so the badge appears at once', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia());
      await h.host['events.publish']([
        { type: 'acquisition.grabbed', mediaId: 1, seasonNumber: 4, episodeNumber: 8 },
      ]);
      expect(h.events.emitToUsers).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          type: 'download.progress',
          mediaId: 1,
          downloads: [
            expect.objectContaining({ seasonNumber: 4, episodeNumber: 8, progress: 0, state: 'queued' }),
          ],
        }),
      );
    });

    it('handles a batched queue.changed', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia());
      await h.host['events.publish']([{ type: 'acquisition.queue.changed' }]);
      expect(h.events.emit).toHaveBeenCalledWith({ type: 'queue.updated' });
    });
  });

  // ===========================================================================
  // D2 — notifications.dispatch
  // ===========================================================================

  describe('notifications.dispatch', () => {
    it('forwards to NotificationsService with the closed event name', async () => {
      const h = makeHarness();
      await h.host['notifications.dispatch']({
        event: 'grab.started',
        payload: { title: 'x' },
      });
      expect(h.notifications.dispatchStrict).toHaveBeenCalledWith(
        'grab.started',
        { title: 'x' },
      );
    });
  });

  // ===========================================================================
  // D3 — counts.set
  // ===========================================================================

  describe('counts.set', () => {
    it('is readable back through the push cache, and reports 0 for an unset key', async () => {
      const h = makeHarness();
      expect(h.countsCache.get('queueActive')).toBe(0);
      const result = await h.host['counts.set']({
        key: 'queueActive',
        value: 4,
      });
      expect(h.countsCache.get('queueActive')).toBe(4);
      expect(result).toBeUndefined();
    });
  });

  // ===========================================================================
  // D4 — events.emitOwn
  // ===========================================================================

  describe('events.emitOwn', () => {
    it('force-prefixes the type with the bound plugin id for a broadcast', async () => {
      const h = makeHarness('acme.tool');
      await h.host['events.emitOwn']({
        type: 'sync.finished',
        payload: { n: 3 },
        audience: 'all',
      });
      expect(h.events.emitRaw).toHaveBeenCalledWith(
        'plugin.acme.tool.sync.finished',
        { n: 3 },
        null,
      );
    });

    it('resolves a media-scoped audience instead of broadcasting', async () => {
      const h = makeHarness('acme.tool');
      await h.host['events.emitOwn']({
        type: 'x',
        payload: null,
        audience: { mediaId: 1 },
      });
      expect(h.sseAudience.recipientsForMedia).toHaveBeenCalledWith(1);
      expect(h.events.emitRaw).toHaveBeenCalledWith(
        'plugin.acme.tool.x',
        null,
        [9],
      );
    });

    it('delivers a user-scoped audience to that account alone', async () => {
      const h = makeHarness('acme.tool');
      await h.host['events.emitOwn']({
        type: 'search.partial',
        payload: { n: 1 },
        audience: { userId: 42 },
      });
      expect(h.events.emitRaw).toHaveBeenCalledWith(
        'plugin.acme.tool.search.partial',
        { n: 1 },
        [42],
      );
    });

    // A user-scoped emit that fell through to recipientsForMedia would answer the
    // media's requesters instead of the account that asked — the exact leak this
    // audience exists to avoid.
    it('never resolves a media audience for a user-scoped emit', async () => {
      const h = makeHarness('acme.tool');
      await h.host['events.emitOwn']({
        type: 'x',
        payload: null,
        audience: { userId: 7 },
      });
      expect(h.sseAudience.recipientsForMedia).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // D5 — progress.set
  // ===========================================================================

  describe('progress.set', () => {
    it('emits the reserved download.progress SSE type to the resolved audience', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(
        makeMedia({ type: MediaType.SERIES }),
      );
      await h.host['progress.set']({
        mediaId: 1,
        downloads: [
          { ref: 'torrent-hash', seasonNumber: 1, episodeNumber: 2, progress: 0.42, bytesPerSecond: 1000, state: 'active' },
        ],
      });
      expect(h.events.emitToUsers).toHaveBeenCalledWith(
        [9],
        expect.objectContaining({
          type: 'download.progress',
          mediaType: 'series',
          downloads: [
            expect.objectContaining({ ref: 'torrent-hash', progress: 0.42, dlspeed: 1000 }),
          ],
        }),
      );
    });

    // Coalescing per media loses nothing now: a push already carries the media's whole set, so
    // the last one in a window states every sibling the earlier ones did.
    it('VERDICT: one emission carries every download of the media', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia({ type: MediaType.SERIES }));

      await h.host['progress.set']({
        mediaId: 7,
        downloads: [
          { ref: 'a', seasonNumber: 1, episodeNumber: 6, progress: 0.1, state: 'active' },
          { ref: 'b', seasonNumber: 1, episodeNumber: 7, progress: 0.2, state: 'active' },
          { ref: 'c', seasonNumber: 1, episodeNumber: 8, progress: 0.3, state: 'active' },
        ],
      });

      expect(h.events.emitToUsers).toHaveBeenCalledTimes(1);
      expect(h.events.emitToUsers.mock.calls[0][1].downloads.map((d: { ref: string }) => d.ref)).toEqual(['a', 'b', 'c']);
    });

    it('coalesces to one emission per media per second, and the trailing one carries the latest', async () => {
      jest.useFakeTimers();
      try {
        const h = makeHarness();
        h.mediaRepo.findOne.mockResolvedValue(makeMedia({ type: MediaType.SERIES }));
        const push = (progress: number) =>
          h.host['progress.set']({ mediaId: 7, downloads: [{ ref: 'r', progress, state: 'active' }] });

        await push(0.1);
        await push(0.2);
        await push(0.3);
        expect(h.events.emitToUsers).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1_000);
        expect(h.events.emitToUsers).toHaveBeenCalledTimes(2);
        expect(h.events.emitToUsers).toHaveBeenLastCalledWith(
          [9],
          expect.objectContaining({ downloads: [expect.objectContaining({ progress: 0.3 })] }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not hold one media behind another', async () => {
      jest.useFakeTimers();
      try {
        const h = makeHarness();
        h.mediaRepo.findOne.mockResolvedValue(makeMedia({ type: MediaType.SERIES }));
        await h.host['progress.set']({ mediaId: 1, downloads: [{ ref: 'r', progress: 0.1, state: 'active' }] });
        await h.host['progress.set']({ mediaId: 2, downloads: [{ ref: 'r', progress: 0.1, state: 'active' }] });
        expect(h.events.emitToUsers).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('emits nothing when the audience is empty', async () => {
      const h = makeHarness();
      h.sseAudience.viewersForMedia.mockResolvedValue([]);
      await h.host['progress.set']({
        mediaId: 1,
        downloads: [{ ref: 'r', progress: 0.1, state: 'active' }],
      });
      expect(h.events.emitToUsers).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // E1 — config.get
  // ===========================================================================

  describe('config.get', () => {
    it('reads only under the plugin.<id>. prefix and strips it back off', async () => {
      const h = makeHarness('acme.tool');
      h.settings.getAll.mockResolvedValue({
        'plugin.acme.tool.rssSyncInterval': '15',
        'plugin.other.plugin.secret': 'nope',
        naming_movie_format: 'x',
      });
      const result = await h.host['config.get']({});
      expect(result).toEqual({ rssSyncInterval: '15' });
      expectJsonSafe(result);
    });

    it('reads individually requested keys', async () => {
      const h = makeHarness('acme.tool');
      h.settings.get.mockImplementation((k: string) =>
        Promise.resolve(k === 'plugin.acme.tool.foo' ? 'bar' : null),
      );
      const result = await h.host['config.get']({ keys: ['foo', 'missing'] });
      expect(result).toEqual({ foo: 'bar' });
      expectJsonSafe(result);
    });
  });

  // ===========================================================================
  // E2 — config.set
  // ===========================================================================

  describe('config.set', () => {
    it('writes under the derived prefix, never a bare key', async () => {
      const h = makeHarness('acme.tool');
      await h.host['config.set']({ key: 'foo', value: 'bar' });
      // The third argument is the writer: it stops the config note echoing back to this plugin.
      expect(h.settings.set).toHaveBeenCalledWith(
        'plugin.acme.tool.foo',
        'bar',
        'acme.tool',
      );
    });
  });
});

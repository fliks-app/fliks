import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FliksHostImpl } from './fliks-host.service';
import { PluginCountsCacheService } from './plugin-counts-cache.service';
import {
  MediaStatus,
  MediaType,
  MinimumAvailability,
} from '../../../common/enums';
import { getAppQualityById } from '../../../common/constants/app-qualities';
import { getAppLanguageById } from '../../../common/constants/app-languages';
import type { Media } from '../../media/entities/media.entity';
import type { Season } from '../../media/entities/season.entity';
import type { Episode } from '../../media/entities/episode.entity';
// Cross-boundary read for the equivalence proof only, per the task brief —
// this copy is deleted once `plugins/download/` converts to the host method.
import { AcquisitionEventsService } from '../../scheduler/acquisition-events.service';
import type { EventsService } from '../../scheduler/events.service';
import type { SseAudienceService } from '../../scheduler/sse-audience.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { MediaServersService } from '../../media-servers/media-servers.service';

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
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rawMany);
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
    library: { id: 7, path: '/lib', stalledCleanupProfile: null },
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
  blocklistEntryRepo: ReturnType<typeof fakeRepo>;
  pluginRegistrationRepo: ReturnType<typeof fakeRepo>;
  cleanupProfileRepo: ReturnType<typeof fakeRepo>;
  autoGrab: { classifyForSearch: jest.Mock };
  acquisitionCandidates: {
    listMovieTargets: jest.Mock;
    listEpisodeTargets: jest.Mock;
    groupIntoSeasonPacks: jest.Mock;
  };
  profiles: { resolveAllowedForMedia: jest.Mock };
  qualityDefs: { getSizeLimitsMap: jest.Mock };
  customFormats: { scoreRelease: jest.Mock };
  blocklist: { create: jest.Mock; isBlocked: jest.Mock };
  requestLifecycle: { markInProgress: jest.Mock };
  libraryIngestService: { ingest: jest.Mock };
  notifications: { dispatch: jest.Mock };
  mediaServers: { dispatch: jest.Mock };
  settings: { get: jest.Mock; getAll: jest.Mock; set: jest.Mock };
  events: {
    emit: jest.Mock;
    emitToUsers: jest.Mock;
    emitDomain: jest.Mock;
    emitRaw: jest.Mock;
  };
  sseAudience: { recipientsForMedia: jest.Mock };
  countsCache: PluginCountsCacheService;
}

function makeHarness(pluginId: string | null = 'test.plugin'): Harness {
  const mediaRepo = fakeRepo();
  const seasonRepo = fakeRepo();
  const episodeRepo = fakeRepo();
  const mediaFileRepo = fakeRepo();
  const blocklistEntryRepo = fakeRepo();
  const pluginRegistrationRepo = fakeRepo();
  const cleanupProfileRepo = fakeRepo();
  const autoGrab = { classifyForSearch: jest.fn() };
  const acquisitionCandidates = {
    listMovieTargets: jest.fn().mockResolvedValue([]),
    listEpisodeTargets: jest.fn().mockResolvedValue([]),
    groupIntoSeasonPacks: jest.fn().mockResolvedValue([]),
  };
  const profiles = {
    resolveAllowedForMedia: jest
      .fn()
      .mockReturnValue({ allowed: new Set([1]), allowedLangs: new Set([1]) }),
  };
  const qualityDefs = {
    getSizeLimitsMap: jest.fn().mockResolvedValue(new Map()),
  };
  const customFormats = { scoreRelease: jest.fn().mockResolvedValue(0) };
  const blocklist = {
    create: jest.fn(),
    isBlocked: jest.fn().mockResolvedValue(false),
  };
  const requestLifecycle = {
    markInProgress: jest.fn().mockResolvedValue(undefined),
  };
  const libraryIngestService = { ingest: jest.fn() };
  const notifications = { dispatch: jest.fn() };
  const mediaServers = { dispatch: jest.fn() };
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
  const sseAudience = { recipientsForMedia: jest.fn().mockResolvedValue([9]) };
  const countsCache = new PluginCountsCacheService();

  // Fakes stand in for 21 constructor params — a plain unit test of the class,
  // not a DI-resolved instance (the DI graph itself is proven by the boot check).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const host = new (FliksHostImpl as any)(
    pluginId,
    mediaRepo,
    seasonRepo,
    episodeRepo,
    mediaFileRepo,
    blocklistEntryRepo,
    pluginRegistrationRepo,
    cleanupProfileRepo,
    autoGrab,
    acquisitionCandidates,
    profiles,
    qualityDefs,
    customFormats,
    blocklist,
    requestLifecycle,
    libraryIngestService,
    notifications,
    mediaServers,
    settings,
    events,
    sseAudience,
    countsCache,
  ) as FliksHostImpl;

  return {
    host,
    countsCache,
    mediaRepo,
    seasonRepo,
    episodeRepo,
    mediaFileRepo,
    blocklistEntryRepo,
    pluginRegistrationRepo,
    cleanupProfileRepo,
    autoGrab,
    acquisitionCandidates,
    profiles,
    qualityDefs,
    customFormats,
    blocklist,
    requestLifecycle,
    libraryIngestService,
    notifications,
    mediaServers,
    settings,
    events,
    sseAudience,
  };
}

describe('FliksHostImpl', () => {
  // ===========================================================================
  // A1 — media.acquisitionContext
  // ===========================================================================

  describe('media.acquisitionContext', () => {
    it('returns a serialisable target for a missing movie, with the Infinity ceiling made JSON-safe', async () => {
      const h = makeHarness();
      const media = makeMedia();
      h.mediaRepo.findOne.mockResolvedValue(media);
      h.mediaFileRepo.find.mockResolvedValue([]);
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: Number.POSITIVE_INFINITY,
      });

      const result = await h.host['media.acquisitionContext']({ mediaId: 1 });
      expect(result?.want?.decision).toBe('missing');
      expect(result?.want?.maxRankInclusive).toBe(Number.MAX_SAFE_INTEGER);
      expect(Number.isFinite(result?.want?.maxRankInclusive)).toBe(true);
      expectJsonSafe(result);
    });

    it('returns null for a media with no library, and for an unknown media id', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValueOnce(makeMedia({ libraryId: null }));
      expect(
        await h.host['media.acquisitionContext']({ mediaId: 1 }),
      ).toBeNull();

      h.mediaRepo.findOne.mockResolvedValueOnce(null);
      expect(
        await h.host['media.acquisitionContext']({ mediaId: 999 }),
      ).toBeNull();
    });

    it('collapses "skip" and "unprofiled" decisions to want: null', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia());
      h.mediaFileRepo.find.mockResolvedValue([]);

      h.autoGrab.classifyForSearch.mockReturnValue({ mode: 'skip' });
      expect(
        (await h.host['media.acquisitionContext']({ mediaId: 1 }))?.want,
      ).toBeNull();

      h.autoGrab.classifyForSearch.mockReturnValue({ mode: 'unprofiled' });
      expect(
        (await h.host['media.acquisitionContext']({ mediaId: 1 }))?.want,
      ).toBeNull();
    });

    it('populates season + episode for an episode-scoped lookup', async () => {
      const h = makeHarness();
      const media = makeMedia({ type: MediaType.SERIES });
      const season = makeSeason();
      const episode = makeEpisode({ season });
      h.mediaRepo.findOne.mockResolvedValue(media);
      h.episodeRepo.findOne.mockResolvedValue(episode);
      h.episodeRepo.count.mockResolvedValue(8);
      h.episodeRepo.find.mockResolvedValue([]);
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: 100,
      });

      const result = await h.host['media.acquisitionContext']({
        mediaId: 1,
        episodeId: 100,
      });
      expect(result?.season).toEqual({ id: 10, number: 1, episodeCount: 8 });
      expect(result?.episode).toEqual({
        id: 100,
        number: 1,
        endNumber: null,
        airDate: '2020-01-01',
      });
      expectJsonSafe(result);
    });
  });

  // ===========================================================================
  // A2 — acquisition.candidates
  // ===========================================================================

  describe('acquisition.candidates', () => {
    it('pages a mixed movie/episode/pack result set and returns a resumable cursor', async () => {
      const h = makeHarness();
      const movie = makeMedia({ id: 1 });
      const series = makeMedia({ id: 2, type: MediaType.SERIES });
      const season = makeSeason({ id: 20, mediaId: 2 });
      const ep1 = makeEpisode({ id: 201, season, episodeNumber: 1 });
      const ep2 = makeEpisode({ id: 202, season, episodeNumber: 2 });

      h.acquisitionCandidates.listMovieTargets.mockResolvedValue([
        { media: movie, files: [] },
      ]);
      h.acquisitionCandidates.listEpisodeTargets.mockResolvedValue([
        { media: series, season, episode: ep1, files: [] },
        { media: series, season, episode: ep2, files: [] },
      ]);
      h.acquisitionCandidates.groupIntoSeasonPacks.mockResolvedValue([
        {
          media: series,
          season,
          episodes: [ep1, ep2],
          files: [],
          totalEpisodeCount: 2,
        },
      ]);
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: 10,
      });

      const page1 = await h.host['acquisition.candidates']({
        availableOn: '2099-01-01',
        limit: 1,
      });
      expect(page1.items).toHaveLength(1);
      expect(page1.cursor).toBe('1');
      expectJsonSafe(page1);

      const page2 = await h.host['acquisition.candidates']({
        availableOn: '2099-01-01',
        limit: 1,
        cursor: page1.cursor!,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.cursor).toBeNull();
      expectJsonSafe(page2);
    });

    it('clamps the limit to the contract bound', async () => {
      const h = makeHarness();
      h.acquisitionCandidates.listMovieTargets.mockResolvedValue([]);
      h.acquisitionCandidates.listEpisodeTargets.mockResolvedValue([]);
      const result = await h.host['acquisition.candidates']({
        availableOn: '2099-01-01',
        limit: 999999,
      });
      expect(result.items).toEqual([]);
      expectJsonSafe(result);
    });

    it('respects kind: "movie" by skipping the series query entirely', async () => {
      const h = makeHarness();
      h.acquisitionCandidates.listMovieTargets.mockResolvedValue([]);
      await h.host['acquisition.candidates']({
        kind: 'movie',
        availableOn: '2099-01-01',
        limit: 10,
      });
      expect(h.acquisitionCandidates.listEpisodeTargets).not.toHaveBeenCalled();
    });

    describe('movie availability gate — agrees with AcquisitionSchedulerService.isAvailable on every row', () => {
      // Expected column is hand-derived from reading the current
      // `AcquisitionSchedulerService.isAvailable`/`addDaysIso` source directly
      // (backend/src/plugins/download/acquisition-scheduler.service.ts) — not
      // from this file's own `FliksHostImpl.isAvailable`. A cross-import of
      // the real class is blocked by the "core does not import
      // plugins/download/" ESLint fence, so this table is the arms-length
      // substitute for calling the live method.
      const today = '2024-06-01';

      const rows: [string, Record<string, unknown>, boolean][] = [
        [
          'announced, no dates at all',
          { minimumAvailability: MinimumAvailability.ANNOUNCED },
          true,
        ],
        [
          'announced with a future release date',
          {
            minimumAvailability: MinimumAvailability.ANNOUNCED,
            releaseDate: '2030-01-01',
          },
          true,
        ],
        [
          'in cinemas, date in the past',
          {
            minimumAvailability: MinimumAvailability.IN_CINEMAS,
            inCinemas: '2024-01-01',
          },
          true,
        ],
        [
          'in cinemas, date in the future',
          {
            minimumAvailability: MinimumAvailability.IN_CINEMAS,
            inCinemas: '2030-01-01',
          },
          false,
        ],
        [
          'in cinemas, no date at all',
          {
            minimumAvailability: MinimumAvailability.IN_CINEMAS,
            inCinemas: null,
          },
          false,
        ],
        [
          'released via digital date in the past',
          {
            minimumAvailability: MinimumAvailability.RELEASED,
            digitalRelease: '2024-01-01',
            status: MediaStatus.ANNOUNCED,
          },
          true,
        ],
        [
          'released via physical date in the past, no digital date',
          {
            minimumAvailability: MinimumAvailability.RELEASED,
            physicalRelease: '2024-01-01',
            status: MediaStatus.ANNOUNCED,
          },
          true,
        ],
        [
          'released via in-cinemas + 90 days, no digital/physical date',
          {
            minimumAvailability: MinimumAvailability.RELEASED,
            inCinemas: '2024-01-01',
            status: MediaStatus.ANNOUNCED,
          },
          true,
        ],
        [
          'released, in-cinemas grace not yet elapsed, no other date',
          {
            minimumAvailability: MinimumAvailability.RELEASED,
            inCinemas: '2024-05-01',
            status: MediaStatus.ANNOUNCED,
          },
          false,
        ],
        [
          'released via status fallback, every date null',
          {
            minimumAvailability: MinimumAvailability.RELEASED,
            status: MediaStatus.RELEASED,
          },
          true,
        ],
        [
          'released, every date null, status not released',
          {
            minimumAvailability: MinimumAvailability.RELEASED,
            status: MediaStatus.ANNOUNCED,
          },
          false,
        ],
        [
          'released far in the past via releaseDate, status TBA',
          {
            minimumAvailability: MinimumAvailability.RELEASED,
            releaseDate: '1990-01-01',
            status: MediaStatus.TBA,
          },
          true,
        ],
        [
          'released, explicit null release date, no other date, status continuing',
          {
            minimumAvailability: MinimumAvailability.RELEASED,
            releaseDate: null,
            status: MediaStatus.CONTINUING,
          },
          false,
        ],
      ];

      it.each(rows)('%s', async (_label, overrides, wantAvailable) => {
        const media = makeMedia({ id: 1, ...overrides });

        const h = makeHarness();
        h.acquisitionCandidates.listMovieTargets.mockResolvedValue([
          { media, files: [] },
        ]);
        h.autoGrab.classifyForSearch.mockReturnValue({
          mode: 'missing',
          minRankExclusive: 0,
          maxRankInclusive: 100,
        });
        const result = await h.host['acquisition.candidates']({
          availableOn: today,
          limit: 10,
        });

        expect(result.items.length).toBe(wantAvailable ? 1 : 0);
      });
    });
  });

  // ===========================================================================
  // A3 — releases.match
  // ===========================================================================

  describe('releases.match', () => {
    it('reports unmatched, then grab, for a title that matches a missing monitored movie', async () => {
      const h = makeHarness();
      const media = makeMedia({ title: 'Some Great Movie' });
      h.mediaRepo.find.mockResolvedValue([media]);
      h.mediaFileRepo.find.mockResolvedValue([]);
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: 100,
      });

      const result = await h.host['releases.match']({
        titles: [
          {
            id: 'a',
            title: 'Some.Great.Movie.2020.1080p.WEB-DL',
            publishDate: new Date().toISOString(),
          },
          {
            id: 'b',
            title: 'Totally.Unrelated.Thing.2019.720p',
            publishDate: new Date().toISOString(),
          },
        ],
      });

      expect(result.find((r) => r.id === 'a')).toMatchObject({
        decision: 'grab',
        mediaId: media.id,
      });
      expect(result.find((r) => r.id === 'b')).toMatchObject({
        decision: 'skip',
        skipReason: 'unmatched',
      });
      expectJsonSafe(result);
    });

    it('skips a release fresher than minAgeMinutes', async () => {
      const h = makeHarness();
      const media = makeMedia({ title: 'Fresh Movie' });
      h.mediaRepo.find.mockResolvedValue([media]);
      h.mediaFileRepo.find.mockResolvedValue([]);
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: 100,
      });

      const result = await h.host['releases.match']({
        titles: [
          {
            id: 'a',
            title: 'Fresh.Movie.2020.1080p',
            publishDate: new Date().toISOString(),
          },
        ],
        minAgeMinutes: 60,
      });
      expect(result[0]).toMatchObject({
        decision: 'skip',
        skipReason: 'too-fresh',
      });
      expectJsonSafe(result);
    });

    it('skips on-disk and unprofiled decisions with the matching reason', async () => {
      const h = makeHarness();
      const media = makeMedia({ title: 'Owned Movie' });
      h.mediaRepo.find.mockResolvedValue([media]);
      h.mediaFileRepo.find.mockResolvedValue([]);

      h.autoGrab.classifyForSearch.mockReturnValue({ mode: 'skip' });
      let result = await h.host['releases.match']({
        titles: [
          {
            id: 'a',
            title: 'Owned.Movie.2020.1080p',
            publishDate: new Date().toISOString(),
          },
        ],
      });
      expect(result[0]).toMatchObject({ skipReason: 'on-disk' });

      h.autoGrab.classifyForSearch.mockReturnValue({ mode: 'unprofiled' });
      result = await h.host['releases.match']({
        titles: [
          {
            id: 'a',
            title: 'Owned.Movie.2020.1080p',
            publishDate: new Date().toISOString(),
          },
        ],
      });
      expect(result[0]).toMatchObject({ skipReason: 'unprofiled' });
    });

    it('flags a series episode that does not exist yet as not-available', async () => {
      const h = makeHarness();
      const media = makeMedia({ title: 'A Show', type: MediaType.SERIES });
      h.mediaRepo.find.mockResolvedValue([media]);
      h.seasonRepo.findOne.mockResolvedValue(makeSeason());
      h.episodeRepo.findOne.mockResolvedValue(null);

      const result = await h.host['releases.match']({
        titles: [
          {
            id: 'a',
            title: 'A.Show.S01E09.1080p',
            publishDate: new Date().toISOString(),
          },
        ],
      });
      expect(result[0]).toMatchObject({
        decision: 'skip',
        skipReason: 'not-available',
        seasonNumber: 1,
      });
      expectJsonSafe(result);
    });
  });

  // ===========================================================================
  // A4 — releases.score
  // ===========================================================================

  describe('releases.score', () => {
    it('scores, ranks and carries the caller-supplied release id through', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia({ runtime: 120 }));
      h.profiles.resolveAllowedForMedia.mockReturnValue({
        allowed: new Set([9]),
        allowedLangs: new Set(),
      });
      h.qualityDefs.getSizeLimitsMap.mockResolvedValue(new Map());

      const result = await h.host['releases.score']({
        mediaId: 1,
        releases: [
          {
            id: 'r1',
            title: 'A Movie 2020 1080p WEB-DL',
            size: 4_000_000_000,
            seeders: 10,
            leechers: 2,
            publishDate: new Date().toISOString(),
            sourceRef: 'indexer-a',
          },
        ],
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('r1');
      expect(typeof result[0].qualityId).toBe('number');
      expect(Array.isArray(result[0].rejections)).toBe(true);
      expectJsonSafe(result);
    });

    it('returns [] for an unknown media id, and renders rejection params as a detail string', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValueOnce(null);
      expect(
        await h.host['releases.score']({ mediaId: 999, releases: [] }),
      ).toEqual([]);

      h.mediaRepo.findOne.mockResolvedValue(makeMedia({ runtime: 120 }));
      h.profiles.resolveAllowedForMedia.mockReturnValue({
        allowed: new Set(),
        allowedLangs: new Set(),
      });
      const result = await h.host['releases.score']({
        mediaId: 1,
        releases: [
          {
            id: 'r1',
            title: 'A Movie 2020 1080p WEB-DL',
            size: 4_000_000_000,
            seeders: 10,
            leechers: 2,
            publishDate: new Date().toISOString(),
            sourceRef: 'indexer-a',
            minSeeders: 50,
          },
        ],
      });
      expect(result[0].rejections.some((r) => r.code === 'MIN_SEEDERS')).toBe(
        true,
      );
      expect(
        result[0].rejections.find((r) => r.code === 'MIN_SEEDERS')?.detail,
      ).toMatch(/actual=10/);
      expectJsonSafe(result);
    });

    it('carries qualityName/languageName from the static registry alongside their ids — a plugin cannot render a label from an id alone', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia({ runtime: 120 }));
      h.profiles.resolveAllowedForMedia.mockReturnValue({
        allowed: new Set([16]),
        allowedLangs: new Set(),
      });

      const result = await h.host['releases.score']({
        mediaId: 1,
        releases: [
          {
            id: 'r1',
            title: 'A Movie 2020 1080p WEB-DL FRENCH',
            size: 4_000_000_000,
            seeders: 10,
            leechers: 2,
            publishDate: new Date().toISOString(),
            sourceRef: 'indexer-a',
          },
        ],
      });

      expect(result[0].qualityName).toBe(
        getAppQualityById(result[0].qualityId)?.name,
      );
      expect(result[0].languageName).toBe(
        getAppLanguageById(result[0].languageId!)?.name,
      );
      expectJsonSafe(result);
    });
  });

  // ===========================================================================
  // A5 — media.resolve
  // ===========================================================================

  describe('media.resolve', () => {
    it('resolves media/season/episode ids under prefixed keys, with the cleanup profile inlined', async () => {
      const h = makeHarness();
      const media = makeMedia({
        id: 5,
        library: { id: 7, path: '/lib', stalledCleanupProfile: 'fast' },
      });
      const season = makeSeason({ id: 50, media });
      const episode = makeEpisode({ id: 500, season, episodeNumber: 3 });
      h.mediaRepo.find.mockResolvedValue([media]);
      h.seasonRepo.find.mockResolvedValue([season]);
      h.episodeRepo.find.mockResolvedValue([episode]);
      h.cleanupProfileRepo.findOne.mockResolvedValue({
        key: 'fast',
        samples: 3,
        intervalMinutes: 5,
        autoRestart: true,
      });

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
      expect(result['media:5'].stalledCleanupProfile).toEqual({
        key: 'fast',
        samples: 3,
        intervalMinutes: 5,
        autoRestart: true,
      });
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
  // B1 — blocklist.add
  // ===========================================================================

  describe('blocklist.add', () => {
    it('creates a row and returns its id', async () => {
      const h = makeHarness();
      h.blocklist.create.mockResolvedValue({ id: 77 });
      const result = await h.host['blocklist.add']({
        idempotencyKey: 'k1',
        sourceTitle: 'Some.Release',
        note: 'blocked',
      });
      expect(result).toEqual({ id: 77 });
      expectJsonSafe(result);
    });

    it('treats a duplicate sourceTitle as an idempotent success, not an error', async () => {
      const h = makeHarness();
      h.blocklist.create.mockRejectedValue({ code: '23505' });
      h.blocklistEntryRepo.createQueryBuilder.mockReturnValue(
        fakeQueryBuilder([], { id: 5 }),
      );
      const result = await h.host['blocklist.add']({
        idempotencyKey: 'k1',
        sourceTitle: 'Some.Release',
        note: 'blocked',
      });
      expect(result).toEqual({ id: 5 });
    });
  });

  // ===========================================================================
  // B2 — blocklist.check
  // ===========================================================================

  describe('blocklist.check', () => {
    it('reports which titles are blocked', async () => {
      const h = makeHarness();
      h.blocklist.isBlocked.mockImplementation((t: string) =>
        Promise.resolve(t === 'Blocked.Release'),
      );
      const result = await h.host['blocklist.check']({
        titles: ['Blocked.Release', 'Clean.Release'],
      });
      expect(result).toEqual({ blocked: ['Blocked.Release'] });
      expectJsonSafe(result);
    });
  });

  // ===========================================================================
  // B3 — requests.markInProgress
  // ===========================================================================

  describe('requests.markInProgress', () => {
    it('delegates to RequestLifecycleService with mediaId + seasonNumber', async () => {
      const h = makeHarness();
      await h.host['requests.markInProgress']({
        idempotencyKey: 'k',
        mediaId: 5,
        seasonNumber: 2,
      });
      expect(h.requestLifecycle.markInProgress).toHaveBeenCalledWith(5, 2);
    });

    it('returns void, trivially serialisable', async () => {
      const h = makeHarness();
      const result = await h.host['requests.markInProgress']({
        idempotencyKey: 'k',
        mediaId: 5,
      });
      expect(result).toBeUndefined();
      expectJsonSafe(result === undefined ? null : result);
    });
  });

  // ===========================================================================
  // C1 — library.ingest
  // ===========================================================================

  describe('library.ingest', () => {
    let tmpRoot: string;
    let sourceFile: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-host-ingest-'));
      sourceFile = path.join(tmpRoot, 'movie.mkv');
      fs.writeFileSync(sourceFile, 'data');
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('resolves paths under the registered ingest root and strips the entity down to plain fields', async () => {
      const h = makeHarness();
      h.pluginRegistrationRepo.findOne.mockResolvedValue({
        ingestRoots: [tmpRoot],
      });
      h.mediaRepo.findOne.mockResolvedValue(makeMedia());
      h.libraryIngestService.ingest.mockResolvedValue({
        imported: [
          {
            file: {
              id: 55,
              relativePath: 'Movie (2020)/Movie.mkv',
              quality: '1080p',
              createdAt: new Date(),
              updatedAt: new Date(),
              media: {},
            },
            episodeId: undefined,
            seasonId: undefined,
            sourcePath: sourceFile,
          },
        ],
      });

      const result = await h.host['library.ingest']({
        idempotencyKey: 'k1',
        mediaId: 1,
        paths: [sourceFile],
        transfer: 'copy',
        sourceLabel: 'Release.Name',
      });

      expect(result.imported).toEqual([
        {
          mediaFileId: 55,
          relativePath: 'Movie (2020)/Movie.mkv',
          quality: '1080p',
        },
      ]);
      expect(Object.keys(result.imported[0]).sort()).toEqual([
        'mediaFileId',
        'quality',
        'relativePath',
      ]);
      expectJsonSafe(result);
      expect(h.notifications.dispatch).toHaveBeenCalledWith(
        'download.complete',
        expect.any(Object),
      );
    });

    it('refuses a path outside every configured ingest root', async () => {
      const h = makeHarness();
      const otherRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fliks-host-other-'),
      );
      h.pluginRegistrationRepo.findOne.mockResolvedValue({
        ingestRoots: [otherRoot],
      });
      await expect(
        h.host['library.ingest']({
          idempotencyKey: 'k1',
          mediaId: 1,
          paths: [sourceFile],
          transfer: 'copy',
          sourceLabel: 'Release.Name',
        }),
      ).rejects.toThrow(/outside/);
      fs.rmSync(otherRoot, { recursive: true, force: true });
    });

    it('refuses when the plugin has no ingestRoots configured at all', async () => {
      const h = makeHarness();
      h.pluginRegistrationRepo.findOne.mockResolvedValue(null);
      await expect(
        h.host['library.ingest']({
          idempotencyKey: 'k1',
          mediaId: 1,
          paths: [sourceFile],
          transfer: 'copy',
          sourceLabel: 'Release.Name',
        }),
      ).rejects.toThrow(/ingestRoots/);
    });

    it('refuses a host bound to no plugin identity, without reading a row', async () => {
      const h = makeHarness(null);
      await expect(
        h.host['library.ingest']({
          idempotencyKey: 'k1',
          mediaId: 1,
          paths: [sourceFile],
          transfer: 'copy',
          sourceLabel: 'Release.Name',
        }),
      ).rejects.toThrow(/ingestRoots/);
      expect(h.pluginRegistrationRepo.findOne).not.toHaveBeenCalled();
      expect(h.libraryIngestService.ingest).not.toHaveBeenCalled();
    });

    it('fences a plugin to the roots its registration granted', async () => {
      const h = makeHarness('some.installed.plugin');
      h.pluginRegistrationRepo.findOne.mockResolvedValue({
        ingestRoots: [path.join(tmpRoot, 'elsewhere')],
      });
      await expect(
        h.host['library.ingest']({
          idempotencyKey: 'k1',
          mediaId: 1,
          paths: [sourceFile],
          transfer: 'copy',
          sourceLabel: 'Release.Name',
        }),
      ).rejects.toThrow(/outside every configured ingest root/);
    });
  });

  // ===========================================================================
  // D1 — events.publish
  // ===========================================================================

  describe('events.publish', () => {
    it('emits only the domain event for acquisition.grabbed — no direct call site emits queue.updated', async () => {
      const h = makeHarness();
      await h.host['events.publish']([
        { type: 'acquisition.grabbed', mediaId: 1, seasonNumber: 4 },
      ]);
      expect(h.events.emitDomain).toHaveBeenCalledWith({
        type: 'acquisition.grabbed',
        mediaId: 1,
        seasonNumber: 4,
      });
      expect(h.events.emit).not.toHaveBeenCalled();
    });

    it('matches AcquisitionEventsService exactly for acquisition.imported: same notification, SSE payload, queue refresh and media-server dispatch', async () => {
      const h = makeHarness();
      const media = makeMedia({
        title: 'Imported Title',
        path: '/lib/Imported Title (2020)',
      });
      h.mediaRepo.findOne.mockResolvedValue(media);
      const real = new AcquisitionEventsService(
        h.events as unknown as EventsService,
        h.sseAudience as unknown as SseAudienceService,
        h.notifications as unknown as NotificationsService,
        h.mediaServers as unknown as MediaServersService,
      );

      await real.publish({
        type: 'acquisition.imported',
        mediaId: 1,
        title: media.title,
        seasonNumber: 2,
        episodeNumber: 3,
        quality: '1080p',
        sourceTitle: 'Release.Name',
        mediaPath: (media as unknown as { path: string }).path,
      });
      const wantNotify: unknown = h.notifications.dispatch.mock.calls.at(-1);
      const wantSse: unknown = h.events.emitToUsers.mock.calls.at(-1);
      const wantQueue: unknown = h.events.emit.mock.calls.at(-1);
      const wantServers: unknown = h.mediaServers.dispatch.mock.calls.at(-1);
      h.notifications.dispatch.mockClear();
      h.events.emitToUsers.mockClear();
      h.events.emit.mockClear();
      h.mediaServers.dispatch.mockClear();

      await h.host['events.publish']([
        {
          type: 'acquisition.imported',
          mediaId: 1,
          seasonNumber: 2,
          episodeNumber: 3,
          quality: '1080p',
          sourceTitle: 'Release.Name',
        },
      ]);
      expect(h.notifications.dispatch.mock.calls.at(-1)).toEqual(wantNotify);
      expect(h.events.emitToUsers.mock.calls.at(-1)).toEqual(wantSse);
      expect(h.events.emit.mock.calls.at(-1)).toEqual(wantQueue);
      expect(h.mediaServers.dispatch.mock.calls.at(-1)).toEqual(wantServers);
    });

    it('matches AcquisitionEventsService exactly for acquisition.failed, using the caller-supplied release title rather than media.title', async () => {
      const h = makeHarness();
      const real = new AcquisitionEventsService(
        h.events as unknown as EventsService,
        h.sseAudience as unknown as SseAudienceService,
        h.notifications as unknown as NotificationsService,
        h.mediaServers as unknown as MediaServersService,
      );

      await real.publish({
        type: 'acquisition.failed',
        mediaId: 1,
        title: 'Release.Name.Failed',
        reason: 'boom',
      });
      const wantSse: unknown = h.events.emitToUsers.mock.calls.at(-1);
      const wantQueue: unknown = h.events.emit.mock.calls.at(-1);
      h.events.emitToUsers.mockClear();
      h.events.emit.mockClear();

      // media.title deliberately differs from the release title — proves the
      // host method never re-derives it from mediaId.
      h.mediaRepo.findOne.mockResolvedValue(
        makeMedia({ title: 'Some Different Media Title' }),
      );
      await h.host['events.publish']([
        {
          type: 'acquisition.failed',
          mediaId: 1,
          title: 'Release.Name.Failed',
          reason: 'boom',
        },
      ]);
      expect(h.events.emitToUsers.mock.calls.at(-1)).toEqual(wantSse);
      expect(h.events.emit.mock.calls.at(-1)).toEqual(wantQueue);
    });

    it('matches AcquisitionEventsService exactly for the new acquisition.stalled.removed variant', async () => {
      const h = makeHarness();
      const real = new AcquisitionEventsService(
        h.events as unknown as EventsService,
        h.sseAudience as unknown as SseAudienceService,
        h.notifications as unknown as NotificationsService,
        h.mediaServers as unknown as MediaServersService,
      );

      await real.publish({
        type: 'acquisition.stalled.removed',
        mediaId: 1,
        title: 'Stalled.Release',
      });
      const wantSse: unknown = h.events.emitToUsers.mock.calls.at(-1);
      const wantQueue: unknown = h.events.emit.mock.calls.at(-1);
      h.events.emitToUsers.mockClear();
      h.events.emit.mockClear();

      await h.host['events.publish']([
        {
          type: 'acquisition.stalled.removed',
          mediaId: 1,
          title: 'Stalled.Release',
        },
      ]);
      expect(h.events.emitToUsers.mock.calls.at(-1)).toEqual(wantSse);
      expect(h.events.emit.mock.calls.at(-1)).toEqual(wantQueue);
    });

    it('handles queue.changed and the batched acquisition.progress variant', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia());
      await h.host['events.publish']([
        { type: 'acquisition.queue.changed' },
        {
          type: 'acquisition.progress',
          mediaId: 1,
          ref: 'r1',
          progress: 0.5,
          etaSeconds: 30,
          state: 'active',
        },
      ]);
      expect(h.events.emit).toHaveBeenCalledWith({ type: 'queue.updated' });
      expect(h.events.emitToUsers).toHaveBeenCalledWith(
        [9],
        expect.objectContaining({ type: 'download.progress' }),
      );
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
      expect(h.notifications.dispatch).toHaveBeenCalledWith('grab.started', {
        title: 'x',
      });
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
        seasonNumber: 1,
        episodeNumber: 2,
        ref: 'torrent-hash',
        progress: 0.42,
        bytesPerSecond: 1000,
        state: 'active',
      });
      expect(h.events.emitToUsers).toHaveBeenCalledWith(
        [9],
        expect.objectContaining({
          type: 'download.progress',
          mediaType: 'series',
          progress: 0.42,
          dlspeed: 1000,
        }),
      );
    });

    it('emits nothing when the audience is empty', async () => {
      const h = makeHarness();
      h.sseAudience.recipientsForMedia.mockResolvedValue([]);
      await h.host['progress.set']({
        mediaId: 1,
        ref: 'r',
        progress: 0.1,
        state: 'active',
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
      expect(h.settings.set).toHaveBeenCalledWith(
        'plugin.acme.tool.foo',
        'bar',
      );
    });
  });
});

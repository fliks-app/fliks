import * as fs from 'fs';
import * as releaseScoring from '../../../common/release-scoring/release-rejection.helper';
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

/** `releases.match` reads its library via a raw query builder projection, not
 *  `find()` — this shapes fixture `Media` objects into that raw row format. */
function mockMonitoredLibrary(
  mediaRepo: ReturnType<typeof fakeRepo>,
  media: Media[],
): void {
  const rawMany = media.map((m) => ({
    id: m.id,
    monitored: m.monitored,
    type: m.type,
    title: m.title,
    originalTitle: m.originalTitle,
    alternativeTitles: m.alternativeTitles,
    qualityProfileId: m.qualityProfile?.id ?? null,
    qualityProfileCutoff: m.qualityProfile?.cutoff ?? null,
    qualityProfileUpgradeAllowed: m.qualityProfile?.upgradeAllowed ?? null,
    languageProfileId: m.languageProfile?.id ?? null,
  }));
  mediaRepo.createQueryBuilder.mockReturnValue(fakeQueryBuilder(rawMany));
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
  autoGrab: { classifyForSearch: jest.Mock };
  acquisitionCandidates: {
    listMovieTargets: jest.Mock;
    listEpisodeTargets: jest.Mock;
    groupIntoSeasonPacks: jest.Mock;
  };
  profiles: { resolveAllowedForMedia: jest.Mock };
  qualityDefs: { getSizeLimitsMap: jest.Mock };
  customFormats: { findAll: jest.Mock; scoreReleaseWith: jest.Mock };
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
  const pluginRegistrationRepo = fakeRepo();
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
  const customFormats = { findAll: jest.fn().mockResolvedValue([]), scoreReleaseWith: jest.fn().mockReturnValue(0) };
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

  // Fakes stand in for 19 constructor params — a plain unit test of the class,
  // not a DI-resolved instance (the DI graph itself is proven by the boot check).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const host = new (FliksHostImpl as any)(
    pluginId,
    mediaRepo,
    seasonRepo,
    episodeRepo,
    mediaFileRepo,
    pluginRegistrationRepo,
    autoGrab,
    acquisitionCandidates,
    profiles,
    qualityDefs,
    customFormats,
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
    pluginRegistrationRepo,
    autoGrab,
    acquisitionCandidates,
    profiles,
    qualityDefs,
    customFormats,
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

    it('collapses "unprofiled" to want: null — no profile means nothing can be scored', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia());
      h.mediaFileRepo.find.mockResolvedValue([]);

      h.autoGrab.classifyForSearch.mockReturnValue({ mode: 'unprofiled' });
      expect(
        (await h.host['media.acquisitionContext']({ mediaId: 1 }))?.want,
      ).toBeNull();
    });

    it('carries the ranked constraints for a "skip" decision, so a manual search can still score releases', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia());
      h.mediaFileRepo.find.mockResolvedValue([]);

      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'skip',
        minRankExclusive: 62,
        maxRankInclusive: 62,
      });
      const result = await h.host['media.acquisitionContext']({ mediaId: 1 });
      expect(result?.want).toMatchObject({
        decision: 'skip',
        minRankExclusive: 62,
        maxRankInclusive: 62,
      });
      expectJsonSafe(result);
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

      // One movie, one pack, and the pack's two episodes: four targets over four pages.
      const seen: Awaited<ReturnType<(typeof h.host)['acquisition.candidates']>>['items'] = [];
      let cursor: string | null | undefined;
      do {
        const page = await h.host['acquisition.candidates']({
          availableOn: '2099-01-01',
          limit: 1,
          cursor: cursor ?? undefined,
        });
        expect(page.items).toHaveLength(1);
        expectJsonSafe(page);
        seen.push(...page.items);
        cursor = page.cursor;
      } while (cursor);

      expect(seen).toHaveLength(4);
      expect(seen[0].season).toBeUndefined();
    });

    // The pack used to be the only candidate for its season, so nothing was left to fall back
    // to when no pack release won — and an RSS match on a loose episode could not recover its
    // episode id either. Both readers need the episodes listed alongside the pack.
    it('VERDICT: offers a packed season BOTH its pack and its episodes, pack first', async () => {
      const h = makeHarness();
      const series = makeMedia({ id: 2, type: MediaType.SERIES });
      const season = makeSeason({ id: 20, mediaId: 2 });
      const ep1 = makeEpisode({ id: 201, season, episodeNumber: 1 });
      const ep2 = makeEpisode({ id: 202, season, episodeNumber: 2 });

      h.acquisitionCandidates.listMovieTargets.mockResolvedValue([]);
      h.acquisitionCandidates.listEpisodeTargets.mockResolvedValue([
        { media: series, season, episode: ep1, files: [] },
        { media: series, season, episode: ep2, files: [] },
      ]);
      h.acquisitionCandidates.groupIntoSeasonPacks.mockResolvedValue([
        { media: series, season, episodes: [ep1, ep2], files: [], totalEpisodeCount: 2 },
      ]);
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: 10,
      });

      const { items } = await h.host['acquisition.candidates']({
        availableOn: '2099-01-01',
        limit: 10,
      });

      expect(items.map((t) => t.episode?.number ?? 'pack')).toEqual(['pack', 1, 2]);
      // The sort has to keep the pack ahead of its own episodes, or a caller walking the list
      // would commit to loose episodes before it had seen the pack.
      expect(items.every((t) => t.season?.id === 20)).toBe(true);
    });

    // Every page used to re-run the whole enumeration, which is where the duplicated log lines
    // came from — and an offset cursor over a set re-derived each time could skip or repeat rows.
    it('VERDICT: a paginated walk enumerates once, not once per page', async () => {
      const h = makeHarness();
      const movie = makeMedia({ id: 1, type: MediaType.MOVIE, status: 'Released' });
      h.acquisitionCandidates.listMovieTargets.mockResolvedValue([
        { media: movie, files: [] },
        { media: makeMedia({ id: 2, type: MediaType.MOVIE, status: 'Released' }), files: [] },
        { media: makeMedia({ id: 3, type: MediaType.MOVIE, status: 'Released' }), files: [] },
      ]);
      h.acquisitionCandidates.listEpisodeTargets.mockResolvedValue([]);
      h.acquisitionCandidates.groupIntoSeasonPacks.mockResolvedValue([]);
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: 10,
      });

      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const page = await h.host['acquisition.candidates']({
          availableOn: '2099-01-01',
          limit: 1,
          cursor: cursor ?? undefined,
        });
        pages++;
        cursor = page.cursor;
      } while (cursor);

      expect(pages).toBe(3);
      expect(h.acquisitionCandidates.listMovieTargets).toHaveBeenCalledTimes(1);
    });

    it('re-enumerates rather than serving another walk’s page when the scope differs', async () => {
      const h = makeHarness();
      h.acquisitionCandidates.listMovieTargets.mockResolvedValue([
        { media: makeMedia({ id: 1, type: MediaType.MOVIE, status: 'Released' }), files: [] },
        { media: makeMedia({ id: 2, type: MediaType.MOVIE, status: 'Released' }), files: [] },
      ]);
      h.acquisitionCandidates.listEpisodeTargets.mockResolvedValue([]);
      h.acquisitionCandidates.groupIntoSeasonPacks.mockResolvedValue([]);
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: 10,
      });

      const first = await h.host['acquisition.candidates']({ availableOn: '2099-01-01', limit: 1 });
      // Same cursor, different mediaIds: reusing the cached list would answer the wrong scope.
      await h.host['acquisition.candidates']({
        availableOn: '2099-01-01',
        limit: 1,
        cursor: first.cursor!,
        mediaIds: [7],
      });

      expect(h.acquisitionCandidates.listMovieTargets).toHaveBeenCalledTimes(2);
      expect(h.acquisitionCandidates.listMovieTargets).toHaveBeenLastCalledWith([7], true);
    });

    // `Media.libraryId` is a `@RelationId`, so a query selecting an explicit column list leaves
    // it undefined — and the builder drops a target with no library id. That is how every series
    // candidate disappeared while movies, loaded with `leftJoinAndSelect`, came through.
    it('VERDICT: takes the library id from the joined relation when the RelationId is absent', async () => {
      const h = makeHarness();
      const series = makeMedia({ id: 2, type: MediaType.SERIES });
      const season = makeSeason({ id: 20, mediaId: 2 });
      const ep1 = makeEpisode({ id: 201, season, episodeNumber: 1 });
      // Exactly what the episode query hydrates: the relation, not the RelationId.
      const withRelationOnly = { ...series, libraryId: undefined, library: { id: 9 } };

      h.acquisitionCandidates.listMovieTargets.mockResolvedValue([]);
      h.acquisitionCandidates.listEpisodeTargets.mockResolvedValue([
        { media: withRelationOnly, season, episode: ep1, files: [] },
      ]);
      h.acquisitionCandidates.groupIntoSeasonPacks.mockResolvedValue([]);
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: 10,
      });

      const { items } = await h.host['acquisition.candidates']({
        availableOn: '2099-01-01',
        limit: 10,
      });

      expect(items).toHaveLength(1);
      expect(items[0].libraryId).toBe(9);
    });

    it('still drops a target with no library id either way, rather than emitting a null one', async () => {
      const h = makeHarness();
      const series = makeMedia({ id: 2, type: MediaType.SERIES });
      const season = makeSeason({ id: 20, mediaId: 2 });
      const ep1 = makeEpisode({ id: 201, season, episodeNumber: 1 });

      h.acquisitionCandidates.listMovieTargets.mockResolvedValue([]);
      h.acquisitionCandidates.listEpisodeTargets.mockResolvedValue([
        { media: { ...series, libraryId: undefined, library: null }, season, episode: ep1, files: [] },
      ]);
      h.acquisitionCandidates.groupIntoSeasonPacks.mockResolvedValue([]);
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: 10,
      });

      const { items } = await h.host['acquisition.candidates']({
        availableOn: '2099-01-01',
        limit: 10,
      });

      expect(items).toEqual([]);
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

    it('never offers a "skip" or "unprofiled" target — auto-grab must not act on either', async () => {
      const h = makeHarness();
      const movie = makeMedia({ id: 1 });
      const series = makeMedia({ id: 2, type: MediaType.SERIES });
      const season = makeSeason({ id: 20, mediaId: 2 });
      const ep1 = makeEpisode({ id: 201, season, episodeNumber: 1 });
      const ep2 = makeEpisode({ id: 202, season, episodeNumber: 2 });
      // On a season the pack list does not cover, so it survives as a single and
      // reaches `buildFromEpisodeTarget`, including a packed season's own episodes.
      const loneSeason = makeSeason({ id: 21, mediaId: 2 });
      const ep3 = makeEpisode({ id: 203, season: loneSeason, episodeNumber: 1 });

      h.acquisitionCandidates.listMovieTargets.mockResolvedValue([
        { media: movie, files: [] },
      ]);
      h.acquisitionCandidates.listEpisodeTargets.mockResolvedValue([
        { media: series, season, episode: ep1, files: [] },
        { media: series, season: loneSeason, episode: ep3, files: [] },
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
      // Every branch (movie, single episode, season pack) resolves to a
      // decision the candidates path must drop before it reaches a plugin.
      h.autoGrab.classifyForSearch.mockReturnValue({
        mode: 'skip',
        minRankExclusive: 40,
        maxRankInclusive: 62,
        skipReason: 'at-cutoff',
      });

      const result = await h.host['acquisition.candidates']({
        availableOn: '2099-01-01',
        limit: 10,
      });
      expect(result.items).toEqual([]);
    });

    describe('movie availability gate — agrees with the date-gate logic on every row', () => {
      // Expected column is a hand-derived golden reference for the date-gate
      // logic below — nothing else in the repo implements it to import from.
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
    it('tokenises each library title once per call and each release title once, not once per pair', async () => {
      const indexSpy = jest.spyOn(releaseScoring, 'indexTitleExpectations');
      const releaseTokenSpy = jest.spyOn(releaseScoring, 'releaseTitleTokens');
      try {
        const h = makeHarness();
        const library = Array.from({ length: 30 }, (_, i) => makeMedia({ id: i + 1, title: `Library Title ${i}` }));
        mockMonitoredLibrary(h.mediaRepo, library);

        await h.host['releases.match']({
          titles: Array.from({ length: 8 }, (_, i) => ({
            id: `r${i}`,
            title: `Zzqxvvm Plghmnd Wbbrtks ${i}`,
            publishDate: new Date().toISOString(),
          })),
        });

        expect(indexSpy).toHaveBeenCalledTimes(library.length);
        expect(releaseTokenSpy).toHaveBeenCalledTimes(8);
      } finally {
        indexSpy.mockRestore();
        releaseTokenSpy.mockRestore();
      }
    });

    it('hands the event loop back between titles so a whole feed does not block core', async () => {
      const h = makeHarness();
      mockMonitoredLibrary(h.mediaRepo, [makeMedia({ title: 'Some Great Movie' })]);
      const immediate = jest.spyOn(global, 'setImmediate');
      try {
        await h.host['releases.match']({
          titles: Array.from({ length: 4 }, (_, i) => ({
            id: `y${i}`,
            title: `Zzqxvvm Plghmnd ${i}`,
            publishDate: new Date().toISOString(),
          })),
        });
        expect(immediate).toHaveBeenCalledTimes(4);
      } finally {
        immediate.mockRestore();
      }
    });

    it('reports unmatched, then grab, for a title that matches a missing monitored movie', async () => {
      const h = makeHarness();
      const media = makeMedia({ title: 'Some Great Movie' });
      mockMonitoredLibrary(h.mediaRepo, [media]);
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

    it('VERDICT: a library title this tokenizer cannot read claims no release', async () => {
      const h = makeHarness();
      // Wholly non-Latin: it tokenizes to nothing, so it can be told apart from no release at all.
      const media = makeMedia({ title: '\u6211\u4e0d\u8fc7\u662f\u4e2a\u5927\u7f57\u91d1\u4ed9' });
      mockMonitoredLibrary(h.mediaRepo, [media]);
      h.mediaFileRepo.find.mockResolvedValue([]);
      h.autoGrab.classifyForSearch.mockReturnValue({ mode: 'missing', minRankExclusive: 0, maxRankInclusive: 100 });

      const result = await h.host['releases.match']({
        titles: [{ id: 'a', title: 'Totally.Unrelated.Show.S01E01.1080p.WEB-DL', publishDate: new Date().toISOString() }],
      });

      expect(result[0]).toMatchObject({ decision: 'skip', skipReason: 'unmatched' });
    });

    it('skips a release fresher than minAgeMinutes', async () => {
      const h = makeHarness();
      const media = makeMedia({ title: 'Fresh Movie' });
      mockMonitoredLibrary(h.mediaRepo, [media]);
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
      mockMonitoredLibrary(h.mediaRepo, [media]);
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
      mockMonitoredLibrary(h.mediaRepo, [media]);
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
            sourceRef: 'source-a',
            blocked: false,
          },
        ],
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('r1');
      expect(typeof result[0].qualityId).toBe('number');
      expect(Array.isArray(result[0].rejections)).toBe(true);
      expectJsonSafe(result);
    });

    // Custom-format scoring used to read its whole table once per candidate. A streamed
    // search re-scores the accumulated set per indexer, which turned that N+1 into an
    // N*K one: 300 releases across 6 indexers meant ~1050 round trips for one search.
    it('VERDICT: reads the format and size tables once per call, not once per release', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia({ runtime: 120 }));
      h.profiles.resolveAllowedForMedia.mockReturnValue({
        allowed: new Set([9]),
        allowedLangs: new Set(),
      });
      h.qualityDefs.getSizeLimitsMap.mockResolvedValue(new Map());

      const releases = Array.from({ length: 50 }, (_, i) => ({
        id: `r${i}`,
        title: `A Movie 2020 1080p WEB-DL group${i}`,
        size: 4_000_000_000,
        seeders: 10,
        leechers: 2,
        publishDate: new Date(0).toISOString(),
        sourceRef: `source-${i}`,
        blocked: false,
      }));

      const result = await h.host['releases.score']({ mediaId: 1, releases });

      expect(result).toHaveLength(50);
      expect(h.customFormats.findAll).toHaveBeenCalledTimes(1);
      expect(h.qualityDefs.getSizeLimitsMap).toHaveBeenCalledTimes(1);
      expect(h.mediaRepo.findOne).toHaveBeenCalledTimes(1);
      // Every release is still scored — the reads were hoisted, not skipped.
      expect(h.customFormats.scoreReleaseWith).toHaveBeenCalledTimes(50);
    });

    // `media.runtime` comes from TMDB's `episode_run_time`, empty for a great many series. A
    // runtime of 0 disables the size rule in both directions, which is how a 19 GB season pack
    // passed for a single missing episode. Episodes carry their own runtime; use it.
    it('VERDICT: judges a series against its episodes runtime, not the empty series one', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(
        makeMedia({ id: 1, type: MediaType.SERIES, runtime: null as unknown as number }),
      );
      h.profiles.resolveAllowedForMedia.mockReturnValue({ allowed: new Set([9]), allowedLangs: new Set() });
      h.qualityDefs.getSizeLimitsMap.mockResolvedValue(new Map());
      const qb = fakeQueryBuilder();
      qb.getRawOne = jest.fn().mockResolvedValue({ total: '55' });
      h.episodeRepo.createQueryBuilder.mockReturnValue(qb);

      await h.host['releases.score']({
        mediaId: 1,
        seasonNumber: 4,
        episodeNumber: 3,
        releases: [
          {
            id: 'r1',
            title: 'Show S04E03 1080p WEB-DL',
            size: 2_000_000_000,
            seeders: 10,
            leechers: 1,
            publishDate: new Date(0).toISOString(),
            sourceRef: 'a',
            blocked: false,
          },
        ],
      });

      // Scoped to the one episode asked for, so the size ceiling is that episode's.
      expect(qb.andWhere).toHaveBeenCalledWith('ep.episodeNumber = :episodeNumber', { episodeNumber: 3 });
    });

    it('reports an unmeasurable size as unknown rather than as a perfect match', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(
        makeMedia({ id: 1, type: MediaType.MOVIE, runtime: null as unknown as number }),
      );
      h.profiles.resolveAllowedForMedia.mockReturnValue({ allowed: new Set([9]), allowedLangs: new Set() });
      h.qualityDefs.getSizeLimitsMap.mockResolvedValue(new Map());

      const [row] = await h.host['releases.score']({
        mediaId: 1,
        releases: [
          {
            id: 'r1',
            title: 'A Movie 2020 1080p WEB-DL',
            size: 4_000_000_000,
            seeders: 10,
            leechers: 1,
            publishDate: new Date(0).toISOString(),
            sourceRef: 'a',
            blocked: false,
          },
        ],
      });

      // 0 claims the size is exactly preferred, which promoted it at the last tiebreak.
      expect(row.sizeDeviation).toBeNull();
    });

    it("returns [] for an unknown media id, and carries a rejection's params across the boundary", async () => {
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
            sourceRef: 'source-a',
            minSeeders: 50,
            blocked: false,
          },
        ],
      });
      expect(result[0].rejections.some((r) => r.code === 'MIN_SEEDERS')).toBe(
        true,
      );
      // The frontend interpolates these into its own `rejection.MIN_SEEDERS` string.
      expect(
        result[0].rejections.find((r) => r.code === 'MIN_SEEDERS')?.params,
      ).toEqual({ actual: 10, min: 50 });
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
            sourceRef: 'source-a',
            blocked: false,
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

    it('honours the caller-supplied blocked flag instead of querying a blocklist core no longer owns — the unblocked release survives, the blocked one does not', async () => {
      const h = makeHarness();
      h.mediaRepo.findOne.mockResolvedValue(makeMedia({ runtime: 120 }));
      h.profiles.resolveAllowedForMedia.mockReturnValue({
        allowed: new Set([9]),
        allowedLangs: new Set(),
      });

      const result = await h.host['releases.score']({
        mediaId: 1,
        releases: [
          {
            id: 'blocked-one',
            title: 'A Movie 2020 1080p WEB-DL',
            size: 4_000_000_000,
            seeders: 10,
            leechers: 2,
            publishDate: new Date().toISOString(),
            sourceRef: 'source-a',
            blocked: true,
          },
          {
            id: 'clean-one',
            title: 'A Movie 2020 1080p WEB-DL',
            size: 4_000_000_000,
            seeders: 10,
            leechers: 2,
            publishDate: new Date().toISOString(),
            sourceRef: 'source-b',
            blocked: false,
          },
        ],
      });

      const blocked = result.find((r) => r.id === 'blocked-one')!;
      const clean = result.find((r) => r.id === 'clean-one')!;
      expect(blocked.blocklisted).toBe(true);
      expect(blocked.rejections.some((r) => r.code === 'BLOCKLISTED')).toBe(
        true,
      );
      expect(clean.blocklisted).toBe(false);
      expect(clean.rejections.some((r) => r.code === 'BLOCKLISTED')).toBe(
        false,
      );
      // Sort rule #2 (not-blocklisted first): the clean release ranks ahead.
      expect(result[0].id).toBe('clean-one');
      expectJsonSafe(result);
    });
  });

  // ===========================================================================
  // A5 — media.resolve
  // ===========================================================================

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
    it('VERDICT: passes through the paths that were already in place, so a retry is not a failure', async () => {
      const h = makeHarness();
      h.pluginRegistrationRepo.findOne.mockResolvedValue({ ingestRoots: [tmpRoot] });
      h.mediaRepo.findOne.mockResolvedValue(makeMedia());
      h.libraryIngestService.ingest.mockResolvedValue({ imported: [], alreadyPresent: [sourceFile] });

      const result = await h.host['library.ingest']({
        idempotencyKey: 'k1',
        mediaId: 1,
        paths: [sourceFile],
        transfer: 'copy',
        sourceLabel: 'Release.Name',
      });

      // Without this a caller cannot tell "nothing could be placed" from "it is already there",
      // and reports a completed import as failed on every retry.
      expect(result).toEqual(expect.objectContaining({ imported: [], alreadyPresent: [sourceFile] }));
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

    it('dispatches download.complete before resolving the episode it does not carry', async () => {
      const h = makeHarness();
      h.pluginRegistrationRepo.findOne.mockResolvedValue({
        ingestRoots: [tmpRoot],
      });
      h.mediaRepo.findOne.mockResolvedValue(makeMedia());
      h.libraryIngestService.ingest.mockResolvedValue({
        imported: [
          {
            file: { id: 55, relativePath: 'Show/S01E02.mkv', quality: '1080p' },
            episodeId: 7,
          },
        ],
        alreadyPresent: [],
      });

      const order: string[] = [];
      h.notifications.dispatch.mockImplementation(() => {
        order.push('dispatch');
        return Promise.resolve();
      });
      h.episodeRepo.findOne.mockImplementation(() => {
        order.push('episodeLookup');
        return Promise.resolve({ episodeNumber: 2, season: { seasonNumber: 1 } });
      });

      const result = await h.host['library.ingest']({
        idempotencyKey: 'k1',
        mediaId: 1,
        paths: [sourceFile],
        transfer: 'copy',
        sourceLabel: 'Release.Name',
      });

      expect(order).toEqual(['dispatch', 'episodeLookup']);
      // The lookup still has to happen — the return value carries the numbers.
      expect(result.seasonNumber).toBe(1);
      expect(result.episodeNumber).toBe(2);
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

    it('coalesces to one emission per media per second, and the trailing one carries the latest', async () => {
      jest.useFakeTimers();
      try {
        const h = makeHarness();
        h.mediaRepo.findOne.mockResolvedValue(makeMedia({ type: MediaType.SERIES }));
        const push = (progress: number) =>
          h.host['progress.set']({ mediaId: 7, ref: 'r', progress, state: 'active' });

        await push(0.1);
        await push(0.2);
        await push(0.3);
        expect(h.events.emitToUsers).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1_000);
        expect(h.events.emitToUsers).toHaveBeenCalledTimes(2);
        expect(h.events.emitToUsers).toHaveBeenLastCalledWith(
          [9],
          expect.objectContaining({ progress: 0.3 }),
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
        await h.host['progress.set']({ mediaId: 1, ref: 'r', progress: 0.1, state: 'active' });
        await h.host['progress.set']({ mediaId: 2, ref: 'r', progress: 0.1, state: 'active' });
        expect(h.events.emitToUsers).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
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
      // The third argument is the writer: it stops the config note echoing back to this plugin.
      expect(h.settings.set).toHaveBeenCalledWith(
        'plugin.acme.tool.foo',
        'bar',
        'acme.tool',
      );
    });
  });
});

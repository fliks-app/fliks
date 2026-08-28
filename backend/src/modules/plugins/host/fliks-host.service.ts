import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import type {
  AcquisitionEvent,
  AcquisitionTarget,
  MediaKind,
  PluginHostApi,
} from '../../../common/plugin-contract';
import {
  MediaStatus,
  MediaType,
  MinimumAvailability,
} from '../../../common/enums';
import { Media } from '../../media/entities/media.entity';
import { Season } from '../../media/entities/season.entity';
import { Episode } from '../../media/entities/episode.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
import { onDiskEpisodeNumbers } from '../../media/episode-coverage.util';
import {
  AutoGrabPipelineService,
  type SearchDecision,
} from '../../media/auto-grab-pipeline.service';
import {
  AcquisitionCandidatesService,
  type EpisodeTarget,
  type MovieTarget,
  type SeasonPackTarget,
} from '../../media/acquisition-candidates.service';
import { ProfilesService } from '../../profiles/profiles.service';
import { QualityDefinitionsService } from '../../profiles/quality-definitions.service';
import { CustomFormatsService } from '../../profiles/custom-formats.service';
import { RequestLifecycleService } from '../../requests/request-lifecycle.service';
import { LibraryIngestService } from '../../../common/library-ingest/library-ingest.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { MediaServersService } from '../../media-servers/media-servers.service';
import { SettingsService } from '../../settings/settings.service';
import { EventsService } from '../../scheduler/events.service';
import { SseAudienceService } from '../../scheduler/sse-audience.service';
import { PluginRegistration } from '../entities/plugin-registration.entity';
import {
  maxResolutionFromQualityStrings,
  rankFromQualityString,
  resolveSearchTitles,
  scoreAndSortReleases,
  indexTitleExpectations,
  matchesIndexedExpectation,
  releaseTitleTokens,
  type TitleExpectationIndex,
  type ReleaseCandidate,
} from '../../../common/release-scoring';
import { parseSeasonEpisode } from '../../../common/release-parsing';
import { PluginCountsCacheService } from './plugin-counts-cache.service';
import { PLUGIN_HOST_PLUGIN_ID } from './plugin-host.constants';
import { PluginHostContext } from './plugin-host-context';
import { DownloadProgressState } from '../../../common/constants/download-progress-state';

/** The rate `progress.set` promises: at most one SSE emission per media per second. */
const PROGRESS_MIN_INTERVAL_MS = 1_000;

interface ProgressGate {
  lastEmitMs: number;
  pending: Parameters<PluginHostApi['progress.set']>[0] | null;
  timer: NodeJS.Timeout | null;
}

/** `media.resolve`'s own bound, per the contract's doc comment. */
const QUEUE_PAGE_SIZE_MAX = 100;

/** `acquisition.candidates`'s own bound, per the contract's doc comment. */
const MAX_CANDIDATES_LIMIT = 500;

/** How long a paginated candidate walk may reuse the list it started from. A walk takes seconds;
 *  this only has to outlive one, and re-enumerating mid-walk was never a consistency guarantee —
 *  the offset cursor would skip or repeat rows whenever the set shifted underneath it. */
const CANDIDATES_PAGE_CACHE_MS = 60_000;

type ReleaseMatchResult = Awaited<
  ReturnType<PluginHostApi['releases.match']>
>[number];
type SkipReason = NonNullable<ReleaseMatchResult['skipReason']>;
type ScoredReleaseOut = Awaited<
  ReturnType<PluginHostApi['releases.score']>
>[number];
type MediaResolveEntry = Awaited<
  ReturnType<PluginHostApi['media.resolve']>
>[string];

/**
 * Core's implementation of the 15 plugin-facing host methods. Every value it
 * returns is a plain, JSON-safe object built field-by-field from entities —
 * never the entity itself — because the same shape crosses a socket once the
 * transport changes (Phase 10.4).
 */
@Injectable()
export class FliksHostImpl implements PluginHostApi {
  constructor(
    @Inject(PLUGIN_HOST_PLUGIN_ID) private readonly pluginId: string | null,
    @InjectRepository(Media) private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Season) private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(PluginRegistration)
    private readonly pluginRegistrationRepo: Repository<PluginRegistration>,
    private readonly autoGrab: AutoGrabPipelineService,
    private readonly acquisitionCandidates: AcquisitionCandidatesService,
    private readonly profiles: ProfilesService,
    private readonly qualityDefs: QualityDefinitionsService,
    private readonly customFormats: CustomFormatsService,
    private readonly requestLifecycle: RequestLifecycleService,
    private readonly libraryIngestService: LibraryIngestService,
    private readonly notifications: NotificationsService,
    private readonly mediaServers: MediaServersService,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
    private readonly sseAudience: SseAudienceService,
    private readonly countsCache: PluginCountsCacheService,
  ) {}

  private readonly logger = new Logger(FliksHostImpl.name);

  private readonly progressGates = new Map<number, ProgressGate>();

  /** The enumerated list a cursor walks. One entry: a walk is sequential, and a second caller
   *  starting its own walk simply re-enumerates rather than reading someone else's page. */
  private candidatesPage: { key: string; at: number; targets: AcquisitionTarget[] } | null = null;

  /** `PluginHostContext` (set only by `PluginHostBindingService`, never by a plugin's
   *  payload) wins when bound; the constructor value is the in-process default. */
  private currentPluginId(): string | null {
    return PluginHostContext.current() ?? this.pluginId;
  }

  // ---------------------------------------------------------------------------
  // Group A — read
  // ---------------------------------------------------------------------------

  'media.acquisitionContext': PluginHostApi['media.acquisitionContext'] = (p) =>
    this.acquisitionContext(p);
  'acquisition.candidates': PluginHostApi['acquisition.candidates'] = (p) =>
    this.candidates(p);
  'releases.match': PluginHostApi['releases.match'] = (p) =>
    this.releasesMatch(p);
  'releases.score': PluginHostApi['releases.score'] = (p) =>
    this.releasesScore(p);
  'media.resolve': PluginHostApi['media.resolve'] = (p) => this.mediaResolve(p);
  'media.exists': PluginHostApi['media.exists'] = (p) => this.mediaExists(p);

  // ---------------------------------------------------------------------------
  // Group B — write acquisition state
  // ---------------------------------------------------------------------------

  'requests.markInProgress': PluginHostApi['requests.markInProgress'] = (p) =>
    this.requestsMarkInProgress(p);

  // ---------------------------------------------------------------------------
  // Group C — ingest
  // ---------------------------------------------------------------------------

  'library.ingest': PluginHostApi['library.ingest'] = (p) =>
    this.libraryIngest(p);

  // ---------------------------------------------------------------------------
  // Group D — events and outbound
  // ---------------------------------------------------------------------------

  'events.publish': PluginHostApi['events.publish'] = (p) =>
    this.eventsPublish(p);
  'notifications.dispatch': PluginHostApi['notifications.dispatch'] = (p) =>
    this.notificationsDispatch(p);
  'counts.set': PluginHostApi['counts.set'] = (p) => this.countsSet(p);
  'events.emitOwn': PluginHostApi['events.emitOwn'] = (p) =>
    this.eventsEmitOwn(p);
  'progress.set': PluginHostApi['progress.set'] = (p) => this.progressSet(p);

  // ---------------------------------------------------------------------------
  // Group E — config
  // ---------------------------------------------------------------------------

  'config.get': PluginHostApi['config.get'] = (p) => this.configGet(p);
  'config.set': PluginHostApi['config.set'] = (p) => this.configSet(p);

  // ===========================================================================
  // A1 — media.acquisitionContext
  // ===========================================================================

  private async acquisitionContext(p: {
    mediaId: number;
    seasonId?: number;
    episodeId?: number;
  }): Promise<AcquisitionTarget | null> {
    const media = await this.mediaRepo.findOne({ where: { id: p.mediaId } });
    if (!media || media.libraryId == null) return null;

    let season: Season | null = null;
    let episode: Episode | null = null;
    if (p.episodeId != null) {
      episode = await this.episodeRepo.findOne({
        where: { id: p.episodeId },
        relations: ['season'],
      });
      if (!episode?.season || episode.season.mediaId !== media.id) return null;
      season = episode.season;
    } else if (p.seasonId != null) {
      season = await this.seasonRepo.findOne({ where: { id: p.seasonId } });
      if (!season || season.mediaId !== media.id) return null;
    }

    const files = await this.filesForClassification(media, season, episode);
    // A whole-series lookup (series, no season/episode scope) has no single
    // quality to classify — nothing to grab at that granularity.
    const isWholeSeriesLookup =
      media.type !== MediaType.MOVIE && !season && !episode;
    const decision = isWholeSeriesLookup
      ? null
      : this.autoGrab.classifyForSearch(media, files);
    const target = this.buildAcquisitionTarget(media, decision, files);
    if (!target) return null;

    if (season) {
      const episodeCount = episode
        ? await this.episodeRepo.count({ where: { season: { id: season.id } } })
        : (await this.episodesOfSeason(season.id)).length;
      target.season = {
        id: season.id,
        number: season.seasonNumber,
        episodeCount,
      };
    }
    if (episode) {
      target.episode = {
        id: episode.id,
        number: episode.episodeNumber,
        endNumber: episode.endEpisodeNumber,
        airDate: episode.airDate ?? null,
        title: episode.title ?? null,
      };
    }
    return target;
  }

  // ===========================================================================
  // A2 — acquisition.candidates
  // ===========================================================================

  private async candidates(p: {
    kind?: MediaKind;
    mediaIds?: number[];
    availableOn: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: AcquisitionTarget[]; cursor: string | null }> {
    const limit = Math.min(
      Math.max(Math.trunc(p.limit) || 1, 1),
      MAX_CANDIDATES_LIMIT,
    );
    const cacheKey = JSON.stringify([
      p.kind ?? null,
      p.mediaIds ? [...p.mediaIds].sort((a, b) => a - b) : null,
      p.availableOn,
    ]);
    // A continuation reuses what the first page enumerated. Without this every page re-ran the
    // whole enumeration — five identical log lines in one second were the visible half of it.
    const cached = p.cursor ? this.candidatesPage : null;
    if (cached && cached.key === cacheKey && Date.now() - cached.at < CANDIDATES_PAGE_CACHE_MS) {
      return this.pageOf(cached.targets, p.cursor, limit);
    }
    const wantMovies = p.kind !== 'series';
    const wantSeries = p.kind !== 'movie';
    const targets: AcquisitionTarget[] = [];

    if (wantMovies) {
      const movieTargets = await this.acquisitionCandidates.listMovieTargets(
        p.mediaIds,
        // Every page re-enumerates, so only the first one narrates: five identical lines in one
        // second told an operator nothing except that pagination happened.
        Boolean(p.cursor),
      );
      for (const t of movieTargets) {
        if (!this.isAvailable(t.media, p.availableOn)) continue;
        const target = this.buildFromMovieTarget(t);
        if (target) targets.push(target);
      }
    }

    if (wantSeries) {
      const episodeTargets = (
        await this.acquisitionCandidates.listEpisodeTargets(p.mediaIds, Boolean(p.cursor))
      ).filter((t) => !t.episode.airDate || t.episode.airDate <= p.availableOn);
      const packs =
        await this.acquisitionCandidates.groupIntoSeasonPacks(episodeTargets);
      const episodeCountBySeason = await this.episodeCountsBySeasons([
        ...new Set(episodeTargets.map((t) => t.season.id)),
      ]);

      // A season with two or more wanted episodes yields BOTH its pack and every episode in it.
      // Enumeration reports what is wanted; whether a pack beats loose episodes is only knowable
      // once releases are scored, so the caller decides — the sort below hands it the pack first.
      // Suppressing the episodes here also blinded the two other readers of this method: the
      // season-grab fallback found nothing to fall back to, and an RSS match on a loose episode
      // could not recover its episode id.
      for (const pk of packs) {
        const target = this.buildFromSeasonPackTarget(pk);
        if (target) targets.push(target);
      }
      for (const t of episodeTargets) {
        const target = this.buildFromEpisodeTarget(
          t,
          episodeCountBySeason.get(t.season.id) ?? 1,
        );
        if (target) targets.push(target);
      }
    }

    targets.sort(
      (a, b) =>
        a.mediaId - b.mediaId ||
        (a.season?.id ?? 0) - (b.season?.id ?? 0) ||
        (a.episode?.id ?? 0) - (b.episode?.id ?? 0),
    );

    this.candidatesPage = { key: cacheKey, at: Date.now(), targets };
    return this.pageOf(targets, p.cursor, limit);
  }

  private pageOf(
    targets: AcquisitionTarget[],
    cursor: string | undefined,
    limit: number,
  ): { items: AcquisitionTarget[]; cursor: string | null } {
    const offset = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0;
    const items = targets.slice(offset, offset + limit);
    return {
      items,
      cursor: offset + items.length < targets.length ? String(offset + items.length) : null,
    };
  }

  // ===========================================================================
  // A3 — releases.match
  // ===========================================================================

  private async releasesMatch(p: {
    titles: { id: string; title: string; publishDate: string }[];
    minAgeMinutes?: number;
  }): Promise<ReleaseMatchResult[]> {
    // createQueryBuilder, not find(): find() still joins all 4 `eager: true`
    // Media relations even under `select`, which dominates this call's cost.
    const rows = await this.mediaRepo
      .createQueryBuilder('media')
      .leftJoin('media.qualityProfile', 'qualityProfile')
      .leftJoin('media.languageProfile', 'languageProfile')
      .select('media.id', 'id')
      .addSelect('media.monitored', 'monitored')
      .addSelect('media.type', 'type')
      .addSelect('media.title', 'title')
      .addSelect('media.originalTitle', 'originalTitle')
      .addSelect('media.alternativeTitles', 'alternativeTitles')
      .addSelect('media.qualityProfileId', 'qualityProfileId')
      .addSelect('qualityProfile.cutoff', 'qualityProfileCutoff')
      .addSelect('qualityProfile.upgradeAllowed', 'qualityProfileUpgradeAllowed')
      .addSelect('media.languageProfileId', 'languageProfileId')
      .where('media.monitored = :monitored', { monitored: true })
      .getRawMany<{
        id: number;
        monitored: boolean;
        type: MediaType;
        title: string;
        originalTitle: string | null;
        alternativeTitles: string[] | null;
        qualityProfileId: number | null;
        qualityProfileCutoff: number | null;
        qualityProfileUpgradeAllowed: boolean | null;
        languageProfileId: number | null;
      }>();
    const library: Media[] = rows.map(
      (r) =>
        ({
          id: r.id,
          monitored: r.monitored,
          type: r.type,
          title: r.title,
          originalTitle: r.originalTitle,
          alternativeTitles: r.alternativeTitles ?? [],
          qualityProfile:
            r.qualityProfileId == null
              ? null
              : {
                  cutoff: r.qualityProfileCutoff,
                  upgradeAllowed: r.qualityProfileUpgradeAllowed,
                },
          languageProfile:
            r.languageProfileId == null ? null : { id: r.languageProfileId },
        }) as unknown as Media,
    );
    // Tokenised once for the whole batch: doing it per release title is what made a full feed
    // tens of seconds of blocking CPU.
    const indexed = library.map((media) => ({
      media,
      titles: indexTitleExpectations([media.title, media.originalTitle ?? '', ...(media.alternativeTitles ?? [])]),
    }));
    const out: ReleaseMatchResult[] = [];
    for (const entry of p.titles) {
      out.push(await this.matchOneRelease(entry, indexed, p.minAgeMinutes));
      // The unmatched path never awaits, so without this a whole feed holds core's event loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return out;
  }

  private async matchOneRelease(
    entry: { id: string; title: string; publishDate: string },
    library: { media: Media; titles: TitleExpectationIndex }[],
    minAgeMinutes: number | undefined,
  ): Promise<ReleaseMatchResult> {
    const se = parseSeasonEpisode(entry.title);
    const skip = (
      skipReason: SkipReason,
      mediaId: number | null = null,
      extra?: { seasonNumber?: number; episodeNumber?: number },
    ): ReleaseMatchResult => ({
      id: entry.id,
      mediaId,
      isFullSeason: se.isFullSeason,
      decision: 'skip',
      skipReason,
      ...extra,
    });

    // Identification: a title this tokenizer cannot read must claim nothing, or the first such
    // row in the library answers for every release that matches nothing else.
    const releaseTokens = releaseTitleTokens(entry.title);
    const media = library.find((m) => matchesIndexedExpectation(releaseTokens, m.titles, 'no-match'))?.media;
    if (!media) return skip('unmatched');
    if (!media.monitored) return skip('not-monitored', media.id);

    let files: { quality?: string | null }[] = [];
    let seasonNumber: number | undefined;
    let episodeNumber: number | undefined;

    if (media.type === MediaType.SERIES) {
      if (se.season == null) return skip('not-available', media.id);
      const season = await this.seasonRepo.findOne({
        where: { media: { id: media.id }, seasonNumber: se.season },
      });
      if (!season) return skip('not-available', media.id);
      if (!season.monitored)
        return skip('not-monitored', media.id, {
          seasonNumber: season.seasonNumber,
        });
      seasonNumber = season.seasonNumber;

      if (se.isFullSeason) {
        const episodes = await this.episodesOfSeason(season.id);
        if (!episodes.length)
          return skip('not-available', media.id, { seasonNumber });
        files = await this.filesForSeasonPack(episodes, onDiskEpisodeNumbers(episodes));
      } else if (se.episode != null) {
        const episode = await this.episodeRepo.findOne({
          where: { season: { id: season.id }, episodeNumber: se.episode },
        });
        if (!episode) return skip('not-available', media.id, { seasonNumber });
        if (!episode.monitored) {
          return skip('not-monitored', media.id, {
            seasonNumber,
            episodeNumber: episode.episodeNumber,
          });
        }
        episodeNumber = episode.episodeNumber;
        files = await this.filesForEpisode(
          episode,
          onDiskEpisodeNumbers(await this.episodesOfSeason(season.id)),
        );
      } else {
        return skip('not-available', media.id, { seasonNumber });
      }
    } else {
      files = (
        await this.mediaFileRepo.find({ where: { media: { id: media.id } } })
      ).map((f) => ({
        quality: f.quality,
      }));
    }

    const decision = this.autoGrab.classifyForSearch(media, files);
    if (decision.mode === 'unprofiled')
      return skip('unprofiled', media.id, { seasonNumber, episodeNumber });
    if (decision.mode === 'skip')
      return skip('on-disk', media.id, { seasonNumber, episodeNumber });

    if (minAgeMinutes) {
      const ageMinutes = (Date.now() - Date.parse(entry.publishDate)) / 60000;
      if (Number.isFinite(ageMinutes) && ageMinutes < minAgeMinutes) {
        return skip('too-fresh', media.id, { seasonNumber, episodeNumber });
      }
    }

    return {
      id: entry.id,
      mediaId: media.id,
      seasonNumber,
      episodeNumber,
      isFullSeason: se.isFullSeason,
      decision: 'grab',
    };
  }

  // ===========================================================================
  // A4 — releases.score
  // ===========================================================================

  private async releasesScore(p: {
    mediaId: number;
    seasonNumber?: number;
    episodeNumber?: number;
    releases: {
      id: string;
      title: string;
      size: number;
      seeders: number;
      leechers: number;
      publishDate: string;
      freeleech?: boolean;
      downloadVolumeFactor?: number;
      sourceRef: string;
      minSeeders?: number;
      unknownLanguageIsoCode?: string;
      blocked: boolean;
    }[];
  }): Promise<ScoredReleaseOut[]> {
    const media = await this.mediaRepo.findOne({ where: { id: p.mediaId } });
    if (!media) return [];

    const { allowed, allowedLangs } =
      this.profiles.resolveAllowedForMedia(media);
    const { expectedTitles } = resolveSearchTitles(media);
    // Both read once per call: the scorer runs its callback per candidate, and this
    // route is called once per indexer while a streamed search fills in.
    const [sizeByQuality, customFormats] = await Promise.all([
      this.qualityDefs.getSizeLimitsMap(),
      this.customFormats.findAll(),
    ]);

    type CandidateWithId = ReleaseCandidate & { id: string };
    const candidates: CandidateWithId[] = p.releases.map((r, i) => ({
      id: r.id,
      title: r.title,
      downloadUrl: '',
      sourceId: i,
      sourceName: r.sourceRef,
      size: r.size,
      seeders: r.seeders,
      leechers: r.leechers,
      publishDate: r.publishDate,
      freeleech: r.freeleech ?? false,
      downloadVolumeFactor: r.downloadVolumeFactor ?? 1,
    }));
    const sourceMinSeeders = new Map(
      p.releases.map((r, i) => [i, r.minSeeders ?? 0]),
    );
    const sourceUnknownLang = new Map<number, string | undefined>(
      p.releases.map((r, i) => [i, r.unknownLanguageIsoCode]),
    );
    // The plugin owns the blocklist table now — it tells us per release
    // rather than us querying, keyed the same way as the two maps above.
    const sourceBlocked = new Map(p.releases.map((r, i) => [i, r.blocked]));

    // `scoreAndSortReleases` is declared to return `ScoredRelease[]` (no `id`),
    // but every row is a spread of its input candidate — `id` rides along.
    const scored = (await scoreAndSortReleases(
      candidates,
      {
        allowed,
        allowedLangs,
        sizeByQuality,
        sourceMinSeeders,
        sourceUnknownLang,
        runtimeMinutes: await this.scoringRuntimeMinutes(media, p.seasonNumber, p.episodeNumber),
        expectedTitle: expectedTitles,
        expectedSeason: p.seasonNumber,
        expectedEpisode: p.episodeNumber,
        // A series' year is its first-aired year, which says nothing about a later season's
        // releases — only a movie's year identifies the work a release must be.
        expectedYear: media.type === MediaType.MOVIE ? media.year : null,
        // Recomputed here rather than sent by the caller: only core can map a quality to a
        // resolution, and the profile's "upgrade resolution only" toggle had no enforcement
        // anywhere after the acquisition split.
        minResolution: await this.minResolutionFor(media, p.seasonNumber, p.episodeNumber),
      },
      {
        scoreCustomFormats: (title, meta) =>
          Promise.resolve(this.customFormats.scoreReleaseWith(customFormats, title, meta)),
        isBlocked: (_title, i) =>
          Promise.resolve(sourceBlocked.get(i) ?? false),
      },
    )) as unknown as (CandidateWithId &
      Awaited<ReturnType<typeof scoreAndSortReleases>>[number])[];

    return scored.map((row) => ({
      id: row.id,
      qualityId: row.qualityId,
      qualityName: row.qualityName,
      rank: row.rank,
      allowed: row.allowed,
      customFormatScore: row.customFormatScore,
      blocklisted: row.blocklisted,
      languageId: row.languageId,
      languageName: row.languageName,
      languageAllowed: row.languageAllowed,
      isFullSeason: row.isFullSeason,
      // Kept null rather than flattened to 0: without a runtime the deviation is unknown, and 0
      // reads as a perfect size match — which promoted an unmeasurable release at the last tiebreak.
      sizeDeviation: row.sizeDeviation ?? null,
      videoCodec: row.videoCodec,
      rejections: row.rejections.map((r) => ({ code: r.code, params: r.params })),
    }));
  }

  /**
   * The on-disk resolution a release must beat, or 0 when the profile does not ask for it. Mirrors
   * `buildWant`: the rule applies to an upgrade, never to something genuinely missing.
   */
  private async minResolutionFor(
    media: Media,
    seasonNumber?: number,
    episodeNumber?: number,
  ): Promise<number> {
    if (!media.qualityProfile?.resolutionUpgradeOnly) return 0;

    let season: Season | null = null;
    let episode: Episode | null = null;
    if (media.type === MediaType.SERIES && seasonNumber != null) {
      season = await this.seasonRepo.findOne({
        where: { media: { id: media.id }, seasonNumber },
      });
      if (season && episodeNumber != null) {
        episode = await this.episodeRepo.findOne({
          where: { season: { id: season.id }, episodeNumber },
        });
      }
    }
    const files = await this.filesForClassification(media, season, episode);
    // Nothing on disk is a `missing` grab, which the toggle deliberately does not gate.
    if (!files.length) return 0;
    return maxResolutionFromQualityStrings(files);
  }

  /**
   * The runtime the size limits are judged against. `media.runtime` comes from TMDB's
   * `episode_run_time`, which is empty for a great many series — and a runtime of zero disables
   * the size rule entirely, in both directions. Episodes carry their own, so an episode-scoped
   * request uses that one and a season-scoped request sums the season's.
   */
  private async scoringRuntimeMinutes(
    media: Media,
    seasonNumber?: number,
    episodeNumber?: number,
  ): Promise<number> {
    if (media.type !== MediaType.SERIES || seasonNumber == null) return media.runtime ?? 0;

    const qb = this.episodeRepo
      .createQueryBuilder('ep')
      .innerJoin('ep.season', 'season')
      .select('COALESCE(SUM(ep.runtime), 0)', 'total')
      .where('season.mediaId = :mediaId', { mediaId: media.id })
      .andWhere('season.seasonNumber = :seasonNumber', { seasonNumber });
    if (episodeNumber != null) {
      qb.andWhere('ep.episodeNumber = :episodeNumber', { episodeNumber });
    }
    const row = await qb.getRawOne<{ total: string }>();
    const total = Number(row?.total ?? 0);
    if (total > 0) return total;

    // No per-episode runtime either: fall back to the series figure, scaled for a pack so a
    // whole season is not judged against one episode's ceiling.
    const perEpisode = media.runtime ?? 0;
    if (perEpisode <= 0 || episodeNumber != null) return perEpisode;
    const count = await this.episodeRepo
      .createQueryBuilder('ep')
      .innerJoin('ep.season', 'season')
      .where('season.mediaId = :mediaId', { mediaId: media.id })
      .andWhere('season.seasonNumber = :seasonNumber', { seasonNumber })
      .getCount();
    return perEpisode * Math.max(count, 1);
  }

  // ===========================================================================
  // A5 — media.resolve
  // ===========================================================================

  private async mediaResolve(p: {
    mediaIds?: number[];
    seasonIds?: number[];
    episodeIds?: number[];
  }): Promise<Record<string, MediaResolveEntry>> {
    const mediaIds = p.mediaIds ?? [];
    const seasonIds = p.seasonIds ?? [];
    const episodeIds = p.episodeIds ?? [];
    const total = mediaIds.length + seasonIds.length + episodeIds.length;
    if (total > QUEUE_PAGE_SIZE_MAX) {
      throw new Error(
        `media.resolve: ${total} ids exceeds the ${QUEUE_PAGE_SIZE_MAX} limit`,
      );
    }

    const out: Record<string, MediaResolveEntry> = {};

    if (mediaIds.length) {
      const rows = await this.mediaRepo.find({ where: { id: In(mediaIds) } });
      for (const m of rows) out[`media:${m.id}`] = this.mediaLabel(m);
    }
    if (seasonIds.length) {
      const rows = await this.seasonRepo.find({
        where: { id: In(seasonIds) },
        relations: ['media'],
      });
      for (const s of rows) {
        const label = this.mediaLabel(s.media);
        out[`season:${s.id}`] = { ...label, seasonNumber: s.seasonNumber };
      }
    }
    if (episodeIds.length) {
      const rows = await this.episodeRepo.find({
        where: { id: In(episodeIds) },
        relations: ['season', 'season.media'],
      });
      for (const e of rows) {
        const label = this.mediaLabel(e.season.media);
        out[`episode:${e.id}`] = {
          ...label,
          seasonNumber: e.season.seasonNumber,
          episodeNumber: e.episodeNumber,
          episodeTitle: e.title ?? undefined,
        };
      }
    }
    return out;
  }

  private mediaLabel(media: Media): MediaResolveEntry {
    return {
      title: media.title,
      kind: media.type === MediaType.MOVIE ? 'movie' : 'series',
      libraryId: media.libraryId ?? 0,
    };
  }

  // ===========================================================================
  // A6 — media.exists
  // ===========================================================================

  private async mediaExists(p: { mediaIds: number[] }): Promise<number[]> {
    if (!p.mediaIds.length) return [];
    const rows = await this.mediaRepo.find({
      where: { id: In(p.mediaIds) },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ===========================================================================
  // B1 — requests.markInProgress
  // ===========================================================================

  private async requestsMarkInProgress(p: {
    idempotencyKey: string;
    mediaId: number;
    seasonNumber?: number;
  }): Promise<void> {
    await this.requestLifecycle.markInProgress(p.mediaId, p.seasonNumber);
  }

  // ===========================================================================
  // C1 — library.ingest
  // ===========================================================================

  private async libraryIngest(p: {
    idempotencyKey: string;
    mediaId: number;
    paths: string[];
    transfer: 'copy' | 'move';
    fallbackQuality?: string;
    sourceLabel: string;
  }): Promise<{
    imported: { mediaFileId: number; relativePath: string; quality: string }[];
    alreadyPresent: string[];
    seasonNumber?: number;
    episodeNumber?: number;
  }> {
    const files = await this.resolveAgainstGrantedRoots(p.paths);

    // `force`/`uniquifyOnCollision` are left false: a retried call resolves
    // the same destination and is a safe no-op, which is the idempotency
    // guarantee `idempotencyKey` asks for — no separate dedupe table needed.
    const result = await this.libraryIngestService.ingest({
      mediaId: p.mediaId,
      files,
      transfer: p.transfer,
      fallbackQuality: p.fallbackQuality,
      releaseName: p.sourceLabel,
      sourceLabel: p.sourceLabel,
    });

    const imported = result.imported.map((x) => ({
      mediaFileId: x.file.id,
      relativePath: x.file.relativePath,
      quality: x.file.quality,
    }));

    // Dispatched before the episode lookup below: neither payload carries the
    // season or episode number, so resolving them first only delays the alert.
    if (imported.length) {
      const media = await this.mediaRepo.findOne({ where: { id: p.mediaId } });
      if (media) {
        void this.notifications.dispatch('download.complete', {
          title: media.title,
          quality: imported[0].quality,
          sourceTitle: p.sourceLabel,
        });
        void this.mediaServers.dispatch('download.complete', {
          title: media.title,
          path: media.path,
        });
      }
    }

    let seasonNumber: number | undefined;
    let episodeNumber: number | undefined;
    if (result.imported.length === 1 && result.imported[0].episodeId != null) {
      const episode = await this.episodeRepo.findOne({
        where: { id: result.imported[0].episodeId },
        relations: ['season'],
      });
      if (episode) {
        episodeNumber = episode.episodeNumber;
        seasonNumber = episode.season?.seasonNumber;
      }
    }

    return { imported, alreadyPresent: result.alreadyPresent, seasonNumber, episodeNumber };
  }

  /** `realpath`s `rawPath` and refuses it unless it resolves inside one of `roots`. */
  /** A plugin may only ingest under the `ingestRoots` it declared and the admin
   *  consented to; no identity and no row both mean no grant, never an open one. */
  private async resolveAgainstGrantedRoots(
    paths: string[],
  ): Promise<{ path: string }[]> {
    const pluginId = this.currentPluginId();
    const registration = pluginId
      ? await this.pluginRegistrationRepo.findOne({
          where: { pluginId },
        })
      : null;
    const roots = registration?.ingestRoots ?? [];
    if (!roots.length) {
      throw new Error(
        `library.ingest: no ingestRoots configured for plugin "${pluginId}"`,
      );
    }
    return paths.map((raw) => ({
      path: this.resolveUnderIngestRoot(raw, roots),
    }));
  }

  private resolveUnderIngestRoot(rawPath: string, roots: string[]): string {
    const real = fs.realpathSync(rawPath);
    for (const root of roots) {
      let realRoot: string;
      try {
        realRoot = fs.realpathSync(root);
      } catch {
        continue;
      }
      const rel = path.relative(realRoot, real);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)))
        return real;
    }
    throw new Error(
      `library.ingest: "${rawPath}" is outside every configured ingest root`,
    );
  }

  // ===========================================================================
  // D1 — events.publish
  // ===========================================================================

  private async eventsPublish(events: AcquisitionEvent[]): Promise<void> {
    for (const event of events) await this.publishOne(event);
  }

  private async publishOne(event: AcquisitionEvent): Promise<void> {
    switch (event.type) {
      case 'acquisition.grabbed':
        // No `queue.updated` here: every direct grab call site emits only the
        // domain event, and the sidebar badge doesn't move on a grab.
        this.events.emitDomain({
          type: 'acquisition.grabbed',
          mediaId: event.mediaId,
          seasonNumber: event.seasonNumber,
        });
        return;
      case 'acquisition.imported': {
        const media = await this.mediaRepo.findOne({
          where: { id: event.mediaId },
        });
        void this.notifications.dispatch('download.complete', {
          title: media?.title ?? '',
          quality: event.quality,
          sourceTitle: event.sourceTitle,
        });
        const recipients = await this.sseAudience.recipientsForMedia(
          event.mediaId,
        );
        this.events.emitToUsers(recipients, {
          type: 'import.complete',
          mediaId: event.mediaId,
          title: media?.title ?? '',
          seasonNumber: event.seasonNumber,
          episodeNumber: event.episodeNumber,
        });
        this.events.emit({ type: 'queue.updated' });
        void this.mediaServers.dispatch('download.complete', {
          title: media?.title ?? '',
          path: media?.path ?? null,
        });
        return;
      }
      case 'acquisition.failed': {
        // `event.title` is the caller's release title, never re-derived from
        // `media.title` — every real call site means the release, not the media.
        const recipients = await this.sseAudience.recipientsForMedia(
          event.mediaId,
        );
        this.events.emitToUsers(recipients, {
          type: 'import.failed',
          mediaId: event.mediaId,
          title: event.title,
          error: event.reason,
        });
        this.events.emit({ type: 'queue.updated' });
        return;
      }
      case 'acquisition.queue.changed':
        this.events.emit({ type: 'queue.updated' });
        return;
      case 'acquisition.stalled.removed': {
        const recipients = await this.sseAudience.recipientsForMedia(
          event.mediaId,
        );
        this.events.emitToUsers(recipients, {
          type: 'stalled.removed',
          title: event.title,
        });
        this.events.emit({ type: 'queue.updated' });
        return;
      }
      case 'acquisition.progress':
        await this.pushProgress({
          mediaId: event.mediaId,
          ref: event.ref,
          progress: event.progress,
          etaSeconds: event.etaSeconds ?? undefined,
          state: event.state,
        });
        return;
    }
  }

  // ===========================================================================
  // D2 — notifications.dispatch
  // ===========================================================================

  private async notificationsDispatch(p: {
    event: 'grab.started';
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.notifications.dispatch(p.event, p.payload);
  }

  // ===========================================================================
  // D3 — counts.set
  // ===========================================================================

  private countsSet(p: { key: string; value: number }): Promise<void> {
    const pluginId = this.currentPluginId();
    if (pluginId) this.countsCache.set(pluginId, p.key, p.value);
    return Promise.resolve();
  }

  // ===========================================================================
  // D4 — events.emitOwn
  // ===========================================================================

  private async eventsEmitOwn(p: {
    type: string;
    payload: unknown;
    audience: 'all' | { mediaId: number } | { userId: number };
  }): Promise<void> {
    const type = `plugin.${this.currentPluginId()}.${p.type}`;
    if (p.audience === 'all') {
      this.events.emitRaw(type, p.payload, null);
      return;
    }
    if ('userId' in p.audience) {
      this.events.emitRaw(type, p.payload, [p.audience.userId]);
      return;
    }
    const recipients = await this.sseAudience.recipientsForMedia(
      p.audience.mediaId,
    );
    this.events.emitRaw(type, p.payload, recipients);
  }

  // ===========================================================================
  // D5 — progress.set
  // ===========================================================================

  private async progressSet(p: {
    mediaId: number;
    seasonNumber?: number;
    episodeNumber?: number;
    ref: string;
    progress: number;
    bytesPerSecond?: number;
    etaSeconds?: number;
    state: DownloadProgressState;
  }): Promise<void> {
    const gate = this.progressGates.get(p.mediaId);
    const now = Date.now();
    if (gate && now - gate.lastEmitMs < PROGRESS_MIN_INTERVAL_MS) {
      // Newest wins: the trailing emit carries the latest state, so nothing is merely dropped.
      gate.pending = p;
      if (!gate.timer) {
        gate.timer = setTimeout(
          () => this.flushProgress(p.mediaId),
          PROGRESS_MIN_INTERVAL_MS - (now - gate.lastEmitMs),
        );
        gate.timer.unref();
      }
      return;
    }
    this.progressGates.set(p.mediaId, { lastEmitMs: now, pending: null, timer: null });
    await this.pushProgress(p);
  }

  private flushProgress(mediaId: number): void {
    const gate = this.progressGates.get(mediaId);
    if (!gate) return;
    gate.timer = null;
    const pending = gate.pending;
    gate.pending = null;
    if (!pending) {
      // Idle for a whole window: drop the gate so the map cannot grow with every media ever seen.
      this.progressGates.delete(mediaId);
      return;
    }
    gate.lastEmitMs = Date.now();
    void this.pushProgress(pending);
  }

  private async pushProgress(p: {
    mediaId: number;
    seasonNumber?: number;
    episodeNumber?: number;
    ref?: string;
    progress: number;
    bytesPerSecond?: number;
    etaSeconds?: number;
    state: DownloadProgressState;
  }): Promise<void> {
    const media = await this.mediaRepo.findOne({ where: { id: p.mediaId } });
    const recipients = await this.sseAudience.recipientsForMedia(p.mediaId);
    if (!recipients.length) return;
    this.events.emitToUsers(recipients, {
      type: 'download.progress',
      mediaId: p.mediaId,
      mediaType: media?.type === MediaType.MOVIE ? 'movie' : 'series',
      seasonNumber: p.seasonNumber,
      episodeNumber: p.episodeNumber,
      hash: p.ref,
      progress: p.progress,
      dlspeed: p.bytesPerSecond ?? 0,
      eta: p.etaSeconds ?? 0,
      state: p.state,
    });
  }

  // ===========================================================================
  // E1 — config.get
  // ===========================================================================

  private async configGet(p: {
    keys?: string[];
  }): Promise<Record<string, string>> {
    const prefix = `plugin.${this.currentPluginId()}.`;
    const out: Record<string, string> = {};
    if (p.keys?.length) {
      for (const key of p.keys) {
        const value = await this.settings.get(prefix + key);
        if (value != null) out[key] = value;
      }
      return out;
    }
    const all = await this.settings.getAll();
    for (const [key, value] of Object.entries(all)) {
      if (value != null && key.startsWith(prefix))
        out[key.slice(prefix.length)] = value;
    }
    return out;
  }

  // ===========================================================================
  // E2 — config.set
  // ===========================================================================

  private async configSet(p: {
    key: string;
    value: string | null;
  }): Promise<void> {
    const pluginId = this.currentPluginId();
    // Tagged with the writer so the config note is not echoed back to the plugin that made it.
    await this.settings.set(`plugin.${pluginId}.${p.key}`, p.value, pluginId ?? undefined);
  }

  // ===========================================================================
  // Shared helpers
  // ===========================================================================

  private buildAcquisitionTarget(
    media: Media,
    decision: SearchDecision | null,
    files: { quality?: string | null }[],
  ): AcquisitionTarget | null {
    // `libraryId` is a `@RelationId`, so it is only populated when the relation is joined —
    // `library.id` covers the query that selects the relation instead. Silence here is what let
    // every series candidate vanish unreported, so a drop now says so.
    const libraryId = media.libraryId ?? media.library?.id ?? null;
    if (libraryId == null) {
      this.logger.warn(
        `candidate #${media.id} "${media.title}" dropped — no library id on the loaded media`,
      );
      return null;
    }
    const { searchTitle, expectedTitles } = resolveSearchTitles(media);
    return {
      mediaId: media.id,
      kind: media.type === MediaType.MOVIE ? 'movie' : 'series',
      title: media.title,
      originalTitle: media.originalTitle ?? null,
      alternativeTitles: media.alternativeTitles ?? [],
      year: media.year ?? null,
      runtimeMinutes: media.runtime ?? null,
      imdbId: media.imdbId ?? null,
      tmdbId: media.tmdbId ?? null,
      tvdbId: media.tvdbId ?? null,
      libraryId,
      want: this.buildWant(media, decision, files),
      expectedTitles,
      searchTitle,
    };
  }

  private buildWant(
    media: Media,
    decision: SearchDecision | null,
    files: { quality?: string | null }[],
  ): AcquisitionTarget['want'] {
    // `unprofiled` has nothing to score against; `skip` does, and only by hand (buildForCandidates).
    if (!decision || decision.mode === 'unprofiled') return null;
    const { allowed, allowedLangs } =
      this.profiles.resolveAllowedForMedia(media);
    // Applies to `skip` too: a by-hand search must not present what the profile would refuse.
    const resolutionUpgradeOnly =
      decision.mode !== 'missing' &&
      !!media.qualityProfile?.resolutionUpgradeOnly;
    return {
      decision: decision.mode,
      allowedQualityIds: [...allowed],
      allowedLanguageIds: [...allowedLangs],
      minRankExclusive: decision.minRankExclusive,
      // `Infinity` (JSON-unsafe) means "no ceiling" — MAX_SAFE_INTEGER says the
      // same thing to a plugin without breaking JSON across the wire.
      maxRankInclusive: Number.isFinite(decision.maxRankInclusive)
        ? decision.maxRankInclusive
        : Number.MAX_SAFE_INTEGER,
      minResolution: resolutionUpgradeOnly
        ? maxResolutionFromQualityStrings(files)
        : 0,
      resolutionUpgradeOnly,
    };
  }

  /** The unattended feed: a `skip`/`unprofiled` target must never reach a plugin's scheduler. */
  private buildForCandidates(
    media: Media,
    decision: SearchDecision,
    files: { quality?: string | null }[],
  ): AcquisitionTarget | null {
    if (decision.mode === 'skip' || decision.mode === 'unprofiled')
      return null;
    return this.buildAcquisitionTarget(media, decision, files);
  }

  private buildFromMovieTarget(t: MovieTarget): AcquisitionTarget | null {
    const decision = this.autoGrab.classifyForSearch(t.media, t.files);
    return this.buildForCandidates(t.media, decision, t.files);
  }

  private buildFromEpisodeTarget(
    t: EpisodeTarget,
    episodeCount: number,
  ): AcquisitionTarget | null {
    const decision = this.autoGrab.classifyForSearch(t.media, t.files);
    const target = this.buildForCandidates(t.media, decision, t.files);
    if (!target) return null;
    target.season = {
      id: t.season.id,
      number: t.season.seasonNumber,
      episodeCount,
    };
    target.episode = {
      id: t.episode.id,
      number: t.episode.episodeNumber,
      endNumber: t.episode.endEpisodeNumber,
      airDate: t.episode.airDate ?? null,
      title: t.episode.title ?? null,
    };
    return target;
  }

  private buildFromSeasonPackTarget(
    t: SeasonPackTarget,
  ): AcquisitionTarget | null {
    const decision = this.autoGrab.classifyForSearch(t.media, t.files);
    const target = this.buildForCandidates(t.media, decision, t.files);
    if (!target) return null;
    target.season = {
      id: t.season.id,
      number: t.season.seasonNumber,
      episodeCount: t.totalEpisodeCount,
    };
    return target;
  }

  private episodesOfSeason(seasonId: number): Promise<Episode[]> {
    return this.episodeRepo.find({ where: { season: { id: seasonId } } });
  }

  private async episodeCountsBySeasons(
    seasonIds: number[],
  ): Promise<Map<number, number>> {
    if (!seasonIds.length) return new Map();
    const rows = await this.episodeRepo
      .createQueryBuilder('ep')
      .select('ep.seasonId', 'seasonId')
      .addSelect('COUNT(*)', 'cnt')
      .where('ep.seasonId IN (:...ids)', { ids: seasonIds })
      .groupBy('ep.seasonId')
      .getRawMany<{ seasonId: number; cnt: string }>();
    return new Map(rows.map((r) => [Number(r.seasonId), Number(r.cnt)]));
  }

  private async filesForClassification(
    media: Media,
    season: Season | null,
    episode: Episode | null,
  ): Promise<{ quality?: string | null }[]> {
    if (media.type === MediaType.MOVIE) {
      const files = await this.mediaFileRepo.find({
        where: { media: { id: media.id } },
      });
      return files.map((f) => ({ quality: f.quality }));
    }
    // Coverage, not raw `hasFile` — `episode-coverage.util.ts` states the rule this used to break:
    // a shadowed episode of a multi-episode file has no file of its own, and reading the flag made
    // its season classify as entirely missing, with an open rank window that would take any pack.
    if (episode) {
      const siblings = await this.episodesOfSeason(episode.seasonId);
      return this.filesForEpisode(episode, onDiskEpisodeNumbers(siblings));
    }
    if (season) {
      const episodes = await this.episodesOfSeason(season.id);
      return this.filesForSeasonPack(episodes, onDiskEpisodeNumbers(episodes));
    }
    return [];
  }

  private async filesForEpisode(
    episode: Episode,
    onDisk: ReadonlySet<number>,
  ): Promise<{ quality?: string | null }[]> {
    if (!onDisk.has(episode.episodeNumber)) return [];
    const files = await this.mediaFileRepo.find({
      where: { episode: { id: episode.id } },
    });
    if (!files.length) return [{ quality: null }];
    let best: string | null = null;
    let bestRank = -1;
    for (const f of files) {
      const r = rankFromQualityString(f.quality);
      if (r > bestRank) {
        bestRank = r;
        best = f.quality;
      }
    }
    return [{ quality: best }];
  }

  /** Season-pack semantics: `[]` while any covered episode is missing (grab
   *  everything), else the weakest on-disk quality (cutoff-gates the pack). */
  private async filesForSeasonPack(
    episodes: Episode[],
    onDisk: ReadonlySet<number>,
  ): Promise<{ quality?: string | null }[]> {
    if (!episodes.length) return [];
    const perEpisode = await Promise.all(
      episodes.map((e) => this.filesForEpisode(e, onDisk)),
    );
    if (perEpisode.some((f) => f.length === 0)) return [];
    let weakest: string | null = null;
    let weakestRank = Number.POSITIVE_INFINITY;
    for (const f of perEpisode) {
      const r = rankFromQualityString(f[0].quality);
      if (r < weakestRank) {
        weakestRank = r;
        weakest = f[0].quality ?? null;
      }
    }
    return [{ quality: weakest }];
  }

  /** Mirrors `AcquisitionSchedulerService.isAvailable` exactly — the full
   *  minimum-availability state machine, not just `releaseDate`, or a movie
   *  a plugin fetches through this method would get searched too early. */
  private isAvailable(media: Media, today: string): boolean {
    switch (media.minimumAvailability) {
      case MinimumAvailability.ANNOUNCED:
        return true;
      case MinimumAvailability.IN_CINEMAS:
        return !!(media.inCinemas && media.inCinemas <= today);
      case MinimumAvailability.RELEASED:
        if (media.digitalRelease && media.digitalRelease <= today) return true;
        if (media.physicalRelease && media.physicalRelease <= today)
          return true;
        if (media.inCinemas && this.addDaysIso(media.inCinemas, 90) <= today)
          return true;
        if (media.releaseDate && media.releaseDate <= today) return true;
        return media.status === MediaStatus.RELEASED;
      default:
        return true;
    }
  }

  private addDaysIso(isoDate: string, days: number): string {
    const d = new Date(isoDate);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
}

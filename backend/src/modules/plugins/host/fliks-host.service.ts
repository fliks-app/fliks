import { Inject, Injectable } from '@nestjs/common';
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
import { MediaType } from '../../../common/enums';
import { Media } from '../../media/entities/media.entity';
import { Season } from '../../media/entities/season.entity';
import { Episode } from '../../media/entities/episode.entity';
import { MediaFile } from '../../media/entities/media-file.entity';
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
import { BlocklistService } from '../../blocklist/blocklist.service';
import { BlocklistEntry } from '../../blocklist/entities/blocklist-entry.entity';
import { RequestLifecycleService } from '../../requests/request-lifecycle.service';
import { LibraryIngestService } from '../../../common/library-ingest/library-ingest.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { MediaServersService } from '../../media-servers/media-servers.service';
import { SettingsService } from '../../settings/settings.service';
import { EventsService } from '../../scheduler/events.service';
import { SseAudienceService } from '../../scheduler/sse-audience.service';
import { PluginRegistration } from '../entities/plugin-registration.entity';
import { CleanupProfile } from '../../cleanup-profiles/entities/cleanup-profile.entity';
import {
  maxResolutionFromQualityStrings,
  rankFromQualityString,
  resolveSearchTitles,
  scoreAndSortReleases,
  titleMatchesExpectation,
  type ReleaseCandidate,
} from '../../../common/release-scoring';
import { parseSeasonEpisode } from '../../../common/release-parsing';
import { PluginCountsCacheService } from './plugin-counts-cache.service';
import { PLUGIN_HOST_PLUGIN_ID } from './plugin-host.constants';

/** `media.resolve`'s own bound — restated because `plugins/download/` (where the
 *  original `QUEUE_PAGE_SIZE_MAX` lives) is outside this file's import boundary. */
const QUEUE_PAGE_SIZE_MAX = 100;

/** `acquisition.candidates`'s own bound, per the contract's doc comment. */
const MAX_CANDIDATES_LIMIT = 500;

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

function rejectionDetail(rejection: {
  params?: Record<string, number | string>;
}): string | undefined {
  if (!rejection.params) return undefined;
  const parts = Object.entries(rejection.params).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : undefined;
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: string }).code === '23505'
  );
}

/**
 * Core's implementation of the 17 plugin-facing host methods. Every value it
 * returns is a plain, JSON-safe object built field-by-field from entities —
 * never the entity itself — because the same shape crosses a socket once the
 * transport changes (Phase 10.4).
 */
@Injectable()
export class FliksHostImpl implements PluginHostApi {
  constructor(
    @Inject(PLUGIN_HOST_PLUGIN_ID) private readonly pluginId: string,
    @InjectRepository(Media) private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Season) private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(BlocklistEntry)
    private readonly blocklistEntryRepo: Repository<BlocklistEntry>,
    @InjectRepository(PluginRegistration)
    private readonly pluginRegistrationRepo: Repository<PluginRegistration>,
    @InjectRepository(CleanupProfile)
    private readonly cleanupProfileRepo: Repository<CleanupProfile>,
    private readonly autoGrab: AutoGrabPipelineService,
    private readonly acquisitionCandidates: AcquisitionCandidatesService,
    private readonly profiles: ProfilesService,
    private readonly qualityDefs: QualityDefinitionsService,
    private readonly customFormats: CustomFormatsService,
    private readonly blocklist: BlocklistService,
    private readonly requestLifecycle: RequestLifecycleService,
    private readonly libraryIngestService: LibraryIngestService,
    private readonly notifications: NotificationsService,
    private readonly mediaServers: MediaServersService,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
    private readonly sseAudience: SseAudienceService,
    private readonly countsCache: PluginCountsCacheService,
  ) {}

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

  'blocklist.add': PluginHostApi['blocklist.add'] = (p) => this.blocklistAdd(p);
  'blocklist.check': PluginHostApi['blocklist.check'] = (p) =>
    this.blocklistCheck(p);
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
    const wantMovies = p.kind !== 'series';
    const wantSeries = p.kind !== 'movie';
    const targets: AcquisitionTarget[] = [];

    if (wantMovies) {
      const movieTargets = await this.acquisitionCandidates.listMovieTargets(
        p.mediaIds,
      );
      for (const t of movieTargets) {
        if (t.media.releaseDate && t.media.releaseDate > p.availableOn)
          continue;
        const target = this.buildFromMovieTarget(t);
        if (target) targets.push(target);
      }
    }

    if (wantSeries) {
      const episodeTargets = (
        await this.acquisitionCandidates.listEpisodeTargets(p.mediaIds)
      ).filter((t) => !t.episode.airDate || t.episode.airDate <= p.availableOn);
      const packs =
        await this.acquisitionCandidates.groupIntoSeasonPacks(episodeTargets);
      const packedSeasonIds = new Set(packs.map((pk) => pk.season.id));
      const singles = episodeTargets.filter(
        (t) => !packedSeasonIds.has(t.season.id),
      );
      const episodeCountBySeason = await this.episodeCountsBySeasons([
        ...new Set(singles.map((t) => t.season.id)),
      ]);

      for (const pk of packs) {
        const target = this.buildFromSeasonPackTarget(pk);
        if (target) targets.push(target);
      }
      for (const t of singles) {
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

    const offset = p.cursor ? Math.max(0, parseInt(p.cursor, 10) || 0) : 0;
    const items = targets.slice(offset, offset + limit);
    const cursor =
      offset + items.length < targets.length
        ? String(offset + items.length)
        : null;
    return { items, cursor };
  }

  // ===========================================================================
  // A3 — releases.match
  // ===========================================================================

  private async releasesMatch(p: {
    titles: { id: string; title: string; publishDate: string }[];
    minAgeMinutes?: number;
  }): Promise<ReleaseMatchResult[]> {
    const library = await this.mediaRepo.find({ where: { monitored: true } });
    const out: ReleaseMatchResult[] = [];
    for (const entry of p.titles) {
      out.push(await this.matchOneRelease(entry, library, p.minAgeMinutes));
    }
    return out;
  }

  private async matchOneRelease(
    entry: { id: string; title: string; publishDate: string },
    library: Media[],
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

    const media = library.find((m) =>
      titleMatchesExpectation(entry.title, [
        m.title,
        m.originalTitle ?? '',
        ...(m.alternativeTitles ?? []),
      ]),
    );
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
        files = await this.filesForSeasonPack(episodes);
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
        files = await this.filesForEpisode(episode);
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
    }[];
  }): Promise<ScoredReleaseOut[]> {
    const media = await this.mediaRepo.findOne({ where: { id: p.mediaId } });
    if (!media) return [];

    const { allowed, allowedLangs } =
      this.profiles.resolveAllowedForMedia(media);
    const { expectedTitles } = resolveSearchTitles(media);
    const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();

    type CandidateWithId = ReleaseCandidate & { id: string };
    const candidates: CandidateWithId[] = p.releases.map((r, i) => ({
      id: r.id,
      title: r.title,
      downloadUrl: '',
      indexerId: i,
      indexerName: r.sourceRef,
      size: r.size,
      seeders: r.seeders,
      leechers: r.leechers,
      publishDate: r.publishDate,
      freeleech: r.freeleech ?? false,
      downloadVolumeFactor: r.downloadVolumeFactor ?? 1,
    }));
    const indexerMinSeeders = new Map(
      p.releases.map((r, i) => [i, r.minSeeders ?? 0]),
    );
    const indexerUnknownLang = new Map<number, string | undefined>(
      p.releases.map((r, i) => [i, r.unknownLanguageIsoCode]),
    );

    // `scoreAndSortReleases` is declared to return `ScoredRelease[]` (no `id`),
    // but every row is a spread of its input candidate — `id` rides along.
    const scored = (await scoreAndSortReleases(
      candidates,
      {
        allowed,
        allowedLangs,
        sizeByQuality,
        indexerMinSeeders,
        indexerUnknownLang,
        runtimeMinutes: media.runtime ?? 0,
        expectedTitle: expectedTitles,
      },
      {
        scoreCustomFormats: (title, meta) =>
          this.customFormats.scoreRelease(title, meta),
        isBlocked: (title) => this.blocklist.isBlocked(title),
      },
    )) as unknown as (CandidateWithId &
      Awaited<ReturnType<typeof scoreAndSortReleases>>[number])[];

    return scored.map((row) => ({
      id: row.id,
      qualityId: row.qualityId,
      rank: row.rank,
      allowed: row.allowed,
      customFormatScore: row.customFormatScore,
      blocklisted: row.blocklisted,
      languageId: row.languageId,
      languageAllowed: row.languageAllowed,
      isFullSeason: row.isFullSeason,
      sizeDeviation: row.sizeDeviation ?? 0,
      videoCodec: row.videoCodec,
      rejections: row.rejections.map((r) => ({
        code: r.code,
        detail: rejectionDetail(r),
      })),
    }));
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
      for (const m of rows) out[`media:${m.id}`] = await this.mediaLabel(m);
    }
    if (seasonIds.length) {
      const rows = await this.seasonRepo.find({
        where: { id: In(seasonIds) },
        relations: ['media'],
      });
      for (const s of rows) {
        const label = await this.mediaLabel(s.media);
        out[`season:${s.id}`] = { ...label, seasonNumber: s.seasonNumber };
      }
    }
    if (episodeIds.length) {
      const rows = await this.episodeRepo.find({
        where: { id: In(episodeIds) },
        relations: ['season', 'season.media'],
      });
      for (const e of rows) {
        const label = await this.mediaLabel(e.season.media);
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

  private async mediaLabel(media: Media): Promise<MediaResolveEntry> {
    const kind: MediaKind = media.type === MediaType.MOVIE ? 'movie' : 'series';
    const key = media.library?.stalledCleanupProfile;
    const profile = key
      ? await this.cleanupProfileRepo.findOne({ where: { key } })
      : null;
    return {
      title: media.title,
      kind,
      libraryId: media.libraryId ?? 0,
      stalledCleanupProfile: profile
        ? {
            key: profile.key,
            samples: profile.samples,
            intervalMinutes: profile.intervalMinutes,
            autoRestart: profile.autoRestart,
          }
        : null,
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
  // B1 — blocklist.add
  // ===========================================================================

  private async blocklistAdd(p: {
    idempotencyKey: string;
    sourceTitle: string;
    quality?: string;
    mediaId?: number;
    indexerName?: string;
    downloadUrl?: string;
    note: string;
  }): Promise<{ id: number }> {
    try {
      const row = await this.blocklist.create({
        sourceTitle: p.sourceTitle,
        quality: p.quality,
        mediaId: p.mediaId,
        indexerName: p.indexerName,
        downloadUrl: p.downloadUrl,
        note: p.note,
      });
      return { id: row.id };
    } catch (e) {
      // Retrying the same title on a timeout must not error twice — the
      // sourceTitle unique index is the de-dupe key `idempotencyKey` echoes.
      if (!isUniqueViolation(e)) throw e;
      const existing = await this.blocklistEntryRepo
        .createQueryBuilder('b')
        .where('LOWER(b.sourceTitle) = LOWER(:t)', { t: p.sourceTitle })
        .getOne();
      if (existing) return { id: existing.id };
      throw e;
    }
  }

  // ===========================================================================
  // B2 — blocklist.check
  // ===========================================================================

  private async blocklistCheck(p: {
    titles: string[];
  }): Promise<{ blocked: string[] }> {
    const blocked: string[] = [];
    for (const title of p.titles) {
      if (await this.blocklist.isBlocked(title)) blocked.push(title);
    }
    return { blocked };
  }

  // ===========================================================================
  // B3 — requests.markInProgress
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
    seasonNumber?: number;
    episodeNumber?: number;
  }> {
    const registration = await this.pluginRegistrationRepo.findOne({
      where: { pluginId: this.pluginId },
    });
    const roots = registration?.ingestRoots ?? [];
    if (!roots.length) {
      throw new Error(
        `library.ingest: no ingestRoots configured for plugin "${this.pluginId}"`,
      );
    }
    const files = p.paths.map((raw) => ({
      path: this.resolveUnderIngestRoot(raw, roots),
    }));

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

    return { imported, seasonNumber, episodeNumber };
  }

  /** `realpath`s `rawPath` and refuses it unless it resolves inside one of `roots`. */
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
        this.events.emitDomain({
          type: 'acquisition.grabbed',
          mediaId: event.mediaId,
          seasonNumber: event.seasonNumber,
        });
        this.events.emit({ type: 'queue.updated' });
        return;
      case 'acquisition.imported': {
        const media = await this.mediaRepo.findOne({
          where: { id: event.mediaId },
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
        return;
      }
      case 'acquisition.failed': {
        const media = await this.mediaRepo.findOne({
          where: { id: event.mediaId },
        });
        const recipients = await this.sseAudience.recipientsForMedia(
          event.mediaId,
        );
        this.events.emitToUsers(recipients, {
          type: 'import.failed',
          mediaId: event.mediaId,
          title: media?.title ?? '',
          error: event.reason,
        });
        this.events.emit({ type: 'queue.updated' });
        return;
      }
      case 'acquisition.queue.changed':
        this.events.emit({ type: 'queue.updated' });
        return;
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
    this.countsCache.set(p.key, p.value);
    return Promise.resolve();
  }

  // ===========================================================================
  // D4 — events.emitOwn
  // ===========================================================================

  private async eventsEmitOwn(p: {
    type: string;
    payload: unknown;
    audience: 'all' | { mediaId: number };
  }): Promise<void> {
    const type = `plugin.${this.pluginId}.${p.type}`;
    if (p.audience === 'all') {
      this.events.emitRaw(type, p.payload, null);
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
    state: 'queued' | 'active' | 'stalled' | 'paused' | 'importing';
  }): Promise<void> {
    // ponytail: no server-side coalescing yet (plan asks for <=1/media/sec) —
    // add a per-media debounce once a real caller exercises the frequency.
    await this.pushProgress(p);
  }

  private async pushProgress(p: {
    mediaId: number;
    seasonNumber?: number;
    episodeNumber?: number;
    ref?: string;
    progress: number;
    bytesPerSecond?: number;
    etaSeconds?: number;
    state: string;
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
    const prefix = `plugin.${this.pluginId}.`;
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
    await this.settings.set(`plugin.${this.pluginId}.${p.key}`, p.value);
  }

  // ===========================================================================
  // Shared helpers
  // ===========================================================================

  private buildAcquisitionTarget(
    media: Media,
    decision: SearchDecision | null,
    files: { quality?: string | null }[],
  ): AcquisitionTarget | null {
    if (media.libraryId == null) return null;
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
      libraryId: media.libraryId,
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
    if (!decision) return null;
    if (decision.mode === 'skip' || decision.mode === 'unprofiled') return null;
    // Already excluded 'skip'/'unprofiled' above — only the ranked branch remains.
    const active = decision as Extract<
      SearchDecision,
      { mode: 'missing' | 'upgrade' }
    >;
    const { allowed, allowedLangs } =
      this.profiles.resolveAllowedForMedia(media);
    const resolutionUpgradeOnly =
      active.mode === 'upgrade' &&
      !!media.qualityProfile?.resolutionUpgradeOnly;
    return {
      decision: active.mode,
      allowedQualityIds: [...allowed],
      allowedLanguageIds: [...allowedLangs],
      minRankExclusive: active.minRankExclusive,
      // `Infinity` (JSON-unsafe) means "no ceiling" — MAX_SAFE_INTEGER says the
      // same thing to a plugin without breaking JSON across the wire.
      maxRankInclusive: Number.isFinite(active.maxRankInclusive)
        ? active.maxRankInclusive
        : Number.MAX_SAFE_INTEGER,
      minResolution: resolutionUpgradeOnly
        ? maxResolutionFromQualityStrings(files)
        : 0,
      resolutionUpgradeOnly,
    };
  }

  private buildFromMovieTarget(t: MovieTarget): AcquisitionTarget | null {
    const decision = this.autoGrab.classifyForSearch(t.media, t.files);
    return this.buildAcquisitionTarget(t.media, decision, t.files);
  }

  private buildFromEpisodeTarget(
    t: EpisodeTarget,
    episodeCount: number,
  ): AcquisitionTarget | null {
    const decision = this.autoGrab.classifyForSearch(t.media, t.files);
    const target = this.buildAcquisitionTarget(t.media, decision, t.files);
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
    };
    return target;
  }

  private buildFromSeasonPackTarget(
    t: SeasonPackTarget,
  ): AcquisitionTarget | null {
    const decision = this.autoGrab.classifyForSearch(t.media, t.files);
    const target = this.buildAcquisitionTarget(t.media, decision, t.files);
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
    if (episode) return this.filesForEpisode(episode);
    if (season)
      return this.filesForSeasonPack(await this.episodesOfSeason(season.id));
    return [];
  }

  private async filesForEpisode(
    episode: Episode,
  ): Promise<{ quality?: string | null }[]> {
    if (!episode.hasFile) return [];
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
  ): Promise<{ quality?: string | null }[]> {
    if (!episodes.length) return [];
    const perEpisode = await Promise.all(
      episodes.map((e) => this.filesForEpisode(e)),
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
}

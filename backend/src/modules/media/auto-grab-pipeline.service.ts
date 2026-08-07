import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from './entities/media.entity';
import { RequestLifecycleService } from '../requests/request-lifecycle.service';
import { DownloadHistory } from './entities/download-history.entity';
import { buildGrabHistoryRow } from './grab-history.util';
import { Indexer } from '../indexers/entities/indexer.entity';
import { parseReleaseQuality, parseSeasonEpisode } from '../../common/release-parsing';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { CustomFormatsService } from '../profiles/custom-formats.service';
import { QualityDefinitionsService } from '../profiles/quality-definitions.service';
import { ProfilesService } from '../profiles/profiles.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { NamingService } from '../scheduler/naming.service';
import { getAppQualityById } from '../../common/constants/app-qualities';
import {
  ReleaseCandidate,
  ScoredRelease,
  SizeLimits,
  buildIndexerMinSeeders,
  maxResolutionFromQualityStrings,
  rankFromQualityString,
  resolveSearchTitles,
  scoreAndSortReleases,
  formatRejectionForLog,
} from '../../common/release-scoring';

/**
 * Scoring context that's identical across many media in the same SearchMissing
 * / RssSync pass. Build once with {@link AutoGrabPipelineService.buildScoringContext}
 * before iterating; pass it back into {@link AutoGrabPipelineService.tryAutoGrab}.
 */
export interface AutoGrabScoringContext {
  sizeByQuality: Map<number, SizeLimits>;
  indexerMinSeeders: Map<number, number>;
  indexerUnknownLang: Map<number, string | undefined>;
}

/** Outcome of {@link AutoGrabPipelineService.classifyForSearch}. */
export type SearchDecision =
  | { mode: 'skip' | 'unprofiled' }
  | {
      mode: 'missing' | 'upgrade';
      /** Releases must have `rank > minRankExclusive`. 0 for "missing" mode. */
      minRankExclusive: number;
      /** Releases must have `rank <= maxRankInclusive`. +Infinity for "missing". */
      maxRankInclusive: number;
    };

/**
 * Single entry-point for every auto-grab pipeline (SearchMissing movies,
 * SearchMissing episodes, RssSync). Encapsulates: media-level decision
 * (missing / upgrade / skip / unprofiled), profile resolution, release
 * scoring, rank-window pick, qBittorrent grab, and DownloadHistory
 * recording — including the critical `torrentHash` + `grabSource` fields
 * that the completion / stalled / seed-cleanup paths key off.
 *
 * Each new auto-grab source should call {@link tryAutoGrab}; do not
 * inline pieces of this pipeline in new code paths.
 */
@Injectable()
export class AutoGrabPipelineService {
  private readonly log = new Logger(AutoGrabPipelineService.name);

  constructor(
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    private readonly profiles: ProfilesService,
    private readonly customFormats: CustomFormatsService,
    private readonly blocklist: BlocklistService,
    private readonly qbittorrent: QbittorrentService,
    private readonly naming: NamingService,
    private readonly qualityDefs: QualityDefinitionsService,
    @Inject(forwardRef(() => RequestLifecycleService))
    private readonly requestLifecycle: RequestLifecycleService,
  ) {}

  /**
   * Keep only releases compatible with a single-episode target. A release
   * is dropped when it positively parses to a different season, or to a
   * different individual episode of the same season. Releases we can't pin
   * (no parseable S/E) and full-season packs of the right season are kept.
   * No-op unless both `seasonNumber` and `episodeNumber` are provided.
   */
  private filterToTargetEpisode(
    releases: ReleaseCandidate[],
    seasonNumber: number | undefined,
    episodeNumber: number | undefined,
    label: string,
  ): ReleaseCandidate[] {
    if (seasonNumber == null || episodeNumber == null) return releases;
    const kept = releases.filter((r) => {
      const p = parseSeasonEpisode(r.title);
      if (p.season == null) return true; // unparseable — leave to the scorer
      if (p.season !== seasonNumber) return false;
      if (p.episode != null && p.episode !== episodeNumber) return false;
      return true;
    });
    const dropped = releases.length - kept.length;
    if (dropped) {
      this.log.log(
        `AutoGrab[series]: "${label}" — dropped ${dropped} release(s) belonging to another episode`,
      );
    }
    return kept;
  }

  async buildScoringContext(
    indexers: Indexer[],
  ): Promise<AutoGrabScoringContext> {
    return {
      sizeByQuality: await this.qualityDefs.getSizeLimitsMap(),
      indexerMinSeeders: buildIndexerMinSeeders(indexers),
      indexerUnknownLang: new Map(
        indexers.map((ix) => [
          ix.id,
          ix.settings?.unknownLanguageIsoCode as string | undefined,
        ]),
      ),
    };
  }

  /**
   * Decide what (if anything) SearchMissing should do for a given media.
   *
   * - `skip`        — has files at/above cutoff, OR has files but profile
   *                   forbids upgrades.
   * - `unprofiled`  — quality or language profile missing; we refuse to act.
   *                   The system-default profiles are a seed only and are
   *                   NOT applied at runtime.
   * - `missing`     — no files on disk; grab the best release.
   * - `upgrade`     — has files below cutoff and `upgradeAllowed` is true;
   *                   only releases strictly better than current AND within
   *                   cutoff are eligible.
   */
  classifyForSearch(
    media: Media,
    files: { quality?: string | null }[],
  ): SearchDecision {
    if (!media.qualityProfile || !media.languageProfile) {
      return { mode: 'unprofiled' };
    }
    if (!files.length) {
      return {
        mode: 'missing',
        minRankExclusive: 0,
        maxRankInclusive: Number.POSITIVE_INFINITY,
      };
    }
    const profile = media.qualityProfile;
    if (!profile.upgradeAllowed) return { mode: 'skip' };
    let currentRank = 0;
    for (const f of files) {
      const r = rankFromQualityString(f.quality);
      if (r > currentRank) currentRank = r;
    }
    const cutoffRank = getAppQualityById(profile.cutoff)?.rank;
    if (cutoffRank == null) return { mode: 'skip' };
    if (currentRank >= cutoffRank) return { mode: 'skip' };
    return {
      mode: 'upgrade',
      minRankExclusive: currentRank,
      maxRankInclusive: cutoffRank,
    };
  }

  /** Whether SearchMissing should query indexers for this media/files pair.
   *  False when already at cutoff, upgrades disabled, or unprofiled. */
  shouldSearchMissing(
    media: Media,
    files: { quality?: string | null }[],
  ): boolean {
    const decision = this.classifyForSearch(media, files);
    return decision.mode === 'missing' || decision.mode === 'upgrade';
  }

  /**
   * High-level auto-grab attempt. Returns `true` when a release was sent to
   * qBittorrent + recorded in `DownloadHistory`, `false` when the media is
   * skipped for any reason (no profile, at cutoff, no eligible release,
   * pending grab, grab failure).
   */
  async tryAutoGrab(args: {
    media: Media;
    files: { quality?: string | null }[];
    releases: ReleaseCandidate[];
    qbitClient: DownloadClient;
    scoring: AutoGrabScoringContext;
    mediaType: 'movie' | 'series';
    /** Free-form label for logs — e.g. `"Dune (2021)"` or `"Show S01E03"`. */
    label: string;
    /** Expected media title(s) — defaults to {@link resolveSearchTitles}
     *  (canonical + original + TMDB/TVDB alternatives). Pass explicitly
     *  only when a custom query overrides the media title. */
    expectedTitle?: string | string[];
    runtimeMinutes: number;
    /** Per-source pending check (e.g. episode-scoped lookup). */
    pendingCheck?: () => Promise<boolean>;
    /** Season targeted by this grab — forwarded to `grabAndRecord` so
     *  the lifecycle hook can flip only the matching per-season
     *  requests. Whole-series and movie grabs pass undefined. */
    seasonNumber?: number;
    /** Episode number targeted by this grab. When set together with
     *  `seasonNumber`, releases that positively parse to a *different*
     *  episode are rejected — indexer text search is loose and routinely
     *  returns sibling episodes for a single-episode query. */
    episodeNumber?: number;
    /** Season + episode primary keys — persisted on the
     *  `DownloadHistory` row so Activities can show "Show — S01E03"
     *  for a single-episode grab without joining back through the
     *  files at import time. */
    seasonId?: number;
    episodeId?: number;
  }): Promise<boolean> {
    const logSkip = (reason: string): void =>
      this.log.log(
        `AutoGrab[${args.mediaType}]: "${args.label}" skipped — ${reason}`,
      );

    const decision = this.classifyForSearch(args.media, args.files);
    if (decision.mode !== 'missing' && decision.mode !== 'upgrade') {
      logSkip(
        decision.mode === 'unprofiled'
          ? 'no quality/language profile on media'
          : `at/above cutoff (mode=${decision.mode})`,
      );
      return false;
    }

    if (!args.releases.length) {
      logSkip('no releases returned by indexers');
      return false;
    }

    if (args.pendingCheck && (await args.pendingCheck())) {
      logSkip('a grab is already pending');
      return false;
    }

    // Episode-targeted search: drop releases that positively belong to a
    // different episode. Indexer text search is loose and returns sibling
    // episodes (and the scorer would happily pick the highest-quality one,
    // recording it under the searched episode). Season packs of the right
    // season are kept — they cover the episode and import per-file.
    const releases = this.filterToTargetEpisode(
      args.releases,
      args.seasonNumber,
      args.episodeNumber,
      args.label,
    );
    if (!releases.length) {
      logSkip('no release matched the targeted episode');
      return false;
    }

    const { allowed, allowedLangs } = this.profiles.resolveAllowedForMedia(
      args.media,
    );
    const expectedTitle =
      args.expectedTitle ?? resolveSearchTitles(args.media).expectedTitles;
    const sorted = await scoreAndSortReleases(
      releases,
      {
        allowed,
        allowedLangs,
        sizeByQuality: args.scoring.sizeByQuality,
        indexerMinSeeders: args.scoring.indexerMinSeeders,
        indexerUnknownLang: args.scoring.indexerUnknownLang,
        runtimeMinutes: args.runtimeMinutes,
        expectedTitle,
      },
      {
        scoreCustomFormats: (title, meta) =>
          this.customFormats.scoreRelease(title, meta),
        isBlocked: (title) => this.blocklist.isBlocked(title),
      },
    );
    const resolutionUpgradeOnly =
      decision.mode === 'upgrade' &&
      !!args.media.qualityProfile?.resolutionUpgradeOnly;
    const currentResolution = resolutionUpgradeOnly
      ? maxResolutionFromQualityStrings(args.files)
      : 0;
    const pick = sorted.find((r) => {
      if (r.rejections.length > 0) return false;
      if (
        r.rank <= decision.minRankExclusive ||
        r.rank > decision.maxRankInclusive
      ) {
        return false;
      }
      if (resolutionUpgradeOnly) {
        const releaseResolution = parseReleaseQuality(r.title).quality
          .resolution;
        if (releaseResolution <= currentResolution) return false;
      }
      return true;
    });
    if (!pick) {
      const topRejections = sorted
        .slice(0, 3)
        .map(
          (r) =>
            `"${r.title}" → ${r.rejections.length ? r.rejections.map(formatRejectionForLog).join(', ') : `rank ${r.rank} out of [${decision.minRankExclusive + 1}..${decision.maxRankInclusive}]`}`,
        )
        .join(' | ');
      logSkip(
        `no eligible release (mode=${decision.mode}, ${sorted.length} checked)${topRejections ? ` — top: ${topRejections}` : ''}`,
      );
      return false;
    }

    return this.grabAndRecord({
      media: args.media,
      pick,
      qbitClient: args.qbitClient,
      mediaType: args.mediaType,
      label: args.label,
      seasonNumber: args.seasonNumber,
      seasonId: args.seasonId,
      episodeId: args.episodeId,
    });
  }

  /**
   * Push the picked release to qBittorrent and persist the corresponding
   * DownloadHistory row. The returned info hash is critical: the completion
   * + stalled + seed cleaners key off `history.torrentHash` first and fall
   * back to fragile `sourceTitle` matching otherwise — without it,
   * downloaded torrents stay unlinkable in Activities.
   */
  async grabAndRecord(args: {
    media: Media;
    pick: ScoredRelease;
    qbitClient: DownloadClient;
    mediaType: 'movie' | 'series';
    label: string;
    /** Season number when the grabbed release targets a specific
     *  season/episode — drives per-season request scoping for the
     *  `APPROVED → PROCESSING` transition. Omit for whole-series and
     *  movie grabs. */
    seasonNumber?: number;
    /** Season + episode primary keys to persist on the history row. */
    seasonId?: number;
    episodeId?: number;
  }): Promise<boolean> {
    try {
      this.log.log(
        `AutoGrab[${args.mediaType}]: sending "${args.pick.title}" to qBittorrent — ${args.pick.downloadUrl}`,
      );
      const torrentHash = await this.qbittorrent.addTorrentUrl(
        args.qbitClient,
        args.pick.downloadUrl,
        args.mediaType,
        true,
      );
      await this.historyRepo.save(
        this.historyRepo.create(
          buildGrabHistoryRow({
            media: args.media,
            downloadClient: args.qbitClient,
            sourceTitle: args.pick.title,
            torrentHash,
            quality: this.naming.parseQuality(args.pick.title),
            grabSource: 'auto',
            indexerId: args.pick.indexerId,
            seasonId: args.seasonId,
            episodeId: args.episodeId,
          }),
        ),
      );
      this.log.log(
        `AutoGrab[${args.mediaType}]: grabbed "${args.pick.title}" for "${args.label}"`,
      );
      // Flip linked APPROVED requests to PROCESSING. Failures don't
      // abort the grab — best effort.
      void this.requestLifecycle
        .onReleaseGrabbed(args.media.id, args.seasonNumber)
        .catch((err) =>
          this.log.warn(
            `request-lifecycle: failed to flip requests to PROCESSING for media#${args.media.id}: ${(err as Error).message}`,
          ),
        );
      return true;
    } catch (e) {
      this.log.warn(
        `AutoGrab[${args.mediaType}]: grab failed for "${args.label}": ${(e as Error).message}`,
      );
      return false;
    }
  }
}

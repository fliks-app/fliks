import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from '../../modules/media/entities/media.entity';
import {
  AutoGrabPipelineService,
  AutoGrabScoringContext,
} from '../../modules/media/auto-grab-pipeline.service';
import { EventsService } from '../../modules/scheduler/events.service';
import { NamingService } from '../../modules/scheduler/naming.service';
import { DownloadHistory } from './entities/download-history.entity';
import { buildGrabHistoryRow } from './grab-history.util';
import { DownloadClient } from './download-clients/entities/download-client.entity';
import { QbittorrentService } from './download-clients/qbittorrent.service';
import { CustomFormatsService } from '../../modules/profiles/custom-formats.service';
import { ProfilesService } from '../../modules/profiles/profiles.service';
import { BlocklistService } from './blocklist/blocklist.service';
import {
  parseReleaseQuality,
  parseSeasonEpisode,
} from '../../common/release-parsing';
import {
  ReleaseCandidate,
  ScoredRelease,
  maxResolutionFromQualityStrings,
  resolveSearchTitles,
  scoreAndSortReleases,
  formatRejectionForLog,
} from '../../common/release-scoring';

/**
 * Grab execution for every auto-grab source (SearchMissing movies,
 * SearchMissing episodes, RssSync): profile resolution, release scoring,
 * rank-window pick, qBittorrent grab, and DownloadHistory recording —
 * including the critical `torrentHash` + `grabSource` fields that the
 * completion / stalled / seed-cleanup paths key off. The missing / upgrade /
 * skip decision comes from {@link AutoGrabPipelineService.classifyForSearch}.
 *
 * Each new auto-grab source should call {@link tryAutoGrab}; do not
 * inline pieces of this pipeline in new code paths.
 */
@Injectable()
export class AutoGrabExecutorService {
  private readonly log = new Logger(AutoGrabExecutorService.name);

  constructor(
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    private readonly classifier: AutoGrabPipelineService,
    private readonly profiles: ProfilesService,
    private readonly customFormats: CustomFormatsService,
    private readonly blocklist: BlocklistService,
    private readonly qbittorrent: QbittorrentService,
    private readonly naming: NamingService,
    private readonly events: EventsService,
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

    const decision = this.classifier.classifyForSearch(args.media, args.files);
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
      this.events.emitDomain({
        type: 'acquisition.grabbed',
        mediaId: args.media.id,
        seasonNumber: args.seasonNumber,
      });
      return true;
    } catch (e) {
      this.log.warn(
        `AutoGrab[${args.mediaType}]: grab failed for "${args.label}": ${(e as Error).message}`,
      );
      return false;
    }
  }
}

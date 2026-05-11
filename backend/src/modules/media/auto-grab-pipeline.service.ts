import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from './entities/media.entity';
import { DownloadHistory } from './entities/download-history.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { TorznabRelease } from '../indexers/torznab.service';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { CustomFormatsService } from '../profiles/custom-formats.service';
import { QualityDefinitionsService } from '../profiles/quality-definitions.service';
import { ProfilesService } from '../profiles/profiles.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { NamingService } from '../scheduler/naming.service';
import { getAppQualityById } from '../../common/constants/app-qualities';
import {
  ScoredRelease,
  SizeLimits,
  buildIndexerMinSeeders,
  rankFromQualityString,
  scoreAndSortReleases,
} from './release-rejection.helper';

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
  ) {}

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

  /**
   * High-level auto-grab attempt. Returns `true` when a release was sent to
   * qBittorrent + recorded in `DownloadHistory`, `false` when the media is
   * skipped for any reason (no profile, at cutoff, no eligible release,
   * pending grab, grab failure).
   */
  async tryAutoGrab(args: {
    media: Media;
    files: { quality?: string | null }[];
    releases: TorznabRelease[];
    qbitClient: DownloadClient;
    scoring: AutoGrabScoringContext;
    mediaType: 'movie' | 'series';
    /** Free-form label for logs — e.g. `"Dune (2021)"` or `"Show S01E03"`. */
    label: string;
    /** Expected media title(s) — pass canonical + TMDB/TVDB alternatives
     *  so localised release names still match. */
    expectedTitle?: string | string[];
    runtimeMinutes: number;
    /** Per-source pending check (e.g. episode-scoped lookup). */
    pendingCheck?: () => Promise<boolean>;
  }): Promise<boolean> {
    const decision = this.classifyForSearch(args.media, args.files);
    if (decision.mode !== 'missing' && decision.mode !== 'upgrade') {
      if (decision.mode === 'unprofiled') {
        this.log.debug?.(
          `AutoGrab[${args.mediaType}]: "${args.label}" has no quality/language profile — skipped`,
        );
      }
      return false;
    }

    if (!args.releases.length) return false;

    if (args.pendingCheck && (await args.pendingCheck())) return false;

    const { allowed, allowedLangs } = this.profiles.resolveAllowedForMedia(
      args.media,
    );
    const sorted = await scoreAndSortReleases(
      args.releases,
      {
        allowed,
        allowedLangs,
        sizeByQuality: args.scoring.sizeByQuality,
        indexerMinSeeders: args.scoring.indexerMinSeeders,
        indexerUnknownLang: args.scoring.indexerUnknownLang,
        runtimeMinutes: args.runtimeMinutes,
        expectedTitle: args.expectedTitle,
      },
      {
        scoreCustomFormats: (title, meta) =>
          this.customFormats.scoreRelease(title, meta),
        isBlocked: (title) => this.blocklist.isBlocked(title),
      },
    );
    const pick = sorted.find(
      (r) =>
        r.rejections.length === 0 &&
        r.rank > decision.minRankExclusive &&
        r.rank <= decision.maxRankInclusive,
    );
    if (!pick) {
      this.log.debug?.(
        `AutoGrab[${args.mediaType}]: no eligible release for "${args.label}" (mode=${decision.mode}, ${sorted.length} checked)`,
      );
      return false;
    }

    return this.grabAndRecord({
      media: args.media,
      pick,
      qbitClient: args.qbitClient,
      mediaType: args.mediaType,
      label: args.label,
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
  }): Promise<boolean> {
    try {
      this.log.log(
        `AutoGrab[${args.mediaType}]: sending "${args.pick.title}" to qBittorrent — ${args.pick.downloadUrl}`,
      );
      const torrentHash = await this.qbittorrent.addTorrentUrl(
        args.qbitClient,
        args.pick.downloadUrl,
        args.mediaType,
      );
      await this.historyRepo.save(
        this.historyRepo.create({
          media: args.media,
          downloadClient: args.qbitClient,
          indexer: { id: args.pick.indexerId } as Indexer,
          sourceTitle: args.pick.title,
          quality: this.naming.parseQuality(args.pick.title),
          status: 'grabbed',
          grabSource: 'auto',
          torrentHash: torrentHash || undefined,
        }),
      );
      this.log.log(
        `AutoGrab[${args.mediaType}]: grabbed "${args.pick.title}" for "${args.label}"`,
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

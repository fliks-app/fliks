import { Injectable } from '@nestjs/common';
import { Media } from './entities/media.entity';
import { QualityDefinitionsService } from '../profiles/quality-definitions.service';
import { getAppQualityById } from '../../common/constants/app-qualities';
import {
  SizeLimits,
  buildSourceMinSeeders,
  rankFromQualityString,
} from '../../common/release-scoring';

/**
 * Scoring context that's identical across many media in the same SearchMissing
 * / RssSync pass. Build once with {@link AutoGrabPipelineService.buildScoringContext}
 * before iterating a batch.
 */
export interface AutoGrabScoringContext {
  sizeByQuality: Map<number, SizeLimits>;
  sourceMinSeeders: Map<number, number>;
  sourceUnknownLang: Map<number, string | undefined>;
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
 * Classification for the auto-grab pipeline: whether a media needs a search
 * (missing / upgrade / skip / unprofiled) and the per-run scoring context
 * a release source contributes (size limits, min seeders, unknown-language
 * fallback). Grab execution — scoring releases, picking one, recording
 * DownloadHistory — is a separate concern.
 */
@Injectable()
export class AutoGrabPipelineService {
  constructor(private readonly qualityDefs: QualityDefinitionsService) {}

  /** Takes the structural shape `buildSourceMinSeeders` declares, so core needs
   *  no entity class from whoever owns the release sources. */
  async buildScoringContext(
    sources: { id: number; settings?: Record<string, unknown> | null }[],
  ): Promise<AutoGrabScoringContext> {
    return {
      sizeByQuality: await this.qualityDefs.getSizeLimitsMap(),
      sourceMinSeeders: buildSourceMinSeeders(sources),
      sourceUnknownLang: new Map(
        sources.map((ix) => [
          ix.id,
          ix.settings?.['unknownLanguageIsoCode'] as string | undefined,
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

  /** Whether a search should be run for this media/files pair.
   *  False when already at cutoff, upgrades disabled, or unprofiled. */
  shouldSearchMissing(
    media: Media,
    files: { quality?: string | null }[],
  ): boolean {
    const decision = this.classifyForSearch(media, files);
    return decision.mode === 'missing' || decision.mode === 'upgrade';
  }
}

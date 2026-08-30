import { Injectable } from '@nestjs/common';
import { Media } from './entities/media.entity';
import { getAppQualityById } from '../../common/constants/app-qualities';
import { rankFromQualityString } from '../../common/release-scoring';

/** Outcome of {@link AutoGrabPipelineService.classifyForSearch}. */
export type SearchDecision =
  | { mode: 'unprofiled' }
  | {
      mode: 'missing' | 'upgrade' | 'skip';
      /** Releases must have `rank > minRankExclusive`. 0 for "missing" mode. */
      minRankExclusive: number;
      /** Releases must have `rank <= maxRankInclusive`. +Infinity for "missing". */
      maxRankInclusive: number;
      /** Which of the three routes to `skip` was taken. A log that ORs them together cannot
       *  tell an operator whether to change a profile, a cutoff, or nothing at all. */
      skipReason?: 'at-cutoff' | 'upgrades-disabled' | 'no-cutoff-configured';
    };

/**
 * Whether a media needs a search, and against which rank window — the one half of
 * acquisition that reads a quality profile, so the one half core still owns.
 */
@Injectable()
export class AutoGrabPipelineService {
  /**
   * Decide what (if anything) SearchMissing should do for a given media.
   *
   * - `skip`        — has files at/above cutoff, OR has files but profile
   *                   forbids upgrades. Still carries the ranked bounds a
   *                   manual search can score against; never auto-grabbed.
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
    // Only the quality profile is required. A media with no language profile
    // imposes no language requirement, which the scorer already reads as
    // "accept any" — the same rule the manual grab paths apply.
    if (!media.qualityProfile) {
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
    let currentRank = 0;
    for (const f of files) {
      const r = rankFromQualityString(f.quality);
      if (r > currentRank) currentRank = r;
    }
    const cutoffRank = getAppQualityById(profile.cutoff)?.rank;
    // A skip still carries the ranked bounds an upgrade would have used, so a
    // manual search can score releases even though auto-grab has nothing to do.
    const maxRankInclusive = cutoffRank ?? Number.POSITIVE_INFINITY;
    if (!profile.upgradeAllowed)
      return { mode: 'skip', minRankExclusive: currentRank, maxRankInclusive, skipReason: 'upgrades-disabled' };
    if (cutoffRank == null)
      return { mode: 'skip', minRankExclusive: currentRank, maxRankInclusive, skipReason: 'no-cutoff-configured' };
    if (currentRank >= cutoffRank)
      return { mode: 'skip', minRankExclusive: currentRank, maxRankInclusive: cutoffRank, skipReason: 'at-cutoff' };
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

  /** Why a row was left out, in the vocabulary an operator can act on. */
  searchExclusionReason(
    media: Media,
    files: { quality?: string | null }[],
  ): string | null {
    const decision = this.classifyForSearch(media, files);
    if (decision.mode === 'unprofiled') return 'unprofiled';
    if (decision.mode === 'skip') return decision.skipReason ?? 'skip';
    return null;
  }
}

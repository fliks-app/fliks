import { QualityProfileItem } from '../profiles/entities/quality-profile.entity';
import { Indexer } from '../indexers/entities/indexer.entity';

export interface ReleaseRejection {
  /** Machine-readable code — the frontend maps this to an i18n key. */
  code: string;
  /** Interpolation params forwarded to the i18n formatter. */
  params?: Record<string, number | string>;
}

/**
 * Detect the video codec from a release title and return a size scaling
 * factor relative to x264 (= 1.0). Quality definition size limits are
 * typically calibrated for x264; more efficient codecs produce smaller
 * files at the same visual quality.
 *
 * Factors based on industry consensus:
 *   x264 (AVC)   → 1.0  (baseline)
 *   x265 (HEVC)  → 0.55 (~45% smaller than x264)
 *   AV1          → 0.45 (~55% smaller than x264)
 *   VP9          → 0.60 (~40% smaller than x264)
 *   Unknown      → 1.0  (conservative — assume x264)
 */
function detectCodecSizeFactor(title?: string): number {
  if (!title) return 1;
  const t = title.toLowerCase();
  if (/\bav1\b/.test(t)) return 0.45;
  if (/\b(x265|h\.?265|hevc)\b/.test(t)) return 0.55;
  if (/\bvp9\b/.test(t)) return 0.6;
  // x264/h264 or unknown → baseline
  return 1;
}

export interface SizeLimits {
  min: number;
  preferred: number;
  max: number;
}

/**
 * Build the set of allowed quality IDs, considering groups.
 * If any quality in a group is allowed, all qualities in that group are allowed.
 */
export function buildAllowedQualityIds(
  items: QualityProfileItem[] | undefined,
): Set<number> {
  const set = new Set<number>();
  if (!items?.length) return set;

  // First pass: collect explicitly allowed IDs and allowed group IDs
  const allowedGroupIds = new Set<number>();
  for (const item of items) {
    if (item.allowed) {
      set.add(item.quality.id);
      if (item.groupId != null) allowedGroupIds.add(item.groupId);
    }
  }

  // Second pass: add all qualities belonging to an allowed group
  if (allowedGroupIds.size > 0) {
    for (const item of items) {
      if (item.groupId != null && allowedGroupIds.has(item.groupId)) {
        set.add(item.quality.id);
      }
    }
  }

  return set;
}

export function buildIndexerMinSeeders(
  indexers: Indexer[],
): Map<number, number> {
  return new Map(
    indexers.map((ix) => [
      ix.id,
      Math.max(0, Number(ix.settings?.['minSeeders']) || 0),
    ]),
  );
}

/**
 * Compute every reason a release does **not** perfectly match the user's criteria.
 * Returns an empty array when the release fully matches.
 */
export function computeRejections(opts: {
  qualityId: number;
  allowed: Set<number>;
  languageId: number;
  allowedLangs: Set<number>;
  isBlocklisted: boolean;
  sizeBytes: number;
  /** Runtime of the media in minutes — needed to convert size to MB/h for comparison with quality limits. */
  runtimeMinutes: number;
  sizeByQuality: Map<number, SizeLimits>;
  seeders: number;
  indexerId: number;
  indexerMinSeeders: Map<number, number>;
  /** Release title — used to detect video codec for size-limit scaling. */
  releaseTitle?: string;
}): ReleaseRejection[] {
  const out: ReleaseRejection[] = [];

  if (!opts.allowed.has(opts.qualityId)) {
    out.push({ code: 'QUALITY_NOT_ALLOWED' });
  }

  if (opts.allowedLangs.size > 0 && !opts.allowedLangs.has(opts.languageId)) {
    out.push({ code: 'LANGUAGE_NOT_ALLOWED' });
  }

  if (opts.isBlocklisted) {
    out.push({ code: 'BLOCKLISTED' });
  }

  // Quality definition limits are in MB/h — convert file size to the same unit.
  // Limits are typically calibrated for x264. Modern codecs (x265/HEVC, AV1)
  // produce significantly smaller files at equivalent quality, so we scale
  // the limits down by a codec efficiency factor to avoid false "too small"
  // rejections.
  const codecFactor = detectCodecSizeFactor(opts.releaseTitle);
  const runtimeHours = opts.runtimeMinutes > 0 ? opts.runtimeMinutes / 60 : 0;
  const sizeMb = opts.sizeBytes > 0 ? opts.sizeBytes / (1024 * 1024) : 0;
  const sizeMbPerHour = runtimeHours > 0 ? sizeMb / runtimeHours : 0;
  const rawLimits = opts.sizeByQuality.get(opts.qualityId);
  const limits = rawLimits
    ? {
        min: rawLimits.min * codecFactor,
        preferred: rawLimits.preferred * codecFactor,
        max: rawLimits.max * codecFactor,
      }
    : undefined;

  if (limits && sizeMbPerHour > 0) {
    if (limits.min > 0 && sizeMbPerHour < limits.min) {
      out.push({
        code: 'SIZE_TOO_LOW',
        params: { actual: Math.round(sizeMbPerHour), min: Math.round(limits.min) },
      });
    }
    if (limits.max > 0 && sizeMbPerHour > limits.max) {
      out.push({
        code: 'SIZE_TOO_HIGH',
        params: { actual: Math.round(sizeMbPerHour), max: Math.round(limits.max) },
      });
    }
    if (
      limits.preferred > 0 &&
      out.every((r) => r.code !== 'SIZE_TOO_LOW' && r.code !== 'SIZE_TOO_HIGH')
    ) {
      const deviation =
        Math.abs(sizeMbPerHour - limits.preferred) / limits.preferred;
      if (deviation > 0.3) {
        out.push({
          code: 'SIZE_NOT_PREFERRED',
          params: {
            actual: Math.round(sizeMbPerHour),
            preferred: Math.round(limits.preferred),
          },
        });
      }
    }
  }

  const minSeed = opts.indexerMinSeeders.get(opts.indexerId) ?? 0;
  if (minSeed > 0 && opts.seeders < minSeed) {
    out.push({
      code: 'MIN_SEEDERS',
      params: { actual: opts.seeders, min: minSeed },
    });
  }

  return out;
}

/**
 * Sort releases by relevance. Best releases first.
 *
 * Priority order:
 * 1. No rejections > has rejections
 * 2. Not blocklisted > blocklisted
 * 3. Language allowed > not allowed
 * 4. Freeleech bonus
 * 5. Quality rank (higher = better)
 * 6. Custom format score (higher = better)
 * 7. Seeders (more = better, log scale to avoid over-weighting)
 * 8. Size closer to preferred (less deviation = better)
 */
export function sortReleasesByRelevance<
  T extends {
    rank: number;
    allowed: boolean;
    blocklisted: boolean;
    languageAllowed: boolean;
    rejections: ReleaseRejection[];
    customFormatScore: number;
    seeders: number;
    freeleech: boolean;
  },
>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    // 1. No rejections first
    const aClean = a.rejections.length === 0 ? 1 : 0;
    const bClean = b.rejections.length === 0 ? 1 : 0;
    if (aClean !== bClean) return bClean - aClean;

    // 2. Not blocklisted first
    if (a.blocklisted !== b.blocklisted) return a.blocklisted ? 1 : -1;

    // 3. Language allowed first
    if (a.languageAllowed !== b.languageAllowed)
      return a.languageAllowed ? -1 : 1;

    // 4. Quality rank desc
    if (a.rank !== b.rank) return b.rank - a.rank;

    // 5. Freeleech bonus
    if (a.freeleech !== b.freeleech) return a.freeleech ? -1 : 1;

    // 6. Custom format score desc
    if (a.customFormatScore !== b.customFormatScore)
      return b.customFormatScore - a.customFormatScore;

    // 7. Seeders desc (log scale)
    const aSeed = Math.log2(a.seeders + 1);
    const bSeed = Math.log2(b.seeders + 1);
    if (Math.abs(aSeed - bSeed) > 0.5) return bSeed - aSeed;

    return 0;
  });
}

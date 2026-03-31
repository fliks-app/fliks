import { QualityProfileItem } from '../profiles/entities/quality-profile.entity';
import { Indexer } from '../indexers/entities/indexer.entity';

export interface ReleaseRejection {
  /** Machine-readable code — the frontend maps this to an i18n key. */
  code: string;
  /** Interpolation params forwarded to the i18n formatter. */
  params?: Record<string, number | string>;
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
export function buildAllowedQualityIds(items: QualityProfileItem[] | undefined): Set<number> {
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

export function buildIndexerMinSeeders(indexers: Indexer[]): Map<number, number> {
  return new Map(
    indexers.map((ix) => [ix.id, Math.max(0, Number(ix.settings?.['minSeeders']) || 0)]),
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
  sizeByQuality: Map<number, SizeLimits>;
  seeders: number;
  indexerId: number;
  indexerMinSeeders: Map<number, number>;
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

  const sizeMb = opts.sizeBytes > 0 ? opts.sizeBytes / (1024 * 1024) : 0;
  const limits = opts.sizeByQuality.get(opts.qualityId);

  if (limits && sizeMb > 0) {
    if (limits.min > 0 && sizeMb < limits.min) {
      out.push({ code: 'SIZE_TOO_LOW', params: { actual: Math.round(sizeMb), min: limits.min } });
    }
    if (limits.max > 0 && sizeMb > limits.max) {
      out.push({ code: 'SIZE_TOO_HIGH', params: { actual: Math.round(sizeMb), max: limits.max } });
    }
    if (
      limits.preferred > 0 &&
      out.every((r) => r.code !== 'SIZE_TOO_LOW' && r.code !== 'SIZE_TOO_HIGH')
    ) {
      const deviation = Math.abs(sizeMb - limits.preferred) / limits.preferred;
      if (deviation > 0.3) {
        out.push({
          code: 'SIZE_NOT_PREFERRED',
          params: { actual: Math.round(sizeMb), preferred: limits.preferred },
        });
      }
    }
  }

  const minSeed = opts.indexerMinSeeders.get(opts.indexerId) ?? 0;
  if (minSeed > 0 && opts.seeders < minSeed) {
    out.push({ code: 'MIN_SEEDERS', params: { actual: opts.seeders, min: minSeed } });
  }

  return out;
}

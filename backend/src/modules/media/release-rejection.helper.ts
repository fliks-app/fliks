import { QualityProfileItem } from '../profiles/entities/quality-profile.entity';
import { AudioLanguageItem } from '../profiles/entities/language-profile.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { TorznabRelease } from '../indexers/torznab.service';
import { APP_LANGUAGES } from '../../common/constants/app-languages';
import { parseReleaseQuality } from './release-quality.parser';
import {
  parseReleaseLanguage,
  resolveUnknownLanguage,
} from './release-language.parser';
import { parseSeasonEpisode } from './release-episode.parser';

/**
 * Resolve a stored media-file quality string (e.g. `"WEBDL-1080p"`,
 * `"HDTV-720p"`) into its rank via {@link parseReleaseQuality}. Returns
 * 0 for null / empty / unparsable input so callers can treat
 * "no usable file" as "below any cutoff".
 */
export function rankFromQualityString(
  quality: string | null | undefined,
): number {
  if (!quality) return 0;
  return parseReleaseQuality(quality).quality.rank;
}

/**
 * Convert a language profile's audio language items into a set of app-language IDs
 * for rejection checking. Empty set = no language restriction.
 */
export function allowedAudioLanguageIds(
  audioLangs: AudioLanguageItem[] | undefined,
): Set<number> {
  const set = new Set<number>();
  if (!audioLangs?.length) return set;
  for (const item of audioLangs) {
    const lang = APP_LANGUAGES.find((l) => l.isoCode === item.isoCode);
    if (lang) set.add(lang.id);
  }
  return set;
}

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
/**
 * Returns the codec-adjusted absolute deviation of a release's MB/h
 * rate from the quality's preferred MB/h, normalised by preferred.
 * 0 = on target; 0.5 = 50% off either way; `null` when preferred /
 * runtime is unknown. Used by the sort comparator as a tiebreaker —
 * lower deviation ranks above larger deviations at equal quality
 * + custom-format score.
 */
export function computeSizeDeviation(
  releaseTitle: string,
  sizeBytes: number,
  runtimeMinutes: number,
  rawLimits: { min: number; preferred: number; max: number } | undefined,
): number | null {
  if (!rawLimits || rawLimits.preferred <= 0) return null;
  if (runtimeMinutes <= 0 || sizeBytes <= 0) return null;
  const sizeMb = sizeBytes / (1024 * 1024);
  const sizeMbPerHour = sizeMb / (runtimeMinutes / 60);
  const preferred = rawLimits.preferred * detectCodecSizeFactor(releaseTitle);
  if (preferred <= 0) return null;
  return Math.abs(sizeMbPerHour - preferred) / preferred;
}

export function detectCodecSizeFactor(title?: string): number {
  switch (detectVideoCodec(title)) {
    case 'AV1': return 0.45;
    case 'HEVC': return 0.55;
    case 'VP9': return 0.6;
    default: return 1; // x264/h264 or unknown → baseline
  }
}

/** Surface-friendly codec name parsed from the release title. Returns
 *  null when no codec token is recognised so the UI can omit the
 *  badge instead of guessing. */
export function detectVideoCodec(title?: string): 'AV1' | 'HEVC' | 'VP9' | 'x264' | null {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\bav1\b/.test(t)) return 'AV1';
  // `h[.\s-]?` lets us catch "H.264", "H264", "h 264", "H-264" — some
  // indexers tokenise dots to spaces, which would otherwise hide the
  // codec marker behind a word boundary.
  if (/\b(x265|h[.\s-]?265|hevc)\b/.test(t)) return 'HEVC';
  if (/\bvp9\b/.test(t)) return 'VP9';
  if (/\b(x264|h[.\s-]?264|avc)\b/.test(t)) return 'x264';
  return null;
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
/**
 * Stop-words dropped before comparing a release title against the expected
 * show / movie title. Keeps the meaningful tokens (proper nouns, distinct
 * words) and avoids false matches on connectors that are nearly universal.
 */
const TITLE_STOPWORDS = new Set([
  // FR
  'a',
  'au',
  'aux',
  'de',
  'des',
  'du',
  'la',
  'le',
  'les',
  'l',
  'un',
  'une',
  'et',
  'ou',
  'en',
  'd',
  's',
  // EN
  'the',
  'an',
  'of',
  'and',
  'or',
  'in',
  'on',
  'at',
  'to',
  'for',
]);

/** Normalize a title for matching: lowercase, strip accents, replace any
 *  non-alphanumeric with a space, collapse whitespace. */
function normalizeForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Significant tokens of a title — tokens that must appear in the release
 *  title for it to be considered a match. Excludes stopwords and very short
 *  tokens (1 char). Falls back to the full normalized title when filtering
 *  leaves nothing (e.g. titles made entirely of stopwords). */
function significantTokens(title: string): string[] {
  const normalized = normalizeForMatch(title);
  if (!normalized) return [];
  const tokens = normalized
    .split(' ')
    .filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t));
  return tokens.length ? tokens : normalized.split(' ').filter(Boolean);
}

/**
 * Return true when a release title plausibly matches *any* of the expected
 * titles. Every significant token of one expected variant must appear as
 * a whole-word substring in the normalized release title.
 *
 * Multiple expected titles is the normal case: an "Au service de la France"
 * release indexed under its international name "A Very Secret Service"
 * still passes when both forms are in the candidate list (TMDB's
 * `alternative_titles` / TVDB's `aliases`).
 *
 * Used as a backend safety net for indexers that ignore `q=` and return any
 * S01 / category-2000 release regardless of what we asked for.
 */
export function titleMatchesExpectation(
  releaseTitle: string,
  expected: string | string[],
): boolean {
  const candidates = (Array.isArray(expected) ? expected : [expected]).filter(
    (s): s is string => !!s && s.trim().length > 0,
  );
  if (!candidates.length) return true; // nothing meaningful to match
  const releaseTokens = new Set(normalizeForMatch(releaseTitle).split(' '));
  for (const cand of candidates) {
    const tokens = significantTokens(cand);
    if (!tokens.length) return true; // pathological — treat as match
    if (tokens.every((t) => releaseTokens.has(t))) return true;
  }
  return false;
}

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
  /** Release title — used to detect video codec for size-limit scaling AND
   *  for the title-mismatch check below. */
  releaseTitle?: string;
  /** Expected show / movie title(s). Pass the canonical title together
   *  with TMDB / TVDB alternative titles so that releases indexed under a
   *  localised name still pass; otherwise they get `TITLE_MISMATCH`. */
  expectedTitle?: string | string[];
}): ReleaseRejection[] {
  const out: ReleaseRejection[] = [];

  if (
    opts.expectedTitle &&
    opts.releaseTitle &&
    !titleMatchesExpectation(opts.releaseTitle, opts.expectedTitle)
  ) {
    out.push({ code: 'TITLE_MISMATCH' });
  }

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
        params: {
          actual: Math.round(sizeMbPerHour),
          min: Math.round(limits.min),
        },
      });
    }
    if (limits.max > 0 && sizeMbPerHour > limits.max) {
      out.push({
        code: 'SIZE_TOO_HIGH',
        params: {
          actual: Math.round(sizeMbPerHour),
          max: Math.round(limits.max),
        },
      });
    }
    // Preferred is a sort-time signal only — anything within min/max
    // is a valid release. Treating "deviation from preferred" as a
    // rejection bumped legit season packs and oversize-but-still-good
    // single episodes out of the auto-grab pool. min/max alone keep
    // truly bad sizes out.
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
    sizeDeviation?: number | null;
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

    // 7. Closer to preferred size wins (only when both rows expose it
    //    and the gap is big enough to matter — within 5% of each other
    //    counts as tied, otherwise tiny noise would flip the order).
    if (a.sizeDeviation != null && b.sizeDeviation != null) {
      const diff = Math.abs(a.sizeDeviation - b.sizeDeviation);
      if (diff > 0.05) return a.sizeDeviation - b.sizeDeviation;
    }

    // 8. Seeders desc (log scale)
    const aSeed = Math.log2(a.seeders + 1);
    const bSeed = Math.log2(b.seeders + 1);
    if (Math.abs(aSeed - bSeed) > 0.5) return bSeed - aSeed;

    return 0;
  });
}

// ---------------------------------------------------------------------------
// Shared scoring pipeline
// ---------------------------------------------------------------------------

/** A scored + ranked release row — superset of TorznabRelease. */
export interface ScoredRelease extends TorznabRelease {
  qualityId: number;
  qualityName: string;
  rank: number;
  allowed: boolean;
  customFormatScore: number;
  blocklisted: boolean;
  languageId: number;
  languageName: string;
  languageAllowed: boolean;
  rejections: ReleaseRejection[];
  isFullSeason: boolean;
  sizeDeviation: number | null;
  videoCodec: 'AV1' | 'HEVC' | 'VP9' | 'x264' | null;
}

/** Async callbacks injected by the caller (avoids coupling to NestJS services). */
export interface ReleaseScorerDeps {
  scoreCustomFormats(
    title: string,
    meta: { freeleech?: boolean; downloadVolumeFactor?: number },
  ): Promise<number>;
  isBlocked(title: string): Promise<boolean>;
}

/**
 * Score, reject, and sort a batch of torznab releases using the same
 * pipeline as the manual download modal. Shared by SearchMissing,
 * MovieDownloadService, and EpisodeDownloadService.
 *
 * Returns the array sorted by relevance (best first). Caller decides
 * whether to pick the first zero-rejection release or expose all rows.
 */
export async function scoreAndSortReleases(
  releases: TorznabRelease[],
  opts: {
    allowed: Set<number>;
    allowedLangs: Set<number>;
    sizeByQuality: Map<number, SizeLimits>;
    indexerMinSeeders: Map<number, number>;
    indexerUnknownLang: Map<number, string | undefined>;
    runtimeMinutes: number;
    /** Title(s) we expect releases to refer to. Releases whose name
     *  doesn't contain the significant tokens of *any* candidate are
     *  flagged TITLE_MISMATCH. */
    expectedTitle?: string | string[];
  },
  deps: ReleaseScorerDeps,
): Promise<ScoredRelease[]> {
  const rows = await Promise.all(
    releases.map(async (r) => {
      const parsed = parseReleaseQuality(r.title);
      const lang = resolveUnknownLanguage(
        parseReleaseLanguage(r.title),
        opts.indexerUnknownLang.get(r.indexerId),
      );
      const [cfScore, isBlocklisted] = await Promise.all([
        deps.scoreCustomFormats(r.title, {
          freeleech: r.freeleech,
          downloadVolumeFactor: r.downloadVolumeFactor,
        }),
        deps.isBlocked(r.title),
      ]);
      const rejections = computeRejections({
        qualityId: parsed.quality.id,
        allowed: opts.allowed,
        languageId: lang.id,
        allowedLangs: opts.allowedLangs,
        isBlocklisted,
        sizeBytes: r.size,
        runtimeMinutes: opts.runtimeMinutes,
        sizeByQuality: opts.sizeByQuality,
        seeders: r.seeders,
        indexerId: r.indexerId,
        indexerMinSeeders: opts.indexerMinSeeders,
        releaseTitle: r.title,
        expectedTitle: opts.expectedTitle,
      });
      return {
        ...r,
        qualityId: parsed.quality.id,
        qualityName: parsed.quality.name,
        rank: parsed.quality.rank,
        allowed: opts.allowed.has(parsed.quality.id),
        customFormatScore: cfScore,
        blocklisted: isBlocklisted,
        languageId: lang.id,
        languageName: lang.name,
        languageAllowed:
          opts.allowedLangs.size === 0 || opts.allowedLangs.has(lang.id),
        rejections,
        isFullSeason: parseSeasonEpisode(r.title).isFullSeason,
        sizeDeviation: computeSizeDeviation(
          r.title,
          r.size,
          opts.runtimeMinutes,
          opts.sizeByQuality.get(parsed.quality.id),
        ),
        videoCodec: detectVideoCodec(r.title),
      };
    }),
  );
  return sortReleasesByRelevance(rows);
}

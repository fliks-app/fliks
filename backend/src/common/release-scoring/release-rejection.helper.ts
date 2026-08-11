import { QualityProfileItem } from '../../modules/profiles/entities/quality-profile.entity';
import { AudioLanguageItem } from '../../modules/profiles/entities/language-profile.entity';
import { APP_LANGUAGES } from '../constants/app-languages';
import {
  parseReleaseLanguage,
  parseReleaseQuality,
  parseSeasonEpisode,
  resolveUnknownLanguage,
} from '../release-parsing';

/** Torznab search hit, as parsed off the wire by the indexer fetcher —
 *  the input contract every scoring/rejection function below consumes. */
export interface ReleaseCandidate {
  title: string;
  downloadUrl: string;
  indexerId: number;
  indexerName: string;
  size: number; // bytes, 0 if unknown
  seeders: number;
  leechers: number;
  publishDate: string | null; // ISO date string from <pubDate>, null if unavailable
  freeleech: boolean;
  downloadVolumeFactor: number; // 0=free, 0.5=half, 1=normal
}

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

/** Highest resolution (px height) among on-disk file quality strings. */
export function maxResolutionFromQualityStrings(
  files: { quality?: string | null }[],
): number {
  let max = 0;
  for (const f of files) {
    const res = parseReleaseQuality(f.quality ?? '').quality.resolution;
    if (res > max) max = res;
  }
  return max;
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

/** Render a rejection as a readable `code (k=v, …)` string for backend logs —
 *  the i18n rendering lives on the frontend, so logs show the raw code/params
 *  rather than `[object Object]`. */
export function formatRejectionForLog(rejection: ReleaseRejection): string {
  const params = rejection.params
    ? Object.entries(rejection.params)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')
    : '';
  return params ? `${rejection.code} (${params})` : rejection.code;
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
 * Build the Torznab search query and the list of expected release-name
 * variants for matching. Mirrors Sonarr/Radarr: indexer release titles
 * use the original (typically English) name, so we prefer `originalTitle`
 * as the query while passing every known spelling — original, localized,
 * alternative — through to the matcher.
 *
 * `customQuery` overrides everything: it stays authoritative both for
 * the query and the expected-title list (otherwise an indexer-specific
 * search the user typed in could be matched against the localized
 * title and silently rejected).
 */
export function resolveSearchTitles(
  media: {
    originalTitle?: string | null;
    title: string;
    alternativeTitles?: string[] | null;
  },
  customQuery?: string,
): { searchTitle: string; expectedTitles: string[] } {
  const custom = customQuery?.trim();
  if (custom) {
    return { searchTitle: custom, expectedTitles: [custom] };
  }
  const searchTitle = media.originalTitle || media.title;
  const expectedTitles = [
    media.originalTitle,
    media.title,
    ...(media.alternativeTitles ?? []),
  ].filter((t): t is string => !!t && t.length > 0);
  return { searchTitle, expectedTitles };
}

/** True when a release title plausibly refers to `media` under any of its
 *  known names. Movies may pass `requireYearInTitle` so a same-year
 *  unrelated hit (e.g. two 2004 theatricals) is rejected. */
export function releaseMatchesMedia(
  releaseTitle: string,
  media: {
    title: string;
    originalTitle?: string | null;
    alternativeTitles?: string[] | null;
    year?: number | null;
  },
  options?: { requireYearInTitle?: boolean },
): boolean {
  if (
    !titleMatchesExpectation(
      releaseTitle,
      resolveSearchTitles(media).expectedTitles,
    )
  ) {
    return false;
  }
  if (options?.requireYearInTitle && media.year) {
    return releaseTitle.includes(String(media.year));
  }
  return true;
}

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
  indexers: { id: number; settings?: Record<string, unknown> | null }[],
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

/** Strip accents and lowercase, leaving punctuation for the tokenizer. */
function foldCase(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Split a case-folded string into alphanumeric tokens. */
function tokenize(s: string): string[] {
  return s
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Two tokenizations of a title that differ only in how the apostrophe reads.
 * Release groups are inconsistent: an English possessive loses the apostrophe
 * and glues the letters (`X's` → `Xs`), while a French elision splits on it
 * (`d'eau` → `d eau`). Emitting both readings — apostrophe removed, then
 * apostrophe as a separator — lets one expected title match either spelling.
 */
function titleReadings(title: string): string[][] {
  const folded = foldCase(title);
  return [
    tokenize(folded.replace(/['‘’ʼ]/g, '')),
    tokenize(folded),
  ];
}

/** Significant tokens of one reading — drops stopwords and 1-char tokens, but
 *  falls back to the raw tokens when that filter empties the list (e.g. a
 *  title made entirely of stopwords). */
function significantTokens(tokens: string[]): string[] {
  const filtered = tokens.filter(
    (t) => t.length > 1 && !TITLE_STOPWORDS.has(t),
  );
  return filtered.length ? filtered : tokens;
}

/**
 * Return true when a release title plausibly matches *any* of the expected
 * titles. A candidate matches when, under either apostrophe reading, all of
 * its significant tokens appear as whole tokens in the release title.
 *
 * Multiple expected titles is the normal case: a release indexed under its
 * international name still passes when both the localized and original forms
 * are in the candidate list (TMDB's `alternative_titles` / TVDB's `aliases`).
 *
 * A candidate the tokenizer strips to nothing — an alternative title written
 * in a non-Latin script, say — carries no comparable tokens, so it is skipped:
 * it can neither vouch for a match nor veto one. Acceptance falls back to
 * permissive only when *every* expected title is like that (a work with no
 * Latin-script name at all), leaving the caller's year guard as the safeguard.
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
  const releaseTokens = new Set(titleReadings(releaseTitle).flat());
  let comparable = false;
  for (const cand of candidates) {
    for (const reading of titleReadings(cand)) {
      const tokens = significantTokens(reading);
      if (!tokens.length) continue; // no comparable tokens (e.g. a non-Latin title)
      comparable = true;
      if (tokens.every((t) => releaseTokens.has(t))) return true;
    }
  }
  return !comparable;
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
 * 4. Alive (seeders > 0) > dead — a zero-seeder release can't be downloaded,
 *    so it sinks below every live release regardless of quality.
 * 5. Quality rank (higher = better)
 * 6. Freeleech bonus
 * 7. Custom format score (higher = better)
 * 8. Seeders (more = better, log scale to avoid over-weighting)
 * 9. Leechers (more = better, same scale) — breaks seeder ties toward the
 *    busier swarm.
 * 10. Size closer to preferred (less deviation = better)
 *
 * Availability (4, 8, 9) outranks quality only at the dead/alive boundary;
 * between two live releases quality wins, and seeders/leechers order releases
 * within the same quality tier ahead of the weaker size-proximity signal.
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
    leechers: number;
    freeleech: boolean;
    sizeDeviation?: number | null;
  },
>(rows: T[]): T[] {
  // log2 gap that counts as a real difference (~19%); smaller gaps are noise
  // and fall through to the next tiebreak rather than flipping the order.
  const SWARM_EPSILON = 0.25;
  const swarmScore = (count: number) => Math.log2(Math.max(count, 0) + 1);

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

    // 4. Live releases first — a dead torrent never imports.
    const aAlive = a.seeders > 0 ? 1 : 0;
    const bAlive = b.seeders > 0 ? 1 : 0;
    if (aAlive !== bAlive) return bAlive - aAlive;

    // 5. Quality rank desc
    if (a.rank !== b.rank) return b.rank - a.rank;

    // 6. Freeleech bonus
    if (a.freeleech !== b.freeleech) return a.freeleech ? -1 : 1;

    // 7. Custom format score desc
    if (a.customFormatScore !== b.customFormatScore)
      return b.customFormatScore - a.customFormatScore;

    // 8. Seeders desc (log scale)
    const aSeed = swarmScore(a.seeders);
    const bSeed = swarmScore(b.seeders);
    if (Math.abs(aSeed - bSeed) > SWARM_EPSILON) return bSeed - aSeed;

    // 9. Leechers desc (log scale) — tie-break toward the busier swarm.
    const aLeech = swarmScore(a.leechers);
    const bLeech = swarmScore(b.leechers);
    if (Math.abs(aLeech - bLeech) > SWARM_EPSILON) return bLeech - aLeech;

    // 10. Closer to preferred size wins (only when both rows expose it
    //     and the gap is big enough to matter — within 5% of each other
    //     counts as tied, otherwise tiny noise would flip the order).
    if (a.sizeDeviation != null && b.sizeDeviation != null) {
      const diff = Math.abs(a.sizeDeviation - b.sizeDeviation);
      if (diff > 0.05) return a.sizeDeviation - b.sizeDeviation;
    }

    return 0;
  });
}

// ---------------------------------------------------------------------------
// Shared scoring pipeline
// ---------------------------------------------------------------------------

/** A scored + ranked release row — superset of ReleaseCandidate. */
export interface ScoredRelease extends ReleaseCandidate {
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
  /** `indexerId` rides along so a caller keyed by per-release index (rather
   *  than by title, which two releases may share) can disambiguate. */
  isBlocked(title: string, indexerId: number): Promise<boolean>;
}

/**
 * Score, reject, and sort a batch of release candidates using the same
 * pipeline as the manual download modal. Shared by SearchMissing,
 * MovieDownloadService, and EpisodeDownloadService.
 *
 * Returns the array sorted by relevance (best first). Caller decides
 * whether to pick the first zero-rejection release or expose all rows.
 */
export async function scoreAndSortReleases(
  releases: ReleaseCandidate[],
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
        deps.isBlocked(r.title, r.indexerId),
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

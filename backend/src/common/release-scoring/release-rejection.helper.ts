import { QualityProfileItem } from '../../modules/profiles/entities/quality-profile.entity';
import { AudioLanguageItem } from '../../modules/profiles/entities/language-profile.entity';
import { APP_LANGUAGES } from '../constants/app-languages';
import { getAppQualityById } from '../constants/app-qualities';
import {
  parseReleaseLanguage,
  parseReleaseQuality,
  parseSeasonEpisode,
  resolveUnknownLanguage,
} from '../release-parsing';

/** A search hit as parsed off the wire by whoever fetched it —
 *  the input contract every scoring/rejection function below consumes. */
export interface ReleaseCandidate {
  title: string;
  downloadUrl: string;
  sourceId: number;
  sourceName: string;
  size: number; // bytes, 0 if unknown
  seeders: number;
  leechers: number;
  publishDate: string | null; // ISO date string from <pubDate>, null if unavailable
  /** Source-declared markers a name cannot carry — `freeleech`, `halfleech`, whatever a
   *  tracker announces next. An open set on purpose: a custom-format condition and the
   *  ordering rule both read it by name, so a new marker needs no change here. */
  flags: readonly string[];
}

/**
 * Fold a source's release markers into the open flag set the scorer reads. A torrent's
 * `freeleech` / `downloadVolumeFactor` are one spelling of it, so a caller may send either
 * form; anything unrecognised rides through under its own name.
 */
export function releaseFlags(source: {
  flags?: readonly string[];
  freeleech?: boolean;
  downloadVolumeFactor?: number;
}): string[] {
  const out = new Set(source.flags ?? []);
  if (source.freeleech || source.downloadVolumeFactor === 0) out.add('freeleech');
  if (source.downloadVolumeFactor === 0.5) out.add('halfleech');
  return [...out];
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
 * variants for matching: release titles
 * use the original (typically English) name, so we prefer `originalTitle`
 * as the query while passing every known spelling — original, localized,
 * alternative — through to the matcher.
 *
 * `customQuery` overrides everything: it stays authoritative both for
 * the query and the expected-title list (otherwise a source-specific
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
  // some sources tokenise dots to spaces, which would otherwise hide the
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

export interface TitleExpectationIndex {
  /** Significant tokens per readable reading; empty when nothing in the expectation is comparable. */
  readings: string[][];
  /** Number-like tokens the expected titles carry themselves, single characters included — those
   *  are dropped from `readings`, so a title ending in a number would otherwise
   *  read as a sequel of itself. */
  numbers: Set<string>;
  /** True when the expectation list was empty, which matches anything. */
  vacuous: boolean;
}

/** Tokenises one media's expected titles once, so a scan over many release titles does not redo it. */
export function indexTitleExpectations(expected: string | string[]): TitleExpectationIndex {
  const candidates = (Array.isArray(expected) ? expected : [expected]).filter(
    (s): s is string => !!s && s.trim().length > 0,
  );
  if (!candidates.length) return { readings: [], numbers: new Set(), vacuous: true };
  const readings: string[][] = [];
  const numbers = new Set<string>();
  for (const cand of candidates) {
    for (const reading of titleReadings(cand)) {
      for (const token of reading) {
        if (/^\d+$/.test(token)) numbers.add(token);
      }
      const tokens = significantTokens(reading);
      if (tokens.length) readings.push(tokens);
    }
  }
  return { readings, numbers, vacuous: false };
}

/** The release side of the same comparison, hoisted so it is computed once per release title. */
export function releaseTitleTokens(releaseTitle: string): ReadonlySet<string> {
  return new Set(titleReadings(releaseTitle).flat());
}

/** Ordered readings of a release title — the sequel check needs what follows the expected
 *  title, which a token set cannot say. */
function releaseTitleReadings(releaseTitle: string): string[][] {
  return titleReadings(releaseTitle);
}

/** A number a sequel wears: `2`…`99`, or a roman numeral. `v` and `x` are left out — alone they
 *  read as a title word far more often than as a number. */
const SEQUEL_NUMBER = /^([2-9]|[1-9]\d|ii|iii|iv|vi|vii|viii|ix)$/;

/** Words that name a multi-film pack rather than a film. */
const COLLECTION_WORD =
  /^(collection|collections|duology|trilogy|quadrilogy|tetralogy|pentalogy|hexalogy|anthology|saga|filmography)$/;

/** Index of the release token right after the expected title's last token, matching the expected
 *  tokens in order but tolerating anything between them (a release keeps stopwords the expectation
 *  dropped). Null when this reading does not carry the whole expectation. */
function tokenAfterExpectation(release: string[], expected: string[]): number | null {
  let at = 0;
  for (const token of expected) {
    const found = release.indexOf(token, at);
    if (found === -1) return null;
    at = found + 1;
  }
  return at;
}

/**
 * The number this release appends to the title we asked for — `Nova Skyline 2` against
 * `Nova Skyline`. That is another film, and the token-inclusion check cannot see it: every
 * token of the expectation is there, the release simply says more.
 *
 * Null as soon as one reading of one expected title carries no such number, so a media whose own
 * title ends in a number, and an alternative title that matches cleanly, both stay untouched.
 */
export function appendedSequelNumber(
  releaseTitle: string,
  index: TitleExpectationIndex,
): string | null {
  if (index.vacuous || !index.readings.length) return null;
  let found: string | null = null;
  for (const release of releaseTitleReadings(releaseTitle)) {
    for (const expected of index.readings) {
      const at = tokenAfterExpectation(release, expected);
      if (at === null) continue;
      const next = release[at];
      if (
        next === undefined ||
        !SEQUEL_NUMBER.test(next) ||
        expected.includes(next) ||
        index.numbers.has(next)
      ) {
        return null;
      }
      found ??= next;
    }
  }
  return found;
}

/** The pack word this release wears, when the title we asked for does not wear it itself. */
export function collectionPackWord(
  releaseTitle: string,
  index: TitleExpectationIndex,
): string | null {
  const expected = new Set(index.readings.flat());
  for (const token of releaseTitleReadings(releaseTitle).flat()) {
    if (COLLECTION_WORD.test(token) && !expected.has(token)) return token;
  }
  return null;
}

/** Years a release title states. `1080p`, `x264` and `DDP5.1` never read as one — the word
 *  boundary after four digits is what rules them out. */
export function releaseYears(releaseTitle: string): number[] {
  return [...releaseTitle.matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => Number(m[0]));
}

export function matchesIndexedExpectation(
  releaseTokens: ReadonlySet<string>,
  index: TitleExpectationIndex,
  whenUnreadable: 'match' | 'no-match' = 'match',
): boolean {
  if (index.vacuous) return true;
  for (const tokens of index.readings) {
    if (tokens.every((t) => releaseTokens.has(t))) return true;
  }
  return index.readings.length === 0 && whenUnreadable === 'match';
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
 * Used as a safety net for a source that ignores `q=` and returns any
 * S01 / category-2000 release regardless of what we asked for.
 */
export function titleMatchesExpectation(
  releaseTitle: string,
  expected: string | string[],
  /** What an expectation this tokenizer cannot read (a wholly non-Latin title) means: a rejection
   *  net must not veto what it cannot read, identification must not claim every release. */
  whenUnreadable: 'match' | 'no-match' = 'match',
): boolean {
  const index = indexTitleExpectations(expected);
  if (index.vacuous) return true;
  return matchesIndexedExpectation(releaseTitleTokens(releaseTitle), index, whenUnreadable);
}

/** `S04E03`, `S04`, or `?` — the display params of an EPISODE_MISMATCH. */
function formatSeasonEpisode(
  season: number | null | undefined,
  episode: number | null | undefined,
): string {
  const n = (v: number) => String(v).padStart(2, '0');
  if (season == null) return episode == null ? '?' : `E${n(episode)}`;
  return episode == null ? `S${n(season)}` : `S${n(season)}E${n(episode)}`;
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
  sourceId: number;
  sourceMinSeeders: Map<number, number>;
  /** Release title — used to detect video codec for size-limit scaling AND
   *  for the title-mismatch check below. */
  releaseTitle?: string;
  /** Expected show / movie title(s). Pass the canonical title together
   *  with TMDB / TVDB alternative titles so that releases indexed under a
   *  localised name still pass; otherwise they get `TITLE_MISMATCH`. */
  expectedTitle?: string | string[];
  /** Season the request targets. A release naming a different season is
   *  rejected; a title with no readable season number is left alone. */
  expectedSeason?: number;
  /** Episode the request targets. A release naming a different episode is rejected, and so is a
   *  full-season pack — fetching a whole season to fill one episode. */
  expectedEpisode?: number;
  /** From `want.minResolution`: the resolution already on disk when the profile allows only a
   *  resolution upgrade. 0 or absent means the rule does not apply. */
  minResolution?: number;
  /** Release year of the media. A release stating another year names another work — the
   *  token-inclusion title check cannot tell `Nova Skyline 2 2015` from `Nova Skyline`. */
  expectedYear?: number | null;
  /** Total custom-format score of this release, and the profile's floor for it. A
   *  negative-score format only blocks a grab through this floor; without it the
   *  score is a tiebreak and the release is still taken when nothing better exists. */
  customFormatScore?: number;
  minCustomFormatScore?: number;
  /** Quality rank of this release, and the window the profile leaves open: strictly
   *  above what is on disk, up to the cutoff. Absent bounds mean no window applies
   *  (a missing grab, or a title with no quality profile). */
  rank?: number;
  minRankExclusive?: number;
  maxRankInclusive?: number;
}): ReleaseRejection[] {
  const out: ReleaseRejection[] = [];

  if (opts.expectedTitle && opts.releaseTitle) {
    const index = indexTitleExpectations(opts.expectedTitle);
    if (!matchesIndexedExpectation(releaseTitleTokens(opts.releaseTitle), index)) {
      out.push({ code: 'TITLE_MISMATCH' });
    } else {
      // Everything below only applies to a release that already passed as this title: they name
      // what a token-inclusion check cannot see — what the release says *beyond* the expectation.
      const sequel = appendedSequelNumber(opts.releaseTitle, index);
      if (sequel !== null) {
        out.push({ code: 'SEQUEL_MISMATCH', params: { number: sequel } });
      }
      // A pack of films answers a request for one of them by fetching all of them. Left alone for
      // a season-scoped search, where a pack is exactly what is wanted.
      const pack = opts.expectedSeason == null || opts.expectedEpisode != null
        ? collectionPackWord(opts.releaseTitle, index)
        : null;
      if (pack !== null) {
        out.push({ code: 'COLLECTION_PACK', params: { word: pack } });
      }
    }
  }

  // A release that states no year is not judged on one: most name theirs, some never do.
  if (opts.releaseTitle && opts.expectedYear) {
    const years = releaseYears(opts.releaseTitle);
    if (years.length && !years.some((y) => Math.abs(y - opts.expectedYear!) <= 1)) {
      out.push({
        code: 'YEAR_MISMATCH',
        params: { expected: opts.expectedYear, actual: years.join(', ') },
      });
    }
  }

  if (
    opts.releaseTitle &&
    (opts.expectedSeason != null || opts.expectedEpisode != null)
  ) {
    const se = parseSeasonEpisode(opts.releaseTitle);
    const wrongSeason =
      opts.expectedSeason != null &&
      se.season != null &&
      se.season !== opts.expectedSeason;
    const wrongEpisode =
      opts.expectedEpisode != null &&
      se.episode != null &&
      se.episode !== opts.expectedEpisode;
    if (wrongSeason || wrongEpisode) {
      out.push({
        code: 'EPISODE_MISMATCH',
        params: {
          expected: formatSeasonEpisode(opts.expectedSeason, opts.expectedEpisode),
          actual: formatSeasonEpisode(se.season, se.episode),
        },
      });
    }
    // A pack answers a request for one episode by fetching the whole season. Stated as its own
    // rule rather than left to the size limits: those need a runtime, and a series whose provider
    // gives none has no size ceiling at all — which is how a 19 GB season pack was taken to fill
    // a single missing episode.
    if (opts.expectedEpisode != null && se.isFullSeason) {
      out.push({
        code: 'FULL_SEASON_FOR_EPISODE',
        params: {
          expected: formatSeasonEpisode(opts.expectedSeason, opts.expectedEpisode),
        },
      });
    }
  }

  if (!opts.allowed.has(opts.qualityId)) {
    out.push({ code: 'QUALITY_NOT_ALLOWED' });
  }

  if (
    opts.minCustomFormatScore != null &&
    (opts.customFormatScore ?? 0) < opts.minCustomFormatScore
  ) {
    out.push({
      code: 'CUSTOM_FORMAT_SCORE_TOO_LOW',
      params: {
        actual: opts.customFormatScore ?? 0,
        min: opts.minCustomFormatScore,
      },
    });
  }

  // The window an upgrade may move within. Computed by core and, until now, applied only by the
  // acquisition plugin's own picker — so `releases.score` answered "no rejections" for releases
  // the scheduler then refused, and the manual search modal had nothing to show for it.
  if (opts.rank != null) {
    if (opts.minRankExclusive != null && opts.rank <= opts.minRankExclusive) {
      out.push({
        code: 'RANK_NOT_AN_UPGRADE',
        params: { actual: opts.rank, min: opts.minRankExclusive },
      });
    }
    if (opts.maxRankInclusive != null && opts.rank > opts.maxRankInclusive) {
      out.push({
        code: 'RANK_ABOVE_CUTOFF',
        params: { actual: opts.rank, max: opts.maxRankInclusive },
      });
    }
  }

  // "Upgrade resolution only": the profile refuses a same-resolution tier hop, so a 1080p Bluray
  // must not replace a 1080p WEB-DL. Nothing enforced this after the acquisition split — the
  // plugin's own note assumed core folded it into the rejections, and core never did.
  if (opts.minResolution != null && opts.minResolution > 0) {
    const releaseResolution = parseReleaseQuality(opts.releaseTitle ?? '').quality.resolution;
    if (releaseResolution <= opts.minResolution) {
      out.push({
        code: 'RESOLUTION_NOT_UPGRADED',
        params: { actual: releaseResolution, min: opts.minResolution },
      });
    }
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

  const minSeed = opts.sourceMinSeeders.get(opts.sourceId) ?? 0;
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
 * 5. Full-season pack (`preferFullSeason` only) — one pack beats loose
 *    episodes at the same resolution whatever the source, but never
 *    outranks a higher resolution.
 * 6. Quality rank (higher = better)
 * 7. Custom format score (higher = better)
 * 8. Freeleech bonus
 * 9. Seeders (more = better, log scale to avoid over-weighting)
 * 10. Leechers (more = better, same scale) — breaks seeder ties toward the
 *    busier swarm.
 * 11. Size closer to preferred (less deviation = better)
 *
 * Availability (4, 9, 10) outranks quality only at the dead/alive boundary;
 * between two live releases quality wins, and seeders/leechers order releases
 * within the same quality tier ahead of the weaker size-proximity signal.
 */
export function sortReleasesByRelevance<
  T extends {
    qualityId: number;
    rank: number;
    allowed: boolean;
    blocklisted: boolean;
    languageAllowed: boolean;
    rejections: ReleaseRejection[];
    customFormatScore: number;
    seeders: number;
    leechers: number;
    flags: readonly string[];
    sizeDeviation?: number | null;
    isFullSeason?: boolean;
  },
>(rows: T[], opts?: { preferFullSeason?: boolean }): T[] {
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

    // 5. One pack over loose episodes at the same resolution — a weaker
    //    source is worth less than eight files to stitch together.
    if (opts?.preferFullSeason && !!a.isFullSeason !== !!b.isFullSeason) {
      const aRes = getAppQualityById(a.qualityId)?.resolution ?? 0;
      const bRes = getAppQualityById(b.qualityId)?.resolution ?? 0;
      if (aRes === bRes) return a.isFullSeason ? -1 : 1;
    }

    // 6. Quality rank desc
    if (a.rank !== b.rank) return b.rank - a.rank;

    // 7. Custom format score desc — above freeleech, which a `release_flag`
    //    condition can express and score itself.
    if (a.customFormatScore !== b.customFormatScore)
      return b.customFormatScore - a.customFormatScore;

    // 8. Freeleech bonus
    const aFree = a.flags.includes('freeleech');
    const bFree = b.flags.includes('freeleech');
    if (aFree !== bFree) return aFree ? -1 : 1;

    // 9. Seeders desc (log scale)
    const aSeed = swarmScore(a.seeders);
    const bSeed = swarmScore(b.seeders);
    if (Math.abs(aSeed - bSeed) > SWARM_EPSILON) return bSeed - aSeed;

    // 10. Leechers desc (log scale) — tie-break toward the busier swarm.
    const aLeech = swarmScore(a.leechers);
    const bLeech = swarmScore(b.leechers);
    if (Math.abs(aLeech - bLeech) > SWARM_EPSILON) return bLeech - aLeech;

    // 11. Closer to preferred size wins (only when both rows expose it
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
  scoreCustomFormats(title: string, flags: readonly string[]): Promise<number>;
  /** `sourceId` rides along so a caller keyed by per-release index (rather
   *  than by title, which two releases may share) can disambiguate. */
  isBlocked(title: string, sourceId: number): Promise<boolean>;
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
    sourceMinSeeders: Map<number, number>;
    sourceUnknownLang: Map<number, string | undefined>;
    runtimeMinutes: number;
    /** Title(s) we expect releases to refer to. Releases whose name
     *  doesn't contain the significant tokens of *any* candidate are
     *  flagged TITLE_MISMATCH. */
    expectedTitle?: string | string[];
    /** Season / episode the search targets, when it is episode-scoped —
     *  releases naming another one are flagged EPISODE_MISMATCH. */
    expectedSeason?: number;
    expectedEpisode?: number;
    /** From `want.minResolution`: the resolution already on disk when the profile only allows a
     *  resolution upgrade. 0 or absent means the rule does not apply. */
    minResolution?: number;
    /** Release year of the media — a release naming another year names another work. */
    expectedYear?: number | null;
    /** From the quality profile: releases scoring below this are rejected outright. */
    minCustomFormatScore?: number;
    /** The upgrade window: strictly above what is on disk, up to the cutoff. */
    minRankExclusive?: number;
    maxRankInclusive?: number;
  },
  deps: ReleaseScorerDeps,
): Promise<ScoredRelease[]> {
  const rows = await Promise.all(
    releases.map(async (r) => {
      const parsed = parseReleaseQuality(r.title);
      const lang = resolveUnknownLanguage(
        parseReleaseLanguage(r.title),
        opts.sourceUnknownLang.get(r.sourceId),
      );
      const [cfScore, isBlocklisted] = await Promise.all([
        deps.scoreCustomFormats(r.title, r.flags),
        deps.isBlocked(r.title, r.sourceId),
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
        sourceId: r.sourceId,
        sourceMinSeeders: opts.sourceMinSeeders,
        releaseTitle: r.title,
        expectedTitle: opts.expectedTitle,
        expectedSeason: opts.expectedSeason,
        expectedEpisode: opts.expectedEpisode,
        minResolution: opts.minResolution,
        expectedYear: opts.expectedYear,
        customFormatScore: cfScore,
        minCustomFormatScore: opts.minCustomFormatScore,
        rank: parsed.quality.rank,
        minRankExclusive: opts.minRankExclusive,
        maxRankInclusive: opts.maxRankInclusive,
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
  // Season-scoped search (a season, not one episode): prefer a pack.
  return sortReleasesByRelevance(rows, {
    preferFullSeason:
      opts.expectedSeason != null && opts.expectedEpisode == null,
  });
}

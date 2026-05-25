import {
  ReleaseAttributes,
  parseReleaseAttributes,
} from '../media/release-attributes.parser';
import { parseSeasonEpisode } from '../media/release-episode.parser';

/**
 * Bazarr-style scoring weights (mirrored from
 * `subliminal_patch/score.py`). Each weight is the credit awarded when
 * the attribute MATCHES between the candidate subtitle and the local
 * video file. `MAX_*` is the sum of all weights for that kind, used to
 * normalise the score to a 0-100 percentage so the user-facing thresholds
 * stay portable across episode / movie regardless of which weights drift.
 */
export const EPISODE_WEIGHTS = {
  hash: 359,
  series: 180,
  year: 90,
  season: 30,
  episode: 30,
  releaseGroup: 14,
  source: 7,
  audioCodec: 3,
  resolution: 2,
  videoCodec: 2,
  hearingImpaired: 1,
} as const;

export const MOVIE_WEIGHTS = {
  hash: 119,
  title: 60,
  year: 30,
  releaseGroup: 13,
  source: 7,
  audioCodec: 3,
  resolution: 2,
  videoCodec: 2,
  edition: 1,
  hearingImpaired: 1,
} as const;

export const MAX_EPISODE_SCORE = Object.values(EPISODE_WEIGHTS).reduce(
  (a, b) => a + b,
  0,
);
export const MAX_MOVIE_SCORE = Object.values(MOVIE_WEIGHTS).reduce(
  (a, b) => a + b,
  0,
);

export interface SubtitleScoreCandidate {
  /** Release name the provider returned for this subtitle (preferred field
   *  for attribute matching). May be missing on providers that don't
   *  expose one — score falls back to language+equivalence credit. */
  releaseName?: string | null;
  /** True when the candidate came from a hash-based provider lookup
   *  (e.g. OpenSubtitles moviehash search). Awards full hash weight,
   *  which alone usually beats every other release-name match. */
  hashMatched?: boolean;
  /** IMDB id reported by the provider — used by the equivalence map. */
  imdbId?: string | null;
  /** True when the subtitle is flagged as hearing-impaired / SDH. */
  hearingImpaired?: boolean;
}

export interface SubtitleScoreVideoContext {
  /** 'episode' or 'movie'. Picks the weights set. */
  kind: 'episode' | 'movie';
  /** Local video file's release name (typically the file basename). When
   *  null the attribute-match block gets zero credit and the scorer is
   *  effectively language+equivalence only. */
  videoReleaseName: string | null;
  /** Canonical media title (TMDB-side). */
  title: string;
  /** Year, when known. */
  year?: number | null;
  /** Series-only: season number on the file. */
  season?: number | null;
  /** Series-only: episode number on the file. */
  episode?: number | null;
  /** IMDB id of the media — used by equivalence map. */
  imdbId?: string | null;
  /** Caller preference for hearing-impaired subs (default: `avoid` →
   *  award the bit when candidate is NOT hearing-impaired). `require` /
   *  `forbid` are enforced by the orchestrator before scoring; the
   *  scorer treats them as a `prefer` / `avoid` for the bit weight. */
  hearingImpairedMode?: 'prefer' | 'avoid' | 'require' | 'forbid';
}

export interface SubtitleScore {
  /** Sum of weights of every matched attribute. Range 0..MAX_*. */
  raw: number;
  /** Max possible for this kind — useful for serialising debug info. */
  max: number;
  /** Normalised 0..100 score. The scheduler thresholds compare against this. */
  percent: number;
  /** Names of attributes that matched. */
  matches: string[];
}

/**
 * Score a subtitle candidate against the video context using
 * Bazarr-style attribute matching. Pure function — no I/O.
 */
export function scoreSubtitle(
  candidate: SubtitleScoreCandidate,
  context: SubtitleScoreVideoContext,
): SubtitleScore {
  const isEpisode = context.kind === 'episode';
  const weights = isEpisode ? EPISODE_WEIGHTS : MOVIE_WEIGHTS;
  const max = isEpisode ? MAX_EPISODE_SCORE : MAX_MOVIE_SCORE;
  const matches: string[] = [];
  let raw = 0;

  const award = (name: string, value: number) => {
    // Idempotent: an attribute credited once (e.g. `series` via hash)
    // doesn't double-score when the same attribute also matches via
    // imdb-equivalence or release-name. Keeps the running total ≤ max.
    if (matches.includes(name)) return;
    raw += value;
    matches.push(name);
  };

  // Hash matching is treated as Bazarr-style perfect identification:
  // every "id-style" attribute (series / title / year / season / episode)
  // is credited because a movie/episode hash collision is effectively
  // impossible. We DON'T short-circuit — release-name attributes still
  // get credited below when present, so a hash + perfect-release combo
  // can reach 100% while hash + missing-release tops out lower.
  if (candidate.hashMatched) {
    award('hash', weights.hash);
    if (isEpisode) {
      award('series', (weights as typeof EPISODE_WEIGHTS).series);
      award('season', (weights as typeof EPISODE_WEIGHTS).season);
      award('episode', (weights as typeof EPISODE_WEIGHTS).episode);
    } else {
      award('title', (weights as typeof MOVIE_WEIGHTS).title);
    }
    if (context.year) award('year', weights.year);
  }

  // IMDB equivalence: a confirmed imdb-id match means the provider
  // located the right title/year (and the right series for episodes).
  // Saves us from depending on release-name token matching for those.
  const imdbMatched =
    !!candidate.imdbId &&
    !!context.imdbId &&
    candidate.imdbId.replace(/^tt/, '') ===
      context.imdbId.replace(/^tt/, '');
  if (imdbMatched) {
    if (isEpisode) {
      award('series', (weights as typeof EPISODE_WEIGHTS).series);
    } else {
      award('title', (weights as typeof MOVIE_WEIGHTS).title);
    }
    if (context.year) award('year', weights.year);
  }

  // Release-name attribute matching. Without a release name from either
  // side we skip the whole block — the candidate falls back to the bonuses
  // already awarded above plus hearing_impaired below.
  if (candidate.releaseName && context.videoReleaseName) {
    const subAttrs = parseReleaseAttributes(candidate.releaseName);
    const vidAttrs = parseReleaseAttributes(context.videoReleaseName);

    if (
      subAttrs.releaseGroup &&
      vidAttrs.releaseGroup &&
      subAttrs.releaseGroup === vidAttrs.releaseGroup
    ) {
      award('releaseGroup', weights.releaseGroup);
    }
    if (subAttrs.source && vidAttrs.source && subAttrs.source === vidAttrs.source) {
      award('source', weights.source);
    }
    if (
      subAttrs.resolution &&
      vidAttrs.resolution &&
      subAttrs.resolution === vidAttrs.resolution
    ) {
      award('resolution', weights.resolution);
    }
    if (
      subAttrs.videoCodec &&
      vidAttrs.videoCodec &&
      subAttrs.videoCodec === vidAttrs.videoCodec
    ) {
      award('videoCodec', weights.videoCodec);
    }
    if (
      subAttrs.audioCodec &&
      vidAttrs.audioCodec &&
      subAttrs.audioCodec === vidAttrs.audioCodec
    ) {
      award('audioCodec', weights.audioCodec);
    }
    if (
      !isEpisode &&
      subAttrs.edition &&
      vidAttrs.edition &&
      subAttrs.edition === vidAttrs.edition
    ) {
      award('edition', (weights as typeof MOVIE_WEIGHTS).edition);
    }

    // Series / title / year recovery from release names when imdb didn't
    // match. Comparison strips every non-alphanumeric so dots / dashes /
    // underscores / spaces between words don't break the match
    // (`Mr.Robot.S01…` should match `Mr. Robot`).
    if (!matches.includes('series') && !matches.includes('title')) {
      if (looseTitleMatch(candidate.releaseName, context.title)) {
        if (isEpisode) {
          award('series', (weights as typeof EPISODE_WEIGHTS).series);
        } else {
          award('title', (weights as typeof MOVIE_WEIGHTS).title);
        }
      }
    }
    if (!matches.includes('year') && context.year) {
      if (new RegExp(`\\b${context.year}\\b`).test(candidate.releaseName)) {
        award('year', weights.year);
      }
    }

    // Season / episode for series — extracted from the release name.
    if (isEpisode) {
      const parsed = parseSeasonEpisode(candidate.releaseName);
      if (
        parsed.season != null &&
        context.season != null &&
        parsed.season === context.season
      ) {
        award('season', (weights as typeof EPISODE_WEIGHTS).season);
      }
      if (
        parsed.episode != null &&
        context.episode != null &&
        parsed.episode === context.episode
      ) {
        award('episode', (weights as typeof EPISODE_WEIGHTS).episode);
      }
    }
  }

  // Hearing-impaired bit. The 1-point weight is intentionally small —
  // it's a tie-breaker among already-eligible candidates. Hard
  // enforcement (`require` / `forbid`) belongs to the orchestrator
  // which filters candidates BEFORE scoring; here we map all four
  // modes to a binary "prefer HI?" flag for the bit award.
  const mode = context.hearingImpairedMode ?? 'avoid';
  const prefersHI = mode === 'prefer' || mode === 'require';
  if (prefersHI ? candidate.hearingImpaired : !candidate.hearingImpaired) {
    award('hearingImpaired', weights.hearingImpaired);
  }

  return finalize(raw, max, matches);
}

function finalize(raw: number, max: number, matches: string[]): SubtitleScore {
  const percent = Math.max(0, Math.min(100, Math.round((raw / max) * 100)));
  return { raw, max, percent, matches };
}

/** Loose title-in-release-name check. Strips every non-alphanumeric on
 *  both sides so token separators (`.`, `-`, `_`, space) don't matter. */
function looseTitleMatch(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const n = norm(needle);
  if (!n) return false;
  return norm(haystack).includes(n);
}

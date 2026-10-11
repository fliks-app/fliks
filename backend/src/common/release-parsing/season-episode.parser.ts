/**
 * Lightweight parser for season / episode info in a torrent release title.
 *
 * Recognises the conventional patterns shipped by every scene release name:
 *
 *   - `Show.Name.S01E02.…`      → season 1, episode 2.
 *   - `Show.Name.s01e02.…`      → same (case-insensitive).
 *   - `Show.Name.S01.…`         → full season 1 (pack).
 *   - `Show.Name.Season.01.…`   → full season 1 (older form).
 *   - `Show.Name.1x02.…`        → `<season>x<episode>` form.
 *   - `Show.Name.Complete.S01`  → full season 1.
 *   - `S01-S04`, `Seasons 1 to 4`, `S01E04E05`, `S01E04-05` → ranges.
 *   - `Complete.Series` with no season → complete series.
 *
 * Pure function, no dependencies. Tests live next to the file.
 */
/** What a release title covers, as parsed by core. Ranges are inclusive. */
export interface ReleaseCoverage {
  /** Null when the title states no season (a complete-series release, or unparseable). */
  seasons: { from: number; to: number } | null;
  /** Episodes within `seasons.from`; null for a season pack or multi-season pack. */
  episodes: { from: number; to: number } | null;
  /** Complete series / integral release that names no season: covers every season. */
  completeSeries: boolean;
}

export interface ParsedSeasonEpisode {
  /** 0-padded season number, or `null` when not detectable. For a
   *  multi-season pack this is the first season. */
  season: number | null;
  /** Single episode number when applicable, or `null` for season packs
   *  and movies. For a multi-episode release this is the first episode. */
  episode: number | null;
  /** True for season packs / complete-season releases (no individual
   *  episode number in the title), multi-season packs included. */
  isFullSeason: boolean;
  /** Last season of a multi-season pack; `null` otherwise. */
  seasonEnd: number | null;
  /** Last episode of a multi-episode release; `null` otherwise. */
  episodeEnd: number | null;
  /** A complete-series release that names no season. */
  isCompleteSeries: boolean;
}

/** `S01E04`, `S01E04E05`, `S01E04-E05`, `S01E04-05`. A bare `-NN` tail never swallows a
 *  resolution (`-1080p`) because the number must end on a word boundary. */
const SE_RE = /\bS(\d{1,2})E(\d{1,3})(?:((?:-?E\d{1,3})+)|-(\d{1,3}))?\b/i;
/** `S01-S04`, `S01-04`, `S01 to S04`. A bare second number needs a tight hyphen: `S2 - 04` is an
 *  episode and `S01 to 04` is not a range. */
const SEASON_RANGE_RE =
  /\bS(\d{1,2})(?:-(\d{1,2})|[\s._]*(?:-|to|a|à)[\s._]*S(\d{1,2}))\b/i;
/** `Season 1-4`, `Seasons 1 to 4`, `Saison 1 à 4`, `Saisons.1-4`, `Saison.1.a.4`. */
const SEASON_WORD_RANGE_RE =
  /\b(?:Seasons?|Saisons?)[\s._-]?(\d{1,2})(?:-(\d{1,2})|[\s._]+(?:to|a|à)[\s._]+S?(\d{1,2}))\b/i;
/** `S01.S02.S03`. */
const SEASON_LIST_RE = /\bS(\d{1,2})((?:[\s._+&,-]+S\d{1,2})+)\b/i;
/** Anime `S2 - 04` / `Season 2 - 05`: a season, then a spaced hyphen, then the episode. */
const SEASON_DASH_EPISODE_RE =
  /\b(?:S|Seasons?[\s._]?|Saisons?[\s._]?)(\d{1,2})[\s._]+-[\s._]+(\d{1,3})(?![.,]\d)(?:-(\d{1,3}))?\b/i;
const SEASON_ONLY_RE = /\bS(\d{1,2})(?!E\d)\b/i;
const SEASON_KEYWORD_RE = /\b(?:Seasons?|Saisons?)[\s._-]?(\d{1,2})\b/i;
/** The `1x02` `<season>x<episode>` form. Neither side may touch a letter or digit (`x265`,
 *  `S05x265`, `1080x1920`) and a codec number never reads as an episode. `1x04-05` is a range. */
const SEASON_X_EPISODE_RE =
  /(?<![a-zA-Z\d])(\d{1,2})x(?!26[45]\b)(\d{1,3})(?:-(\d{1,3}))?\b/i;
const COMPLETE_SERIES_RE = /\b(?:Complete[\s._-]*Series|Int[eé]grale)\b/i;

const upTo = (from: number, to: number | undefined): number | null =>
  to !== undefined && to > from ? to : null;

export const within = (
  range: { from: number; to: number },
  n: number,
): boolean => n >= range.from && n <= range.to;

export function parseSeasonEpisode(title: string): ParsedSeasonEpisode {
  const result = (
    season: number | null,
    episode: number | null,
    isFullSeason: boolean,
    seasonEnd: number | null = null,
    episodeEnd: number | null = null,
  ): ParsedSeasonEpisode => ({
    season,
    episode,
    isFullSeason,
    seasonEnd,
    episodeEnd,
    isCompleteSeries: season === null && COMPLETE_SERIES_RE.test(title),
  });
  const pack = (m: RegExpExecArray | null): ParsedSeasonEpisode | null => {
    if (!m) return null;
    const from = parseInt(m[1], 10);
    const to = upTo(from, parseInt(m[2] ?? m[3], 10));
    return to === null ? null : result(from, null, true, to);
  };

  // 1. SxxExx — most common, with optional multi-episode tail.
  const se = SE_RE.exec(title);
  if (se) {
    const episode = parseInt(se[2], 10);
    const chained = se[3]?.match(/\d+/g);
    const last = chained
      ? parseInt(chained[chained.length - 1], 10)
      : se[4]
        ? parseInt(se[4], 10)
        : undefined;
    return result(
      parseInt(se[1], 10),
      episode,
      false,
      null,
      upTo(episode, last),
    );
  }
  // 2. `1x02` form.
  const xForm = SEASON_X_EPISODE_RE.exec(title);
  if (xForm) {
    const episode = parseInt(xForm[2], 10);
    return result(
      parseInt(xForm[1], 10),
      episode,
      false,
      null,
      upTo(episode, xForm[3] ? parseInt(xForm[3], 10) : undefined),
    );
  }
  // 3. Multi-season pack, before the single-season fallbacks that would read only its first.
  const range =
    pack(SEASON_RANGE_RE.exec(title)) ?? pack(SEASON_WORD_RANGE_RE.exec(title));
  if (range) return range;
  // A list claims a range only when contiguous: a gap would claim seasons that are not in it.
  const list = SEASON_LIST_RE.exec(title);
  if (list) {
    const nums = [list[1], ...list[2].match(/\d+/g)!].map((n) =>
      parseInt(n, 10),
    );
    if (
      nums.length > 1 &&
      nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)
    ) {
      return result(nums[0], null, true, nums[nums.length - 1]);
    }
  }
  // 4. `S2 - 04` anime form.
  const dash = SEASON_DASH_EPISODE_RE.exec(title);
  if (dash) {
    const episode = parseInt(dash[2], 10);
    return result(
      parseInt(dash[1], 10),
      episode,
      false,
      null,
      upTo(episode, dash[3] ? parseInt(dash[3], 10) : undefined),
    );
  }
  // 5. Season-only `S01` (no episode) → pack.
  const sonly = SEASON_ONLY_RE.exec(title);
  if (sonly) return result(parseInt(sonly[1], 10), null, true);
  // 6. `Season 01` / `Saison 01` keyword fallback.
  const skw = SEASON_KEYWORD_RE.exec(title);
  if (skw) return result(parseInt(skw[1], 10), null, true);
  return result(null, null, false);
}

/** What a parsed title covers; ranges are inclusive. */
export function coverageOf(p: ParsedSeasonEpisode): ReleaseCoverage {
  return {
    seasons:
      p.season === null
        ? null
        : { from: p.season, to: p.seasonEnd ?? p.season },
    episodes:
      p.episode === null
        ? null
        : { from: p.episode, to: p.episodeEnd ?? p.episode },
    completeSeries: p.isCompleteSeries,
  };
}

export const releaseCoverage = (title: string): ReleaseCoverage =>
  coverageOf(parseSeasonEpisode(title));

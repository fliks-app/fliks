/**
 * Lightweight parser for season / episode info in a torrent release title.
 *
 * Recognises the conventional patterns shipped by every scene release name:
 *
 *   - `Show.Name.S01E02.…`      → season 1, episode 2.
 *   - `Show.Name.s01e02.…`      → same (case-insensitive).
 *   - `Show.Name.S01.…`         → full season 1 (pack).
 *   - `Show.Name.Season.01.…`   → full season 1 (older form).
 *   - `Show.Name.1x02.…`        → legacy `<season>x<episode>` form.
 *   - `Show.Name.Complete.S01`  → full season 1.
 *
 * Pure function, no dependencies. Tests live next to the file.
 */
export interface ParsedSeasonEpisode {
  /** 0-padded season number, or `null` when not detectable. */
  season: number | null;
  /** Single episode number when applicable, or `null` for season packs
   *  and movies. */
  episode: number | null;
  /** True for season packs / complete-season releases (no individual
   *  episode number in the title). */
  isFullSeason: boolean;
}

const SE_RE = /\bS(\d{1,2})E(\d{1,3})\b/i;
const SEASON_ONLY_RE = /\bS(\d{1,2})(?!E\d)\b/i;
const SEASON_KEYWORD_RE = /\bSeason[\s._-]?(\d{1,2})\b/i;
/** Legacy `1x02` — require a digit before `x` so `x265` / `HEVCx265`
 *  never parse as season 26 episode 5. */
const LEGACY_RE = /(?<![a-zA-Z])(\d{1,2})x(\d{1,3})\b/i;

export function parseSeasonEpisode(title: string): ParsedSeasonEpisode {
  // 1. SxxExx — most common.
  const se = SE_RE.exec(title);
  if (se) {
    return {
      season: parseInt(se[1], 10),
      episode: parseInt(se[2], 10),
      isFullSeason: false,
    };
  }
  // 2. Legacy `1x02` form.
  const legacy = LEGACY_RE.exec(title);
  if (legacy) {
    return {
      season: parseInt(legacy[1], 10),
      episode: parseInt(legacy[2], 10),
      isFullSeason: false,
    };
  }
  // 3. Season-only `S01` (no episode) → pack.
  const sonly = SEASON_ONLY_RE.exec(title);
  if (sonly) {
    return {
      season: parseInt(sonly[1], 10),
      episode: null,
      isFullSeason: true,
    };
  }
  // 4. `Season 01` keyword fallback.
  const skw = SEASON_KEYWORD_RE.exec(title);
  if (skw) {
    return {
      season: parseInt(skw[1], 10),
      episode: null,
      isFullSeason: true,
    };
  }
  return { season: null, episode: null, isFullSeason: false };
}

/** True when `title` is a full-season pack for the requested season. */
export function matchesSeasonPack(
  title: string,
  seasonNumber: number,
): boolean {
  const p = parseSeasonEpisode(title);
  return p.isFullSeason && p.season === seasonNumber;
}

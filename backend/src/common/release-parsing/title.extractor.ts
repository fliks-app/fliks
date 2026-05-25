import { decodeHtmlEntities } from '../utils/decode-html-entities';
import { parseSeasonEpisode } from './season-episode.parser';

/**
 * Structured view of what a release name says about its content. Pure
 * extraction — does NOT touch the DB. Used by the torrent auto-matcher
 * (orphan recovery) and anywhere else we need to identify a media from
 * a raw release/file name without any other context.
 */
export interface ExtractedRelease {
  /** Normalised, lowercased, alphanumeric-only canonical title — useful
   *  as a search key (`ILIKE '%key%'`, in-memory matching). */
  searchKey: string;
  /** Pretty-printed title for display (dots/underscores collapsed to
   *  spaces, HTML entities decoded, no quality / scene metadata). */
  title: string;
  /** Detected release year (4 digits, range 1900-2099). Disambiguates
   *  remakes (e.g. The Italian Job 1969 vs 2003). */
  year: number | null;
  /** Season number when present (single ep or full pack). */
  season: number | null;
  /** Episode number when present (single ep only). */
  episode: number | null;
  /** True when the release is a season pack (`S01`, `Season 1`, no `Exx`). */
  isFullSeason: boolean;
  /**
   * Conservative guess at content kind. `series` when any S/E marker
   * is present. `movie` when a year is present and no S/E marker.
   * `unknown` otherwise — caller may still attempt both lookups.
   */
  kind: 'series' | 'movie' | 'unknown';
}

/**
 * Year detector. Restricted to 1900-2099 to skip false positives that
 * would otherwise grab resolutions (`1080`, `2160`) or random tokens.
 * Matched as a standalone token, with separators on both sides.
 */
const YEAR_RE = /\b((?:19|20)\d{2})\b/g;

/**
 * Matches the LAST occurrence of the canonical S/E / season / legacy
 * markers in the title. Used to slice the title prefix.
 */
const SE_CUT_RE = /\b(?:S\d{1,2}(?:E\d{1,3})?|Season[\s._-]?\d{1,2}|\d{1,2}x\d{1,3}|Complete[\s._-]?(?:Series|S\d{1,2}))\b/i;

/**
 * Tokens that mark the start of "scene metadata" (quality, source,
 * codec, group …) and are not part of the title. Sliced when we have
 * no S/E and no year to anchor on (rare).
 */
const METADATA_CUT_RE = /\b(?:2160p|1080p|720p|480p|4K|UHD|BluRay|BDRip|WEB-?DL|WEB-?Rip|HDTV|DVDRip|REMUX|x264|x265|HEVC|H[\s._]?264|H[\s._]?265|AV1|VP9|DTS|AC3|AAC|TrueHD|HDR|DV|HDR10|Atmos|MA|5\.1|7\.1)\b/i;

/**
 * Extract structured metadata from a raw release / file name.
 *
 * Algorithm:
 *  1. Decode HTML entities (`&amp;` → `&` etc.) so the title compares
 *     against DB titles cleanly.
 *  2. Find the LAST S/E or "Season N" marker — everything before it
 *     is the title slot. (Last, not first, because some show titles
 *     contain numerical tokens that could look like a season marker;
 *     scene releases always put S/E at the end of the title slot.)
 *  3. Else find a year — same trick.
 *  4. Else fall back to slicing at the first "scene metadata" token.
 *  5. Whatever is left, replace separators with spaces, trim, lowercase
 *     for `searchKey`, pretty-case for `title`.
 *
 * Doesn't try to be exhaustive: scoped to recover identification on
 * realistic torrent names from public + private trackers.
 */
export function extractMediaTitle(rawName: string): ExtractedRelease {
  const decoded = decodeHtmlEntities(rawName).replace(/\.torrent$/i, '');
  const se = parseSeasonEpisode(decoded);

  // Year scan happens over the full string so we can keep a year that
  // appears BEFORE the S/E marker (`Show.Name.2022.S01E01...` is common).
  const years = [...decoded.matchAll(YEAR_RE)].map((m) =>
    parseInt(m[1], 10),
  );
  // Prefer the year that appears in the title slot — i.e. before the
  // S/E marker if any. Falls back to the first year otherwise.
  const seMatch = SE_CUT_RE.exec(decoded);
  const cutIndex = seMatch?.index ?? -1;
  const yearsBeforeSE =
    cutIndex >= 0
      ? [...decoded.slice(0, cutIndex).matchAll(YEAR_RE)].map((m) =>
          parseInt(m[1], 10),
        )
      : years;
  const year = yearsBeforeSE[0] ?? null;

  let titleSlot: string;
  if (cutIndex >= 0) {
    titleSlot = decoded.slice(0, cutIndex);
  } else if (year !== null) {
    // Movie path: slice at the year token.
    const yearIdx = decoded.search(new RegExp(`\\b${year}\\b`));
    titleSlot = yearIdx >= 0 ? decoded.slice(0, yearIdx) : decoded;
  } else {
    // No S/E, no year — slice at the first scene-metadata token.
    const meta = METADATA_CUT_RE.exec(decoded);
    titleSlot = meta ? decoded.slice(0, meta.index) : decoded;
  }

  const pretty = prettifyTitle(titleSlot);
  const searchKey = pretty
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();

  const kind: ExtractedRelease['kind'] =
    se.season !== null
      ? 'series'
      : year !== null && cutIndex < 0
        ? 'movie'
        : 'unknown';

  return {
    searchKey,
    title: pretty,
    year,
    season: se.season,
    episode: se.episode,
    isFullSeason: se.isFullSeason,
    kind,
  };
}

function prettifyTitle(raw: string): string {
  return (
    raw
      .replace(/[._]+/g, ' ')
      // Strip a trailing year token whether it's bare (`The Crown 2016`)
      // or bracketed (`Inception (2010)`). The Y-stripping happens before
      // the bracket cleanup so the brackets can disappear too.
      .replace(/\s*\(?\b(?:19|20)\d{2}\)?\s*$/, '')
      // Strip orphan brackets / parentheses / dashes / colons left behind.
      .replace(/[()\[\]{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-:]+|[\s\-:]+$/g, '')
      .trim()
  );
}

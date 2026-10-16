/**
 * Single source of truth for "is an episode's content on disk" (coverage).
 *
 * `episode.hasFile` means "this episode has its OWN file" — used by playback,
 * intro detection and watched tracking. Coverage is broader: an episode is on
 * disk when it has its own file OR it's a shadowed episode of a multi-episode
 * file, i.e. inside the `[episodeNumber..endEpisodeNumber]` range of an owner
 * episode that has a file ("S06E17-E18.mkv" → E17 owns the file, E18 covered).
 *
 * Coverage is DERIVED, never stored, so it can't drift and needs no migration.
 * Missing/search/request/stats logic must use the helpers here, NOT raw
 * `hasFile`. The SQL fragment and the TS helper implement the same rule — keep
 * them in sync.
 */

/** Minimal episode shape the coverage rule needs. */
export interface CoverageEpisode {
  episodeNumber: number;
  endEpisodeNumber?: number | null;
  hasFile: boolean;
}

/** Episode numbers in a season whose content is on disk (own file or covered
 *  by a multi-episode file). Compute once per season, then `.has(epNumber)`. */
export function onDiskEpisodeNumbers(
  seasonEpisodes: CoverageEpisode[],
): Set<number> {
  const numbers = new Set<number>();
  for (const owner of seasonEpisodes) {
    if (!owner.hasFile) continue;
    numbers.add(owner.episodeNumber);
    const end = owner.endEpisodeNumber;
    if (end != null && end > owner.episodeNumber) {
      for (let n = owner.episodeNumber + 1; n <= end; n++) numbers.add(n);
    }
  }
  return numbers;
}

/** Whether a single episode's content is on disk, given its season siblings. */
export function isEpisodeOnDisk(
  episode: CoverageEpisode,
  seasonEpisodes: CoverageEpisode[],
): boolean {
  return onDiskEpisodeNumbers(seasonEpisodes).has(episode.episodeNumber);
}

/**
 * SQL boolean expression equivalent to {@link isEpisodeOnDisk}, for queries.
 * `epAlias` is the episodes-table alias in scope. The correlated subquery finds
 * an owner episode in the same season whose multi-episode range covers this row.
 */
export function onDiskSql(epAlias: string): string {
  const e = `"${epAlias}"`;
  return `(${e}."hasFile" = true OR EXISTS (
    SELECT 1 FROM "episodes" cov
    WHERE cov."seasonId" = ${e}."seasonId"
      AND cov."hasFile" = true
      AND cov."endEpisodeNumber" IS NOT NULL
      AND ${e}."episodeNumber" > cov."episodeNumber"
      AND ${e}."episodeNumber" <= cov."endEpisodeNumber"
  ))`;
}

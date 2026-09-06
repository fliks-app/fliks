/** True when at least one metadata-provider id is set; false for a title built from the file alone. */
export function hasProviderId(m: { tmdbId?: number | null; tvdbId?: number | null; imdbId?: string | null }): boolean {
  return m.tmdbId != null || m.tvdbId != null || !!m.imdbId;
}

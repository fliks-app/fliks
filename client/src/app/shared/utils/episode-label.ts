/** `S01E03 — Title` for a single-episode row, `''` for a movie or whole-season row; season falls back to 0 so it never renders `SE03`. */
export function episodeLabel(row: {
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
}): string {
  if (row.episodeNumber == null) return '';
  const season = String(row.seasonNumber ?? 0).padStart(2, '0');
  const episode = String(row.episodeNumber).padStart(2, '0');
  const code = `S${season}E${episode}`;
  return row.episodeTitle ? `${code} - ${row.episodeTitle}` : code;
}

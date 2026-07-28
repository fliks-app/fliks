/** `S01E03 — Title` for a row that targets one episode, `''` for a movie or a
 *  whole-season row. Season falls back to 0 so a linked episode never renders
 *  a bare `SE03`. */
export function episodeLabel(row: {
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
}): string {
  if (row.episodeNumber == null) return '';
  const season = String(row.seasonNumber ?? 0).padStart(2, '0');
  const episode = String(row.episodeNumber).padStart(2, '0');
  const code = `S${season}E${episode}`;
  return row.episodeTitle ? `${code} — ${row.episodeTitle}` : code;
}

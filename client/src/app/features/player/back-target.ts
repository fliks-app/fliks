export interface BackTargetInput {
  /** Page that opened the player, null on a deep link or reload. */
  origin: string | null;
  mediaId: number;
  kind: 'series' | 'movies';
  episodeId?: number;
  /** Episode whose detail page the exit lands on (the next one once this one is finished). */
  landingEpisodeId?: number;
}

/** Where leaving the player goes: the page that opened it, except from the media's own detail pages, which land on
 *  the episode to resume or watch next. */
export function backTarget(i: BackTargetInput): string {
  if (!i.mediaId) return i.origin ?? '/';
  const detail =
    i.episodeId && i.kind === 'series'
      ? `/series/${i.mediaId}/episode/${i.landingEpisodeId ?? i.episodeId}`
      : `/${i.kind}/${i.mediaId}`;
  if (!i.origin) return detail;
  const path = i.origin.split(/[?#]/)[0];
  const own = [`/movies/${i.mediaId}`, `/series/${i.mediaId}`];
  const ownDetail = own.includes(path) || path.startsWith(`/series/${i.mediaId}/episode/`);
  return ownDetail ? detail : i.origin;
}

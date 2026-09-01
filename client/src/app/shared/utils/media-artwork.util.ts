/**
 * Artwork for a feed row (continue-watching, likes, recommendations). The still
 * wins when there is one: the row points at an episode, so the series poster
 * would show the wrong thing.
 */
export function itemArtwork(item: {
  stillUrl?: string | null;
  fanartUrl?: string | null;
  posterUrl?: string | null;
}): string | null {
  return item.stillUrl ?? item.fanartUrl ?? item.posterUrl ?? null;
}

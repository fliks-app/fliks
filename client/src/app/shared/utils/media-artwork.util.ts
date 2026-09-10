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

/** Fanart URLs for a page-background pool: the primary plus every extra. */
export function fanartPool(
  items: readonly { fanartUrl?: string | null; additionalFanartUrls?: string[] | null }[],
): string[] {
  const pool: string[] = [];
  for (const item of items) {
    if (item.fanartUrl) pool.push(item.fanartUrl);
    pool.push(...(item.additionalFanartUrls ?? []));
  }
  return pool;
}

/** One fanart per title, the same on every visit. */
export function pickFanart(m: {
  id: number;
  fanartUrl?: string | null;
  additionalFanartUrls?: string[] | null;
}): string | null {
  const pool = fanartPool([m]);
  return pool.length ? pool[m.id % pool.length] : null;
}

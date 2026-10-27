import type { PartyCover, PartyItem } from '../../core/services/api/party-api.service';

/** A film shows its poster (portrait), an episode its still (landscape). */
export function itemThumb(item: PartyItem): { url: string | null; aspect: 'aspect-video' | 'aspect-2/3' } {
  return item.episodeId != null
    ? { url: item.stillUrl ?? item.fanartUrl ?? item.posterUrl, aspect: 'aspect-video' }
    : { url: item.posterUrl, aspect: 'aspect-2/3' };
}

/** The single picture of a party: the upload, else the chosen item, else the programme head. */
export function coverImage(cover: PartyCover, head: PartyItem | null): string | null {
  if (cover?.kind === 'upload') return cover.url;
  const item = cover?.kind === 'item' ? cover.item : head;
  return item ? itemThumb(item).url : null;
}

/** The posters of a mosaic cover; empty for any other kind. */
export function coverPosters(cover: PartyCover): string[] {
  return cover?.kind === 'mosaic' ? cover.items.map((i) => itemThumb(i).url).filter((u): u is string => !!u) : [];
}

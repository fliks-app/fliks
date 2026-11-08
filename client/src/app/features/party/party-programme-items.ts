import type { Media } from '../../core/services/api/media.service';
import type { TrackRow } from '../../core/services/api/music.models';
import type { PartyItem } from '../../core/services/api/party-api.service';
import { asAlbumMedia, defaultEditionId } from '../media-detail/album/album-media';

/** A row the host adds before the server describes it back. */
export type NewRow = Pick<PartyItem, 'mediaId' | 'episodeId' | 'title' | 'posterUrl'> & { itemId?: number; seriesTitle?: string };

/** The playable tracks of the album's default edition, in disc order. */
export function albumRows(media: Media | null): NewRow[] {
  const album = asAlbumMedia(media);
  if (!media || !album) return [];
  const edition = defaultEditionId(album.album);
  return album.album.tracks
    .filter((t) => t.hasFile && t.editionId === edition)
    .map((t) => ({ mediaId: media.id, episodeId: null, itemId: t.itemId, title: t.title, seriesTitle: media.title, posterUrl: media.posterUrl }));
}

export function trackRow(t: Pick<TrackRow, 'mediaId' | 'itemId' | 'title' | 'albumTitle' | 'posterUrl'>): NewRow {
  return { mediaId: t.mediaId, episodeId: null, itemId: t.itemId, title: t.title, seriesTitle: t.albumTitle, posterUrl: t.posterUrl };
}

/** What a playlist entry needs to become a row: a track names its album and item, a video its episode. */
export interface PlaylistEntryLike {
  media: { id: number; title: string; posterUrl: string | null };
  episode?: { id: number } | null;
  track?: { itemId: number; title?: string } | null;
}

export function playlistRows(entries: readonly PlaylistEntryLike[]): NewRow[] {
  return entries.map((e) =>
    e.track
      ? { mediaId: e.media.id, episodeId: null, itemId: e.track.itemId, title: e.track.title ?? e.media.title, seriesTitle: e.media.title, posterUrl: e.media.posterUrl }
      : { mediaId: e.media.id, episodeId: e.episode?.id ?? null, title: e.media.title, posterUrl: e.media.posterUrl },
  );
}

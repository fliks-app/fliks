import type { Media } from '../../../core/services/api/media.service';
import type { AlbumDetail } from '../../../core/services/api/music.models';

/** The MD of an album: `album` is absent on other kinds, and a card handoff carries the list shape without tracks. */
export type AlbumMedia = Media & { album: AlbumDetail };

export function asAlbumMedia(m: Media | null): AlbumMedia | null {
  return m?.type === 'album' && Array.isArray((m as Partial<AlbumMedia>).album?.tracks) ? (m as AlbumMedia) : null;
}

/** The edition the page opens on: the target, else the first with files, else the first. */
export function defaultEditionId(a: AlbumDetail): number | null {
  const e = a.editions;
  return (e.find((x) => x.id === a.targetEditionId) ?? e.find((x) => x.hasFiles) ?? e[0])?.id ?? null;
}

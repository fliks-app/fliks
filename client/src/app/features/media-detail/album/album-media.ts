import type { Media } from '../../../core/services/api/media.service';
import type { AlbumDetail } from '../../../core/services/api/music.models';

/** The MD of an album: `album` is absent on other kinds, and a card handoff carries the list shape without tracks. */
export type AlbumMedia = Media & { album: AlbumDetail };

export function asAlbumMedia(m: Media | null): AlbumMedia | null {
  return m?.type === 'album' && Array.isArray((m as Partial<AlbumMedia>).album?.tracks) ? (m as AlbumMedia) : null;
}

/** What tells a release from the others of its group: size, country and year ("15 tracks · CA · 2005"). */
export function versionMeta(v: { trackCount: number | null; country: string | null; releaseDate: string | null }, tracks: string): string {
  return [v.trackCount ? tracks : '', v.country, v.releaseDate?.slice(0, 4)].filter(Boolean).join(' · ');
}

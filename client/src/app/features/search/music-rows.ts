import type { Media } from '../../core/services/api/media.service';
import type { ArtistHit, HitState, RecordingHit, SearchHit } from '../../core/services/api/metadata.service';
import type { MusicPersonRow, TrackRow } from '../../core/services/api/music.models';
import { artistLine } from '../music/music-utils';

/** What the glyph of a result says: `+` add, clock asked or searching, ring downloading, alert failed, check owned. */
export type RowState = 'add' | 'pending' | 'downloading' | 'failed' | 'owned';

/** Another user's in-flight add leaves nothing to ask, except a pending one an approved-at-once add absorbs. */
export function othersBlock(h: Pick<SearchHit, 'othersRequestStatus'>, auto: boolean): boolean {
  const s = h.othersRequestStatus;
  return s === 'approved' || s === 'processing' || (s === 'pending' && !auto);
}

export function rowState(h: { state?: HitState | null; requestStatus?: string | null }, othersBlocked = false): RowState {
  if (h.state === 'owned' || h.requestStatus === 'available') return 'owned';
  if (h.state === 'downloading') return 'downloading';
  if (h.state === 'wanted') return 'pending';
  switch (h.requestStatus) {
    case 'pending':
    case 'approved':
    case 'processing':
      return 'pending';
    case 'declined':
    case 'failed':
      return 'failed';
    default:
      return othersBlocked ? 'pending' : 'add';
  }
}

/** A row or a card of the music results: a library entry or a provider hit, with its state. */
export interface MusicItem {
  key: string;
  kind: 'track' | 'album' | 'artist';
  title: string;
  subtitle: string;
  cover: string | null;
  durationSeconds: number | null;
  state: RowState;
  /** The library album holding it, when it does. */
  mediaId: number | null;
  /** The library track, when it is one. */
  itemId: number | null;
  recording?: RecordingHit;
  album?: SearchHit;
  artist?: ArtistHit;
  personId?: number | null;
}

export interface MusicSources {
  localTracks: TrackRow[];
  recordings: RecordingHit[];
  localAlbums: Media[];
  albumHits: SearchHit[];
  localArtists: MusicPersonRow[];
  artistHits: ArtistHit[];
  /** The caller's album request is approved at once. */
  autoAlbum?: boolean;
}

export interface MusicItems {
  tracks: MusicItem[];
  albums: MusicItem[];
  artists: MusicItem[];
}

const albumLine = (h: SearchHit) => [h.artists?.join(', '), h.year].filter(Boolean).join(' · ');

/** Library entries first, then the provider hits the library does not already show. */
export function musicItems(s: MusicSources): MusicItems {
  const tracks: MusicItem[] = s.localTracks.map((t) => ({
    key: `t:${t.itemId}`, kind: 'track', title: t.title, subtitle: [artistLine(t.artists), t.albumTitle].filter(Boolean).join(' · '),
    cover: t.posterUrl, durationSeconds: t.durationSeconds, state: t.hasFile ? 'owned' : 'pending', mediaId: t.mediaId, itemId: t.itemId,
  }));
  for (const r of s.recordings) {
    const shown = s.localTracks.some((t) => t.itemId === r.trackId || (t.mediaId === r.existingMediaId && t.title.toLowerCase() === r.title.toLowerCase()));
    if (shown) continue;
    tracks.push({
      key: `r:${r.provider}:${r.externalId}`, kind: 'track', title: r.title, subtitle: [r.artists.join(', '), r.album.title].filter(Boolean).join(' · '),
      cover: r.album.posterUrl, durationSeconds: r.durationMs ? r.durationMs / 1000 : null, state: rowState(r), mediaId: r.existingMediaId, itemId: r.trackId, recording: r,
    });
  }

  const albums: MusicItem[] = s.localAlbums.map((m) => ({
    key: `m:${m.id}`, kind: 'album', title: m.title, subtitle: m.year ? String(m.year) : '', cover: m.posterUrl, durationSeconds: null, state: 'owned', mediaId: m.id, itemId: null,
  }));
  const held = new Set(s.localAlbums.map((m) => m.id));
  for (const h of s.albumHits) {
    if (h.existingMediaId != null && held.has(h.existingMediaId)) continue;
    albums.push({ key: `a:${h.provider}:${h.externalId}`, kind: 'album', title: h.title, subtitle: albumLine(h), cover: h.posterUrl, durationSeconds: null, state: rowState(h, othersBlock(h, !!s.autoAlbum)), mediaId: h.existingMediaId, itemId: null, album: h });
  }

  const localIds = new Set(s.localArtists.map((a) => a.id));
  const artists: MusicItem[] = s.localArtists.map((a) => ({
    key: `p:${a.id}`, kind: 'artist', title: a.name, subtitle: '', cover: a.avatarUrl ?? null, durationSeconds: null, state: 'owned', mediaId: null, itemId: null, personId: a.id,
  }));
  for (const a of s.artistHits) {
    if (a.personId != null && localIds.has(a.personId)) continue;
    artists.push({ key: `x:${a.provider}:${a.externalId}`, kind: 'artist', title: a.name, subtitle: a.disambiguation ?? '', cover: null, durationSeconds: null, state: 'owned', mediaId: null, itemId: null, personId: a.personId, artist: a });
  }
  return { tracks, albums, artists };
}

/** The artist named like the query, else the album titled like it, else the first track. */
export function topResult(q: string, items: MusicItems): MusicItem | null {
  const same = (i: MusicItem) => i.title.trim().toLowerCase() === q.trim().toLowerCase();
  return items.artists.find(same) ?? items.albums.find(same) ?? items.tracks[0] ?? null;
}

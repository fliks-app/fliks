import type { MusicTrackRequest } from '../../core/services/audio-player/music-queue';
import type { ArtistAlbum, Track, TrackArtist, TrackRow, TrackWork } from '../../core/services/api/music.models';

/** `m:ss`, or `h:mm:ss` from an hour up. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The credited names with their join phrases ("A & B"); a missing phrase between two names is a comma. */
export function artistLine(artists: Pick<TrackArtist, 'name' | 'creditedName' | 'joinPhrase'>[]): string {
  return artists
    .map((a, i) => (a.creditedName ?? a.name) + (i < artists.length - 1 ? (a.joinPhrase ?? ', ') : ''))
    .join('');
}

export interface Disc {
  discNumber: number;
  title: string | null;
  tracks: Track[];
}

/** Tracks of one edition by disc; the input is already ordered by disc and position. */
export function groupDiscs(tracks: Track[]): Disc[] {
  const discs: Disc[] = [];
  for (const t of tracks) {
    let d = discs.find((x) => x.discNumber === t.discNumber);
    if (!d) discs.push((d = { discNumber: t.discNumber, title: t.discTitle, tracks: [] }));
    d.tracks.push(t);
  }
  return discs;
}

export interface WorkSection {
  work: TrackWork | null;
  tracks: Track[];
}

/** Consecutive tracks sharing their first work go under it; the others stay alone. */
export function groupByWork(tracks: Track[]): WorkSection[] {
  const out: WorkSection[] = [];
  for (const t of tracks) {
    const work = [...t.works].sort((a, b) => a.position - b.position)[0] ?? null;
    const last = out[out.length - 1];
    if (last && last.work && work && last.work.workId === work.workId) last.tracks.push(t);
    else out.push({ work, tracks: [t] });
  }
  return out;
}

export interface AlbumFacts {
  mediaId: number;
  title: string;
  coverUrl: string | null;
  artists: string;
  albumGain: number | null;
  albumPeak: number | null;
}

export function toTrackRequest(t: Track, a: AlbumFacts): MusicTrackRequest {
  return {
    itemId: t.itemId,
    mediaId: a.mediaId,
    title: t.title,
    artists: t.artists.length ? artistLine(t.artists) : a.artists,
    albumTitle: a.title,
    coverUrl: a.coverUrl,
    durationSeconds: t.durationSeconds,
    gain: t.gain,
    peak: t.peak,
    albumGain: a.albumGain,
    albumPeak: a.albumPeak,
  };
}

/** A track of `GET /api/tracks`, which names its album: no album gain, so the track's own applies. */
export function trackRowRequest(t: TrackRow): MusicTrackRequest {
  return {
    itemId: t.itemId,
    mediaId: t.mediaId,
    title: t.title,
    artists: artistLine(t.artists),
    albumTitle: t.albumTitle,
    coverUrl: t.posterUrl,
    durationSeconds: t.durationSeconds,
    gain: t.gain,
    peak: t.peak,
    albumGain: null,
    albumPeak: null,
  };
}

export type DiscographyTab = 'albums' | 'singles' | 'compilations' | 'other';
export const DISCOGRAPHY_TABS: readonly DiscographyTab[] = ['albums', 'singles', 'compilations', 'other'];

/** Albums holds studio albums only: live, remix, soundtrack and the like go to `other`. */
export function discographyTab(a: Pick<ArtistAlbum, 'primaryType' | 'secondaryTypes'>): DiscographyTab {
  const secondary = a.secondaryTypes.map((s) => s.toLowerCase());
  if (secondary.includes('compilation')) return 'compilations';
  const p = a.primaryType?.toLowerCase();
  if (p === 'ep' || p === 'single') return 'singles';
  return p === 'album' && !secondary.length ? 'albums' : 'other';
}

/** The albums by tab, owned and missing together: those holding a popular track first, in its order, then newest first. */
export function discographyTabs(albums: ArtistAlbum[], popular: { albumExternalId?: string | null }[] = []): Record<DiscographyTab, ArtistAlbum[]> {
  const out: Record<DiscographyTab, ArtistAlbum[]> = { albums: [], singles: [], compilations: [], other: [] };
  for (const a of albums) out[discographyTab(a)].push(a);
  const rank = new Map<string, number>();
  popular.forEach((p, i) => p.albumExternalId && !rank.has(p.albumExternalId) && rank.set(p.albumExternalId, i));
  const rankOf = (a: ArtistAlbum) => (a.externalId != null ? (rank.get(a.externalId) ?? Infinity) : Infinity);
  // Infinity - Infinity is NaN, which falls through to the year like a tie.
  const order = (a: ArtistAlbum, b: ArtistAlbum) =>
    rankOf(a) - rankOf(b) || (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title);
  for (const k of DISCOGRAPHY_TABS) out[k].sort(order);
  return out;
}

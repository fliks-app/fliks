import type { MusicTrackRequest } from '../../core/services/audio-player/music-queue';
import type { ArtistAlbum, Track, TrackArtist, TrackWork } from '../../core/services/api/music.models';

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

/** Clicking the current star clears the rating. */
export function nextRating(current: number | null, clicked: number): number | null {
  return current === clicked ? null : clicked;
}

export type ReleaseGroup = 'album' | 'ep' | 'single' | 'compilation' | 'live' | 'other';
export const RELEASE_GROUPS: readonly ReleaseGroup[] = ['album', 'ep', 'single', 'compilation', 'live', 'other'];

export function releaseGroup(a: Pick<ArtistAlbum, 'primaryType' | 'secondaryTypes'>): ReleaseGroup {
  const sec = a.secondaryTypes.map((s) => s.toLowerCase());
  if (sec.includes('compilation')) return 'compilation';
  if (sec.includes('live')) return 'live';
  const p = a.primaryType?.toLowerCase();
  return p === 'album' || p === 'ep' || p === 'single' ? p : 'other';
}

export interface DiscographyGroups {
  groups: { key: ReleaseGroup; albums: ArtistAlbum[] }[];
  missing: ArtistAlbum[];
}

const byYear = (a: ArtistAlbum, b: ArtistAlbum) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title);

/** Owned albums by release type, oldest first; the albums not in the library are one Missing group. */
export function groupDiscography(albums: ArtistAlbum[]): DiscographyGroups {
  const owned = albums.filter((a) => a.owned);
  return {
    groups: RELEASE_GROUPS.map((key) => ({ key, albums: owned.filter((a) => releaseGroup(a) === key).sort(byYear) })).filter(
      (g) => g.albums.length,
    ),
    missing: albums.filter((a) => !a.owned).sort(byYear),
  };
}

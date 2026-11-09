import type { DownloadTask } from '../../core/services/download-cache.service';

export interface SeasonGroup<T extends DownloadTask = DownloadTask> {
  /** Null for episodes whose season could not be determined. */
  seasonNumber: number | null;
  tasks: T[];
  sizeBytes: number;
}

export interface ShowGroup<T extends DownloadTask = DownloadTask> {
  mediaId: number;
  title: string;
  posterUrl: string | null;
  seasons: SeasonGroup<T>[];
  tasks: T[];
  sizeBytes: number;
}

/** The tracks of one album kept on the device, in the order they were started. */
export interface AlbumGroup<T extends DownloadTask = DownloadTask> {
  mediaId: number;
  title: string;
  posterUrl: string | null;
  tasks: T[];
  sizeBytes: number;
}

export type DownloadEntry<T extends DownloadTask = DownloadTask> =
  | { kind: 'movie'; task: T }
  | { kind: 'show'; show: ShowGroup<T> }
  | { kind: 'album'; album: AlbumGroup<T> };

export function entryKey(e: DownloadEntry): string {
  // eslint-disable-next-line no-restricted-syntax -- DownloadEntry.kind is a grouping tag, not a MediaType
  return e.kind === 'movie' ? `m${e.task.id}` : e.kind === 'show' ? `s${e.show.mediaId}` : `a${e.album.mediaId}`;
}

/** Reads `S01E02 Title` labels saved before the numbers were stored. */
export function parseEpisodeLabel(label?: string): { season: number; episode: number } | null {
  const m = /^S(\d+)E(\d+)/i.exec(label ?? '');
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

const numbers = (t: DownloadTask) => {
  const parsed = parseEpisodeLabel(t.episodeLabel);
  return { season: t.seasonNumber ?? parsed?.season ?? null, episode: t.episodeNumber ?? parsed?.episode ?? null };
};

const sum = (tasks: DownloadTask[]) => tasks.reduce((n, t) => n + (t.sizeBytes ?? 0), 0);

/** Movies stay single entries; episodes group by series then season, sorted numerically; entries oldest first, so the latest download ends the list. */
export function groupDownloads<T extends DownloadTask>(tasks: T[]): DownloadEntry<T>[] {
  const entries: DownloadEntry<T>[] = [];
  const shows = new Map<number, T[]>();
  const albums = new Map<number, T[]>();
  for (const t of tasks) {
    if (t.book?.track) {
      albums.set(t.mediaId, [...(albums.get(t.mediaId) ?? []), t]);
    } else if (t.episodeId == null && !t.episodeLabel) {
      entries.push({ kind: 'movie', task: t });
    } else {
      shows.set(t.mediaId, [...(shows.get(t.mediaId) ?? []), t]);
    }
  }
  for (const [mediaId, list] of shows) {
    const bySeason = new Map<number | null, T[]>();
    for (const t of list) {
      const s = numbers(t).season;
      bySeason.set(s, [...(bySeason.get(s) ?? []), t]);
    }
    const seasons = [...bySeason]
      .map(([seasonNumber, st]) => ({
        seasonNumber,
        tasks: st.sort((a, b) => (numbers(a).episode ?? Infinity) - (numbers(b).episode ?? Infinity) || a.id - b.id),
        sizeBytes: sum(st),
      }))
      .sort((a, b) => (a.seasonNumber ?? Infinity) - (b.seasonNumber ?? Infinity));
    entries.push({
      kind: 'show',
      show: {
        mediaId,
        title: list[0].media?.title ?? '',
        posterUrl: list[0].media?.posterUrl ?? null,
        seasons,
        tasks: seasons.flatMap((s) => s.tasks),
        sizeBytes: sum(list),
      },
    });
  }
  for (const [mediaId, list] of albums) {
    entries.push({
      kind: 'album',
      album: { mediaId, title: list[0].media?.title ?? '', posterUrl: list[0].media?.posterUrl ?? null, tasks: list, sizeBytes: sum(list) },
    });
  }
  // Local ids come from Date.now(), so they stand in for a missing createdAt.
  const at = (t: DownloadTask) => Date.parse(t.createdAt) || t.id;
  const members = (e: DownloadEntry<T>) =>
    // eslint-disable-next-line no-restricted-syntax -- DownloadEntry.kind is a grouping tag, not a MediaType
    e.kind === 'movie' ? [e.task] : e.kind === 'show' ? e.show.tasks : e.album.tasks;
  const latest = (e: DownloadEntry<T>) => Math.max(...members(e).map(at));
  return entries.sort((a, b) => latest(a) - latest(b));
}

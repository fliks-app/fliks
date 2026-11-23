import type { Episode, Media, Season } from '../../core/services/api/media.service';
import type { MediaResumeInfo } from '../../core/services/api/streaming-api.service';
import { QueueItem } from '../../core/services/playback-queue.service';
import { kindOf } from '../../core/media-kinds';

/** One entry of {@link Media.files}. */
export type MediaFile = NonNullable<Media['files']>[number];

/** Resolve the playable file: the episode's when `episodeId` is given, otherwise the movie's own; null when none matches. */
export function resolvePlayableFile(
  m: Media,
  episodeId?: number,
): MediaFile | null {
  const files = m.files ?? [];
  if (!files.length) return null;
  if (episodeId != null) {
    return files.find((f) => f.episodeId === episodeId) ?? null;
  }
  return files.find((f) => f.episodeId == null) ?? files[0] ?? null;
}

/** The series' episodes as queue items in S/E order, excluding specials and episodes with no available file; empty for non-series. */
export function buildSeriesQueueItems(m: Media): QueueItem[] {
  if (!kindOf(m.type).hasSeasons || !m.seasons?.length) return [];
  const flat: {
    seasonNumber: number;
    episodeNumber: number;
    id: number;
    title?: string | null;
    stillUrl?: string | null;
  }[] = [];
  for (const s of m.seasons) {
    if ((s.seasonNumber ?? 0) <= 0) continue;
    for (const ep of s.episodes ?? []) {
      flat.push({
        seasonNumber: s.seasonNumber,
        episodeNumber: ep.episodeNumber ?? 0,
        id: ep.id,
        title: ep.title,
        stillUrl: ep.stillUrl,
      });
    }
  }
  flat.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  const items: QueueItem[] = [];
  for (const e of flat) {
    const file = (m.files ?? []).find((f) => f.episodeId === e.id);
    if (!file) continue;
    items.push({
      mediaId: m.id,
      episodeId: e.id,
      mediaFileId: file.id,
      title: m.title,
      episodeTitle: `S${e.seasonNumber}:E${e.episodeNumber}${e.title ? ` - ${e.title}` : ''}`,
      fanartUrl: m.fanartUrl,
      stillUrl: e.stillUrl ?? null,
    });
  }
  return items;
}

/** The item after `episodeId` in {@link buildSeriesQueueItems}, or null on the
 *  last episode (or when the episode itself isn't in the list). */
export function resolveNextEpisodeItem(m: Media, episodeId: number): QueueItem | null {
  const items = buildSeriesQueueItems(m);
  const idx = items.findIndex((it) => it.episodeId === episodeId);
  return idx < 0 ? null : (items[idx + 1] ?? null);
}

/** The episode's header label, "S1:E2 - title", or null when the media has no such episode. */
export function episodeLabel(m: Pick<Media, 'seasons'>, episodeId: number): string | null {
  for (const season of m.seasons ?? []) {
    const ep = season.episodes?.find((e) => e.id === episodeId);
    if (ep) return `S${season.seasonNumber}:E${ep.episodeNumber}${ep.title ? ` - ${ep.title}` : ''}`;
  }
  return null;
}

/** Files explicitly linked to this episode (episodeId). */
export function filesForEpisode(files: Media['files'], episodeId: number): MediaFile[] {
  return (files ?? []).filter((f) => f.episodeId != null && Number(f.episodeId) === episodeId);
}

/** The episode a series' Play launches, with its season and the file to open. */
export interface NextUp {
  episode: Episode;
  season: Season;
  file: { id: number };
}

/** The resume target, else the first unwatched episode with a file, else the first one with a file (all watched); null with no episode on disk.
 *  Specials (seasonNumber <= 0) are skipped. */
export function nextUp(m: Media, resume: MediaResumeInfo | null, watched: ReadonlySet<number>): NextUp | null {
  if (!kindOf(m.type).hasSeasons || !m.seasons?.length) return null;
  const seasons = [...m.seasons]
    .filter((s) => (s.seasonNumber ?? 0) > 0)
    .sort((a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0));
  const inOrder = (s: Season) => [...(s.episodes ?? [])].sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
  const fileOf = (epId: number) => filesForEpisode(m.files, epId)[0] ?? null;

  if (resume?.episodeId) {
    for (const s of seasons) {
      const ep = s.episodes?.find((e) => e.id === resume.episodeId);
      if (ep) {
        const file = resume.mediaFileId ? { id: resume.mediaFileId } : fileOf(ep.id);
        if (file) return { episode: ep, season: s, file };
      }
    }
  }
  for (const skipWatched of [true, false]) {
    for (const s of seasons) {
      for (const ep of inOrder(s)) {
        if (!ep.hasFile || (skipWatched && watched.has(ep.id))) continue;
        const file = fileOf(ep.id);
        if (file) return { episode: ep, season: s, file };
      }
    }
  }
  return null;
}

/** "S02E07", the compact code of an episode. */
export function episodeCode(n: Pick<NextUp, 'episode' | 'season'>): string {
  return `S${String(n.season.seasonNumber).padStart(2, '0')}E${String(n.episode.episodeNumber).padStart(2, '0')}`;
}

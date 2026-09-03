import { Media } from '../../core/services/api/media.service';
import { QueueItem } from '../../core/services/playback-queue.service';

/** One entry of {@link Media.files}. */
export type MediaFile = NonNullable<Media['files']>[number];

/**
 * Resolve the playable file from loaded media: the file for a specific episode
 * when `episodeId` is given (series episodes carry `episodeId`), otherwise the
 * movie's own file. Returns null when the media has no matching file.
 */
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

/**
 * The series' episodes as queue items in S/E order — specials excluded, and
 * episodes with no available file dropped (they aren't playable). Empty for
 * anything that isn't a loaded series.
 */
export function buildSeriesQueueItems(m: Media): QueueItem[] {
  if (m.type !== 'series' || !m.seasons?.length) return [];
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

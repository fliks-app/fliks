import { asBookMedia } from '../../core/services/api/book-media';
import type { Media } from '../../core/services/api/media.service';
import { asAlbumMedia } from './album/album-media';
import { asComicMedia } from './comic/comic-media';

/** Whether the library still waits for a file of this title: the automatic search has something to report. */
export function isWanted(m: Media): boolean {
  if (!m.monitored) return false;
  switch (m.type) {
    case 'movie':
      return !m.files?.length;
    case 'series':
      return !!m.episodeStats && m.episodeStats.downloadedEpisodes < m.episodeStats.totalEpisodes;
    case 'album':
      return !!asAlbumMedia(m)?.album.tracks.some((t) => t.monitored && !t.hasFile);
    case 'book':
      return !!asBookMedia(m)?.book.editions.every((e) => !e.hasFile);
    case 'comic':
      return !!asComicMedia(m)?.comic.issues.every((i) => i.mediaFileId == null);
  }
}

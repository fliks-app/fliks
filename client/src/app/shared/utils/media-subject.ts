import { mediaDetailLink } from '../../core/media-kinds';
import type { MediaProgressSubject } from '../../core/services/sse.service';

/** "S01E03 · Episode title", "S01" for a whole season, empty without a season. */
export function subjectEpisodeLine(subject: MediaProgressSubject): string {
  if (subject.seasonNumber == null) return '';
  const season = `S${String(subject.seasonNumber).padStart(2, '0')}`;
  const code = subject.episodeNumber != null
    ? `${season}E${String(subject.episodeNumber).padStart(2, '0')}`
    : season;
  return subject.episodeTitle ? `${code} · ${subject.episodeTitle}` : code;
}

/** `null` without a media id: the title then renders as plain text. */
export function subjectMediaLink(subject: MediaProgressSubject): unknown[] | null {
  if (subject.mediaId == null) return null;
  return mediaDetailLink(subject.mediaType ?? 'movie', subject.mediaId);
}

export function subjectEpisodeLink(subject: MediaProgressSubject): unknown[] | null {
  if (subject.mediaId == null || subject.episodeId == null) return null;
  return ['/series', subject.mediaId, 'episode', subject.episodeId];
}

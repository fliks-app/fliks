/**
 * Structured subject for a `task.progress` event driven by one media: lets the client
 * show the series/movie title and episode identity as separate fields instead of parsing
 * a flattened string. `seasonNumber` alone (no `episodeNumber`) describes a whole-season
 * task (marker detection); both together describe a single episode.
 *
 * `mediaId`/`mediaType`/`episodeId` are optional: a producer without the id cheaply in
 * hand (no extra query) omits it, and the client renders that row's media as plain text.
 */
export interface MediaProgressSubject {
  title: string;
  mediaId?: number;
  mediaType?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  episodeId?: number;
}

/** Build a progress subject from a media and, optionally, a season/episode it applies to. */
export function buildMediaProgressSubject(
  media: { id?: number; title: string; type?: string },
  episode?: {
    id?: number | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    title?: string | null;
  } | null,
): MediaProgressSubject {
  const base: MediaProgressSubject = {
    title: media.title,
    mediaId: media.id,
    mediaType: media.type,
  };
  if (!episode || episode.seasonNumber == null) {
    return base;
  }
  return {
    ...base,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber ?? undefined,
    episodeTitle:
      episode.episodeNumber != null ? (episode.title ?? undefined) : undefined,
    episodeId:
      episode.episodeNumber != null ? (episode.id ?? undefined) : undefined,
  };
}

/** Flat fallback for the plain-text `message` field and log lines. */
export function formatMediaProgressSubject(subject: MediaProgressSubject): string {
  if (subject.seasonNumber == null) return subject.title;
  const season = `S${String(subject.seasonNumber).padStart(2, '0')}`;
  if (subject.episodeNumber == null) return `${subject.title} ${season}`;
  const code = `${season}E${String(subject.episodeNumber).padStart(2, '0')}`;
  return subject.episodeTitle
    ? `${subject.title} ${code}: ${subject.episodeTitle}`
    : `${subject.title} ${code}`;
}

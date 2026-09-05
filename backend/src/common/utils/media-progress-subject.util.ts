/**
 * Structured subject for a `task.progress` event driven by one media: lets the client
 * show the series/movie title and episode identity as separate fields instead of parsing
 * a flattened string. `seasonNumber` alone (no `episodeNumber`) describes a whole-season
 * task (marker detection); both together describe a single episode.
 */
export interface MediaProgressSubject {
  title: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
}

/** Build a progress subject from a media and, optionally, a season/episode it applies to. */
export function buildMediaProgressSubject(
  media: { title: string },
  episode?: {
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    title?: string | null;
  } | null,
): MediaProgressSubject {
  if (!episode || episode.seasonNumber == null) {
    return { title: media.title };
  }
  return {
    title: media.title,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber ?? undefined,
    episodeTitle:
      episode.episodeNumber != null ? (episode.title ?? undefined) : undefined,
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

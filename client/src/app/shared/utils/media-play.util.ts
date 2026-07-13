import { Media } from '../../core/services/api/media.service';

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

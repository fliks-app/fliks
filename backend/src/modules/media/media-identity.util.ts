import { Media } from './entities/media.entity';

/** True when at least one metadata-provider id is set; false for a title built from the file alone. */
export function hasProviderId(
  m: Pick<Media, 'tmdbId' | 'tvdbId' | 'imdbId'>,
): boolean {
  return m.tmdbId != null || m.tvdbId != null || !!m.imdbId;
}

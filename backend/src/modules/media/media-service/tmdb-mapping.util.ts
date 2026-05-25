import { Media } from '../entities/media.entity';
import { MetadataDetails } from '../../metadata-providers/interfaces/metadata-provider.interface';
import { MediaType, MediaStatus } from '../../../common/enums';

export function mapTmdbStatusToMediaStatus(
  type: MediaType,
  status: string,
): MediaStatus {
  const s = (status || '').toLowerCase();
  if (type === MediaType.MOVIE) {
    const m: Record<string, MediaStatus> = {
      released: MediaStatus.RELEASED,
      rumored: MediaStatus.TBA,
      rumor: MediaStatus.TBA,
      planned: MediaStatus.ANNOUNCED,
      'in production': MediaStatus.ANNOUNCED,
      'post production': MediaStatus.ANNOUNCED,
      canceled: MediaStatus.ENDED,
      cancelled: MediaStatus.ENDED,
    };
    return m[s] ?? MediaStatus.TBA;
  }
  const m: Record<string, MediaStatus> = {
    continuing: MediaStatus.CONTINUING,
    ended: MediaStatus.ENDED,
    announced: MediaStatus.ANNOUNCED,
    tba: MediaStatus.TBA,
    unknown: MediaStatus.TBA,
  };
  return m[s] ?? MediaStatus.TBA;
}

export function buildMediaFieldsFromTmdb(
  details: MetadataDetails,
  type: MediaType,
): Partial<Media> {
  const year =
    details.year != null && Number.isFinite(details.year)
      ? details.year
      : undefined;
  return {
    title: details.title,
    originalTitle: details.originalTitle ?? details.title,
    alternativeTitles: details.alternativeTitles ?? [],
    year,
    type,
    tmdbId: details.tmdbId || undefined,
    tvdbId: details.tvdbId ?? undefined,
    imdbId: details.imdbId ?? undefined,
    overview: details.overview ?? undefined,
    status: mapTmdbStatusToMediaStatus(type, details.status),
    posterUrl: details.posterUrl ?? undefined,
    fanartUrl: details.fanartUrl ?? undefined,
    rating: details.rating ?? undefined,
    genres: details.genres?.length ? details.genres : [],
    runtime: details.runtime ?? undefined,
    releaseDate: details.releaseDate
      ? details.releaseDate.slice(0, 10)
      : undefined,
    inCinemas: details.inCinemas ? details.inCinemas.slice(0, 10) : undefined,
    digitalRelease: details.digitalRelease
      ? details.digitalRelease.slice(0, 10)
      : undefined,
    physicalRelease: details.physicalRelease
      ? details.physicalRelease.slice(0, 10)
      : undefined,
    tmdbCollectionId: details.tmdbCollectionId ?? null,
    tmdbCollectionName: details.tmdbCollectionName ?? null,
  };
}

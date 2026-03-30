import { CreateQualityProfileDto } from './dto/create-quality-profile.dto';
import {
  DEFAULT_MOVIE_QUALITY_PROFILE_NAME,
  SUITARR_QUALITIES,
} from '../../common/constants/suitarr-qualities';

/** Default profile: 720p–1080p web/bluray allowed, cutoff WEBDL-1080p (id 16). */
export function buildDefaultMovieQualityProfileDto(): CreateQualityProfileDto {
  const allowedIds = new Set([
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  ]);
  const items = SUITARR_QUALITIES.map((q, index) => ({
    qualityId: q.id,
    qualityName: q.name,
    resolution: q.resolution,
    source: q.source,
    allowed: allowedIds.has(q.id),
    sortOrder: index,
  }));
  return {
    name: DEFAULT_MOVIE_QUALITY_PROFILE_NAME,
    cutoff: 16,
    upgradeAllowed: true,
    items,
  };
}

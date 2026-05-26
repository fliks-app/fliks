/** Quality definitions for release parsing and profiles. */

export interface AppQualityDefinition {
  id: number;
  name: string;
  resolution: number;
  source: string;
  /** Higher = better; used to pick the best allowed release. */
  rank: number;
}

export const APP_QUALITIES: AppQualityDefinition[] = [
  { id: 1, name: 'WORKPRINT', resolution: 0, source: 'workprint', rank: 5 },
  { id: 2, name: 'CAM', resolution: 0, source: 'cam', rank: 8 },
  { id: 3, name: 'TELESYNC', resolution: 0, source: 'telesync', rank: 10 },
  { id: 4, name: 'TELECINE', resolution: 0, source: 'telecine', rank: 12 },
  { id: 5, name: 'DVD', resolution: 480, source: 'dvd', rank: 18 },
  { id: 6, name: 'DVD-R', resolution: 480, source: 'dvd', rank: 20 },
  { id: 7, name: 'SDTV', resolution: 480, source: 'sdtv', rank: 22 },
  { id: 8, name: 'WEBDL-480p', resolution: 480, source: 'web', rank: 28 },
  { id: 9, name: 'WEBRip-480p', resolution: 480, source: 'web', rank: 28 },
  { id: 10, name: 'Bluray-480p', resolution: 480, source: 'bluray', rank: 30 },
  { id: 11, name: 'HDTV-720p', resolution: 720, source: 'hdtv', rank: 40 },
  { id: 12, name: 'WEBDL-720p', resolution: 720, source: 'web', rank: 45 },
  { id: 13, name: 'WEBRip-720p', resolution: 720, source: 'web', rank: 45 },
  { id: 14, name: 'Bluray-720p', resolution: 720, source: 'bluray', rank: 50 },
  { id: 15, name: 'HDTV-1080p', resolution: 1080, source: 'hdtv', rank: 55 },
  { id: 16, name: 'WEBDL-1080p', resolution: 1080, source: 'web', rank: 62 },
  { id: 17, name: 'WEBRip-1080p', resolution: 1080, source: 'web', rank: 60 },
  {
    id: 18,
    name: 'Bluray-1080p',
    resolution: 1080,
    source: 'bluray',
    rank: 68,
  },
  { id: 19, name: 'Remux-1080p', resolution: 1080, source: 'remux', rank: 72 },
  { id: 20, name: 'HDTV-2160p', resolution: 2160, source: 'hdtv', rank: 75 },
  { id: 21, name: 'WEBDL-2160p', resolution: 2160, source: 'web', rank: 82 },
  { id: 22, name: 'WEBRip-2160p', resolution: 2160, source: 'web', rank: 80 },
  {
    id: 23,
    name: 'Bluray-2160p',
    resolution: 2160,
    source: 'bluray',
    rank: 88,
  },
  { id: 24, name: 'Remux-2160p', resolution: 2160, source: 'remux', rank: 95 },
];

const byId = new Map(APP_QUALITIES.map((q) => [q.id, q]));

export function getAppQualityById(
  id: number,
): AppQualityDefinition | undefined {
  return byId.get(id);
}

/**
 * Highest rank among a set of allowed quality IDs. Used to drop search
 * results that overshoot the profile's reach — e.g. 2160p hits for a
 * 1080p-only profile. Returns 0 when no IDs resolve to a known quality;
 * callers should treat that as "nothing allowed" rather than "everything
 * allowed".
 */
export function maxAllowedRank(allowed: Set<number>): number {
  let max = 0;
  for (const id of allowed) {
    const rank = byId.get(id)?.rank ?? 0;
    if (rank > max) max = rank;
  }
  return max;
}

export const DEFAULT_MOVIE_QUALITY_PROFILE_NAME = 'HD-1080p (défaut)';

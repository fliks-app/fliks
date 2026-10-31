import { Media } from '../../core/services/api/media.service';
import { BarStatus } from '../components/media-card/media-card';
import { KIND_REGISTRY } from '../../core/media-kinds';

/** Compute the status bar state for a media item. */
export function computeMediaBarStatus(m: Media): BarStatus {
  const hasFiles = KIND_REGISTRY[m.type].hasSeasons
    ? (m.episodeStats?.downloadedEpisodes ?? 0) > 0
    : (m.files?.length ?? 0) > 0;
  const isReleased = isMediaReleased(m);

  if (hasFiles && m.monitored) return 'downloaded-monitored';
  if (hasFiles && !m.monitored) return 'downloaded-unmonitored';
  if (!isReleased) return 'unreleased';
  if (m.monitored) return 'missing-monitored';
  return 'missing-unmonitored';
}


function isMediaReleased(m: Media): boolean {
  if (KIND_REGISTRY[m.type].hasSeasons) {
    return m.status === 'continuing' || m.status === 'ended';
  }
  const now = new Date();
  const dates = [m.releaseDate, m.inCinemas, m.digitalRelease, m.physicalRelease];
  return dates.some((d) => d && new Date(d) <= now);
}

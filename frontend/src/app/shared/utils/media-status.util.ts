import { Media } from '../../core/services/api/media.service';
import { BarStatus } from '../components/media-card/media-card';

/** Compute the status bar state for a media item. */
export function computeMediaBarStatus(m: Media): BarStatus {
  const hasFiles = m.type === 'series'
    ? (m.episodeStats?.downloadedEpisodes ?? 0) > 0
    : (m.files?.length ?? 0) > 0;
  const isReleased = isMediaReleased(m);

  if (hasFiles && m.monitored) return 'downloaded-monitored';
  if (hasFiles && !m.monitored) return 'downloaded-unmonitored';
  if (!isReleased) return 'unreleased';
  if (m.monitored) return 'missing-monitored';
  return 'missing-unmonitored';
}

/** Compute the bar fill percentage for a media item. */
export function computeMediaBarPercent(m: Media): number {
  if (m.type === 'series' && m.episodeStats) {
    const { totalEpisodes, downloadedEpisodes } = m.episodeStats;
    return totalEpisodes > 0 ? (downloadedEpisodes / totalEpisodes) * 100 : 0;
  }
  return 100;
}

function isMediaReleased(m: Media): boolean {
  if (m.type === 'series') {
    return m.status === 'continuing' || m.status === 'ended';
  }
  const now = new Date();
  const dates = [m.releaseDate, m.inCinemas, m.digitalRelease, m.physicalRelease];
  return dates.some((d) => d && new Date(d) <= now);
}

/**
 * Aggregated stats payload for the admin user-detail "Statistics" tab.
 * Composed in UsersStatsService from PlaybackState, FliksRequest and
 * PairingRequest queries (all per-userId, indexed).
 */
export interface UserStatsDto {
  playback: {
    /** Sum of positionSeconds across rows where playedAt IS NOT NULL — the
     *  honest "time the user actually watched", excluding manual marks. */
    totalWatchTimeSeconds: number;
    moviesWatched: number;
    seriesStarted: number;
    episodesWatched: number;
    lastPlayedAt: string | null;
  };
  requests: {
    pending: number;
    approved: number;
    declined: number;
    quotaPeriodDays: number;
    movieQuotaLimit: number;
    seriesQuotaLimit: number;
    moviesInPeriod: number;
    seriesInPeriod: number;
  };
  activity: {
    lastActiveAt: string | null;
    memberSince: string;
  };
  devices: {
    count: number;
    items: { deviceId: string; deviceName: string; pairedAt: string }[];
  };
}

/**
 * Aggregated stats payload for the admin user-detail "Statistics" tab.
 * Composed in UsersStatsService from PlaybackState and FliksRequest queries
 * (per-userId, indexed). No "active devices" card — the pairing system is
 * an ephemeral handshake (rows TTL'd at 20 min), not a session registry,
 * so it can't surface a meaningful device list.
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
  };
  activity: {
    lastActiveAt: string | null;
    memberSince: string;
  };
}

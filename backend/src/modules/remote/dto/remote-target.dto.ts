export interface RemoteNowPlayingDto {
  mediaFileId: number;
  mediaTitle: string | null;
  mediaType: string | null;
  posterUrl: string | null;
  positionSeconds: number;
  state: 'playing' | 'paused' | 'buffering';
}

/** One remote-controllable device: the caller's own, or a household member's
 *  device the caller is authorized to control (see `RemoteService.canControl`). */
export interface RemoteTargetDto {
  targetId: string;
  userAgent: string | null;
  systemName: string | null;
  formFactor: string | null;
  tvPlatform: string | null;
  /** Set only on a household-visible row; null for the caller's own devices. */
  ownerUsername: string | null;
  nowPlaying: RemoteNowPlayingDto | null;
}

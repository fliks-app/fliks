/**
 * Session map key for a transcode job. A single `(file, user)` pair can
 * carry multiple concurrent sessions, one per {@link profileHash}
 * (different devices producing byte-incompatible streams from the same
 * source). The hash segment makes those entries live as siblings in the
 * `sessions` map without colliding, and matches the on-disk cache
 * layout owned by `TranscodeCacheService`.
 */
export function sessionKey(
  mediaFileId: number,
  userId: number | undefined,
  profileHash: string,
): string {
  const userSeg = userId != null ? `u${userId}` : 'anon';
  return `${mediaFileId}-${userSeg}-${profileHash}`;
}

/** Audio-only HLS session, one per (file, user, profile, audioIndex). */
export function audioSessionKey(
  mediaFileId: number,
  audioIndex: number,
  userId: number | undefined,
  profileHash: string,
): string {
  return `${sessionKey(mediaFileId, userId, profileHash)}-a${audioIndex}`;
}

/** Short-lived parallel ffmpeg producing seg-0..seg-1 during mid-file
 *  resume. Shares the profile of the main session but lives in its own
 *  map entry so the main session's startSegment doesn't trip over the
 *  early process writing the beginning of the file. */
export function earlySessionKey(
  mediaFileId: number,
  userId: number | undefined,
  profileHash: string,
): string {
  return `${sessionKey(mediaFileId, userId, profileHash)}-early`;
}

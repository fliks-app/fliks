/** Build the session map key: one transcode per user per file. */
export function sessionKey(mediaFileId: number, userId?: number): string {
  return userId != null ? `${mediaFileId}-u${userId}` : `${mediaFileId}-anon`;
}

/** Build audio session key: separate audio-only session per audio track index. */
export function audioSessionKey(
  mediaFileId: number,
  audioIndex: number,
  userId?: number,
): string {
  return `${sessionKey(mediaFileId, userId)}-a${audioIndex}`;
}

/** Build early-segment session key: short-lived parallel ffmpeg producing
 *  seg-0..seg-1 while the main prewarm session encodes from seg-K (resume). */
export function earlySessionKey(mediaFileId: number, userId?: number): string {
  return `${sessionKey(mediaFileId, userId)}-early`;
}

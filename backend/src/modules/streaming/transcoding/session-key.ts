/**
 * Session map key for a transcode job. A single `(file, user)` pair
 * can carry multiple concurrent sessions, one per `cacheKey` (= base
 * profile hash + optional variant suffix). The hash segment makes
 * those entries live as siblings in the `sessions` map without
 * colliding, and matches the on-disk cache layout owned by
 * `TranscodeCacheService`.
 *
 * The variant suffix logic itself lives in `./variant.ts` — callers
 * compose `cacheKey = variantHash(baseHash, variant)` before calling
 * here so the key shape is uniform across main / early / remux / audio.
 */
export function sessionKey(
  mediaFileId: number,
  userId: number | undefined,
  cacheKey: string,
): string {
  const userSeg = userId != null ? `u${userId}` : 'anon';
  return `${mediaFileId}-${userSeg}-${cacheKey}`;
}

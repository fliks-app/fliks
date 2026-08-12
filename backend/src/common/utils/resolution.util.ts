/**
 * Bucket a (width × height) pair to its canonical height step
 * (144 / 240 / 360 / 480 / 720 / 1080 / 2160).
 *
 * Ceilings on **both** axes — anamorphic, scope and IMAX crops sit a
 * couple of pixels below the round number on their non-primary axis, so
 * width-only or height-only thresholds mis-bucket them. Concrete cases
 * this avoids:
 *
 *   • 1918×872 (2.20:1 letterboxed 1080p master): width-only fails the
 *     `>= 1920` check, height-only fails `>= 1080`, both mis-label it
 *     720p. With ceilings on both we get 1080p, which matches the file's
 *     parsed quality and the transcode ladder.
 *   • 3840×2024 (IMAX 4K): height-only fails `>= 2160`, mis-labels it
 *     1080p and drops the 2160p ladder rung. Width-ceiling rescues it.
 *   • 854×480 (16:9 widescreen SD): a `w <= 720` 480 ceiling would
 *     mis-bucket this as 720p; the width ceiling is 854
 *     (matching the 480p profile width) so it returns 480 as expected.
 *
 * Returns 480 when both inputs are zero / missing — safest fallback for
 * sources whose probe hasn't recorded dimensions. Shared by
 * `profileFitsSource` (transcode ladder filtering) and `resolveQuality`
 * (parsed-quality storage) so the player and the file badge agree on
 * what bucket a source belongs to.
 */
export function bucketResolutionHeight(
  width?: number | null,
  height?: number | null,
): number {
  const w = width ?? 0;
  const h = height ?? 0;
  if (!w && !h) return 480;
  if (w <= 256 && h <= 192) return 144;
  if (w <= 426 && h <= 320) return 240;
  if (w <= 640 && h <= 432) return 360;
  if (w <= 854 && h <= 576) return 480;
  if (w <= 1280 && h <= 962) return 720;
  if (w <= 1920 && h <= 1440) return 1080;
  return 2160;
}

/**
 * Whether a (width × height) frame fits within a decoder's max resolution,
 * compared in either orientation — a device reports its per-codec maxima per
 * axis and can return them rotated (a 4K decoder advertising 2048×2048 vs
 * 2160×3840), so the source's long edge is checked against the cap's long edge
 * and likewise for the short edges. An undefined/zero cap axis means "no limit
 * declared" and passes. Shared by the direct-play codec gate (source vs cap)
 * and the output-codec selector (target vs cap).
 */
export function resolutionFitsCap(
  width?: number | null,
  height?: number | null,
  maxWidth?: number | null,
  maxHeight?: number | null,
): boolean {
  const long = Math.max(width ?? 0, height ?? 0);
  const short = Math.min(width ?? 0, height ?? 0);
  const capLong = Math.max(maxWidth ?? 0, maxHeight ?? 0);
  const capShort = Math.min(maxWidth ?? 0, maxHeight ?? 0);
  if (capLong && long > capLong) return false;
  if (capShort && short > capShort) return false;
  return true;
}

/**
 * Display label for a (width × height) pair — `"4K"` for 2160 buckets,
 * `"<bucket>p"` for everything else, `null` when both inputs are
 * zero/missing. Mirrors the client's `bucketResolutionLabel` so badge
 * text matches across the stack.
 */
export function bucketResolutionLabel(
  width?: number | null,
  height?: number | null,
): string | null {
  if (!(width ?? 0) && !(height ?? 0)) return null;
  const bucket = bucketResolutionHeight(width, height);
  return bucket === 2160 ? '4K' : `${bucket}p`;
}

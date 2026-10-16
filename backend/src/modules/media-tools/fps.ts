/** Parse a ffprobe `frameRate` to fps, or `undefined` when unknown. Accepts a
 *  decimal ("23.976") or a rational ("24000/1001"): a bare `parseFloat` of the
 *  rational yields 24000. */
export function parseSourceFps(
  frameRate: string | undefined,
): number | undefined {
  if (!frameRate) return undefined;
  const slash = frameRate.indexOf('/');
  if (slash !== -1) {
    const num = Number(frameRate.slice(0, slash));
    const den = Number(frameRate.slice(slash + 1));
    return num > 0 && den > 0 ? num / den : undefined;
  }
  return parseFloat(frameRate) || undefined;
}

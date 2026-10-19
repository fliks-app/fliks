/** The YouTube embed rejects non-http(s) origins (error 153); the fallback only works where a shell catches `window.open` (iOS, desktop),
 * so TV `file:` bundles keep the embed. */
const EXTERNAL_OPEN_SCHEMES = ['capacitor:', 'fliks:'];

export const trailerPlaysInline =
  typeof location === 'undefined' || !EXTERNAL_OPEN_SCHEMES.includes(location.protocol);

/** Opens the watch page outside the app — the system browser or the YouTube app. */
export function openTrailerExternally(key: string): void {
  window.open(`https://www.youtube.com/watch?v=${key}`, '_blank', 'noopener');
}

/** The YouTube key to play: a Trailer, else a Teaser, else any YouTube video. */
export function bestTrailerKey(
  videos: readonly { key: string; site: string; type: string }[] | null | undefined,
): string | null {
  const youtube = (videos ?? []).filter((v) => v.site === 'YouTube');
  const pick =
    youtube.find((v) => v.type === 'Trailer') ?? youtube.find((v) => v.type === 'Teaser') ?? youtube[0];
  return pick?.key ?? null;
}

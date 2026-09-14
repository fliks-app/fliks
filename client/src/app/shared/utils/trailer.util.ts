/** The YouTube embed rejects any non-http(s) origin with player error 153, but the
 *  fallback below only lands where a shell catches `window.open`: iOS and desktop.
 *  The TV bundles (`file:`) have none, so they keep the embed. */
const EXTERNAL_OPEN_SCHEMES = ['capacitor:', 'fliks:'];

export const trailerPlaysInline =
  typeof location === 'undefined' || !EXTERNAL_OPEN_SCHEMES.includes(location.protocol);

/** Opens the watch page outside the app — the system browser or the YouTube app. */
export function openTrailerExternally(key: string): void {
  window.open(`https://www.youtube.com/watch?v=${key}`, '_blank', 'noopener');
}

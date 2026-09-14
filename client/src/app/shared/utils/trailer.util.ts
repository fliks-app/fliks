/** The YouTube embed rejects any non-http(s) origin with player error 153:
 *  iOS is `capacitor:`, the desktop shell `fliks:`, the TV bundles `file:`. */
export const trailerPlaysInline =
  typeof location !== 'undefined' && /^https?:$/.test(location.protocol);

/** Opens the watch page outside the app — the system browser or the YouTube app. */
export function openTrailerExternally(key: string): void {
  window.open(`https://www.youtube.com/watch?v=${key}`, '_blank', 'noopener');
}

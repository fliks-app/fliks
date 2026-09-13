import { Capacitor } from '@capacitor/core';

/**
 * The iOS WebView serves the app from `capacitor://localhost`, an origin the
 * YouTube embed rejects (player error 153); `iosScheme` can't be set to http
 * because WKWebView reserves that scheme. Android runs on `http://localhost`
 * (see capacitor.config.ts) and embeds fine.
 */
export const trailerPlaysInline = Capacitor.getPlatform() !== 'ios';

/** Opens the watch page outside the WebView — Safari or the YouTube app. */
export function openTrailerExternally(key: string): void {
  window.open(`https://www.youtube.com/watch?v=${key}`, '_blank', 'noopener');
}

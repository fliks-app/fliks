import { Capacitor } from '@capacitor/core';

/** True when the app runs as a standalone bundle with no backend serving its shell (Capacitor, Smart TV, Android TV, desktop):
 *  `/api/...` resolves against the user-picked server with an owned Bearer token; web builds use the httpOnly cookie. */
export const IS_STANDALONE_BUNDLE = (() => {
  if (Capacitor.isNativePlatform()) return true;
  if (typeof navigator === 'undefined') return false;
  return /AndroidTV\/\d|\bTizen\b|SMART-TV|Web0S|webOS|BRAVIA|SHIELD|AFT[A-Z0-9]+|GoogleTV|\bElectron\//i.test(
    navigator.userAgent,
  );
})();

/** Entry document. Over http the page may have been loaded on a deep route
 *  (e.g. /setup), so the restart goes to the root, not wherever that load landed. */
const APP_ENTRY_URL =
  typeof location === 'undefined' ? '/'
  : location.protocol === 'file:' ? location.href
  : `${location.origin}/`;

/** Restarts the app from its entry document; `location.reload()` fails on TV bundles (`file://` with pushState, so the URL has no file behind it). */
export function restartApp(): void {
  location.replace(APP_ENTRY_URL);
}

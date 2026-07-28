import { Capacitor } from '@capacitor/core';

/**
 * True when the app runs as a standalone bundle with no backend host serving its
 * shell — Capacitor, Smart TV, Android TV, desktop. Such a bundle resolves every
 * `/api/...` call against a server URL the user picked and authenticates with a
 * Bearer token it owns; web builds ride the httpOnly access cookie instead.
 */
export const IS_STANDALONE_BUNDLE = (() => {
  if (Capacitor.isNativePlatform()) return true;
  if (typeof navigator === 'undefined') return false;
  return /AndroidTV\/\d|\bTizen\b|SMART-TV|Web0S|webOS|BRAVIA|SHIELD|AFT[A-Z0-9]+|GoogleTV|\bElectron\//i.test(
    navigator.userAgent,
  );
})();

/** URL of the entry document, captured at import time — before the router
 *  rewrites the path. */
const APP_ENTRY_URL = typeof location !== 'undefined' ? location.href : '/';

/**
 * Restart the app from its entry document. `location.reload()` would not do: the
 * TV bundles run from `file://` with pushState routing, so the current URL is a
 * virtual path with no file behind it.
 */
export function restartApp(): void {
  location.replace(APP_ENTRY_URL);
}

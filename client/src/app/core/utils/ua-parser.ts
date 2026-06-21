/**
 * Single source of truth for User-Agent string parsing (OS + browser + shell).
 *
 * The UA is the only signal available on the web, and it CANNOT expose a real OS
 * version — Chromium freezes it (e.g. always "Mac OS X 10_15_7"). So `detectOs`
 * returns an OS *name* only; for a real version, prefer the native
 * `SystemInfoService` (Electron bridge / Capacitor Device), which feeds its
 * richer `systemName` into the label formatters here.
 *
 * Consolidates what used to be duplicated across `format-device-label.ts`,
 * `device-info.ts` and `browser-device-profile.service.ts`.
 */

/** OS name from the UA (no version — see file header). Null if unknown. */
export function detectOs(ua: string): string | null {
  if (/iPad/.test(ua)) return 'iPadOS';
  if (/iPhone|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

/** Browser engine/brand from the UA. Falls back to a generic "Browser". */
export function detectBrowser(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/CriOS\//.test(ua)) return 'Chrome';
  if (/FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

/** True when the UA is the Electron desktop shell (Chromium UA still reads as
 *  "Chrome", so the Electron token is the authoritative marker). */
export function isElectronUa(ua: string): boolean {
  return /\bElectron\//.test(ua);
}

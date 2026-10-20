/** Single source of truth for User-Agent parsing (OS + browser + shell). The UA can't expose a real OS version (Chromium freezes it),
 *  so `detectOs` returns a name only; prefer native `SystemInfoService` for a version. */

/** OS name from the UA (no version — see file header). Null if unknown. */
export function detectOs(ua: string): string | null {
  // TV OSes lead: each one also says Android or Linux further along, so a
  // generic match would win. LG writes its token with a zero — "Web0S".
  if (/Web0S|webOS/.test(ua)) return 'webOS';
  if (/\bTizen\b|SMART-TV/i.test(ua)) return 'Tizen';
  if (/AndroidTV|GoogleTV/i.test(ua)) return 'Android TV';
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

/** The device model as the UA states it (Android model code or iOS device family); null for every desktop browser. */
export function detectDeviceModel(ua: string): string | null {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPod/.test(ua)) return 'iPod';
  // "Mozilla/5.0 (Linux; Android 13; Pixel 8 Build/...)" gives "Pixel 8".
  const m = /Android\s+\d+(?:\.\d+)*;\s*([^)]+?)(?:\s+Build|;|\))/.exec(ua);
  if (!m) return null;
  // Some WebViews append a "wv" variant suffix to the model.
  return m[1].trim().replace(/\s+wv$/i, '').trim() || null;
}

import { detectBrowser, detectDeviceModel, detectOs, isElectronUa } from './ua-parser';

/**
 * Boil the raw User-Agent header into a translation key + interpolation
 * params for device labels (admin streams dashboard, pairing requests). The
 * actual rendering happens via ngx-translate so the labels stay localised.
 *
 * Browser and OS names ("Chrome", "macOS") are passed as interpolation
 * params rather than translated themselves — they're proper nouns that
 * stay identical across locales.
 *
 * `systemName` (optional) is the REAL OS name+version resolved natively
 * (SystemInfoService) — "macOS 26", "Windows 11", "iOS 18.5". When provided it
 * overrides the UA-derived OS (which Chromium freezes and can't version), so the
 * label reads "Application macOS 26" instead of "Application macOS".
 */
export interface DeviceLabelKey {
  key: string;
  params?: Record<string, string>;
}

export function parseDeviceLabel(
  ua: string | null | undefined,
  systemName?: string | null,
  deviceName?: string | null,
): DeviceLabelKey | null {
  // A name its owner chose outranks anything derivable, and needs no
  // translating: it goes through as a param like the browser and OS names do.
  if (deviceName) return { key: 'system.device_named', params: { name: deviceName } };
  if (!ua) {
    // No UA (e.g. a pairing request with only a native systemName): still show
    // the system if we have one.
    return systemName ? { key: 'system.device_app_with_system', params: { system: systemName } } : null;
  }

  if (/AndroidTV/i.test(ua)) return { key: 'system.device_android_tv' };
  if (/BRAVIA/i.test(ua)) return { key: 'system.device_sony_bravia' };
  if (/SHIELD/i.test(ua)) return { key: 'system.device_nvidia_shield' };
  if (/AFT[A-Z0-9]+/i.test(ua)) return { key: 'system.device_fire_tv' };
  if (/GoogleTV/i.test(ua)) return { key: 'system.device_google_tv' };
  if (/\bTizen\b|SMART-TV/i.test(ua)) return { key: 'system.device_samsung_tv' };
  if (/Web0S|webOS/.test(ua)) return { key: 'system.device_lg_tv' };

  // Capacitor / WebView-hosted native apps: Android UAs are tagged "wv",
  // iOS WKWebView UAs ship without the trailing "Safari/" token.
  const isMobileApp =
    (/Android/.test(ua) && /\bwv\b/.test(ua)) ||
    (/iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua));
  if (isMobileApp) {
    // The device's own model identifies it far better than its OS does, so it
    // leads when the UA states one. Falls back to naming the platform.
    const model = detectDeviceModel(ua);
    if (model) return { key: 'system.device_mobile_app_named', params: { name: model } };
    if (systemName) return { key: 'system.device_mobile_app_on_os', params: { os: systemName } };
    return /Android/.test(ua)
      ? { key: 'system.device_mobile_app_android' }
      : { key: 'system.device_mobile_app_ios' };
  }

  // Electron desktop client (Windows / macOS / Linux): Chromium UA still reads
  // as "Chrome", but the Electron token is authoritative.
  if (isElectronUa(ua)) {
    const os = systemName ?? detectOs(ua);
    if (os) return { key: 'system.device_desktop_app_on_os', params: { os } };
    return { key: 'system.device_desktop_app' };
  }

  const browser = detectBrowser(ua);
  const os = systemName ?? detectOs(ua);

  if (!os) return { key: 'system.device_browser_only', params: { browser } };
  return { key: 'system.device_browser_on_os', params: { browser, os } };
}

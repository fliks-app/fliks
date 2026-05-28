/**
 * Boil the raw User-Agent header into a translation key + interpolation
 * params for the admin streams dashboard. The actual rendering happens
 * via ngx-translate so the labels stay localised.
 *
 * Browser and OS names ("Chrome", "macOS") are passed as interpolation
 * params rather than translated themselves — they're proper nouns that
 * stay identical across locales.
 */
export interface DeviceLabelKey {
  key: string;
  params?: Record<string, string>;
}

export function parseDeviceLabel(ua: string | null | undefined): DeviceLabelKey | null {
  if (!ua) return null;

  if (/AndroidTV/i.test(ua)) return { key: 'system.device_android_tv' };
  if (/BRAVIA/i.test(ua)) return { key: 'system.device_sony_bravia' };
  if (/SHIELD/i.test(ua)) return { key: 'system.device_nvidia_shield' };
  if (/AFT[A-Z0-9]+/i.test(ua)) return { key: 'system.device_fire_tv' };
  if (/GoogleTV/i.test(ua)) return { key: 'system.device_google_tv' };
  if (/\bTizen\b|SMART-TV/i.test(ua)) return { key: 'system.device_samsung_tv' };
  if (/Web0S|webOS/.test(ua)) return { key: 'system.device_lg_tv' };

  // Capacitor / WebView-hosted native apps: Android UAs are tagged "wv",
  // iOS WKWebView UAs ship without the trailing "Safari/" token.
  if (/Android/.test(ua) && /\bwv\b/.test(ua)) {
    return { key: 'system.device_mobile_app_android' };
  }
  if (/iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua)) {
    return { key: 'system.device_mobile_app_ios' };
  }

  const browser = detectBrowser(ua);
  const os =
    /iPad/.test(ua)
      ? 'iPadOS'
      : /iPhone|iPod/.test(ua)
        ? 'iOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'macOS'
              : /CrOS/.test(ua)
                ? 'ChromeOS'
                : /Linux/.test(ua)
                  ? 'Linux'
                  : null;

  if (!os) return { key: 'system.device_browser_only', params: { browser } };
  return { key: 'system.device_browser_on_os', params: { browser, os } };
}

function detectBrowser(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/CriOS\//.test(ua)) return 'Chrome';
  if (/FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

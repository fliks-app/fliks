import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

const DEVICE_ID_KEY = 'fliks_device_id';

/**
 * Stable per-installation device identifier. Generated once and persisted in
 * Capacitor Preferences (native) or localStorage (web), then reused for every
 * pairing request so the server can scope the access-token read to the same
 * device that opened the request.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const isNative = Capacitor.isNativePlatform();
  const existing = await readDeviceId(isNative);
  if (existing) return existing;
  const id = generateUuid();
  await writeDeviceId(id, isNative);
  return id;
}

/**
 * Best-effort human-readable device name shown on the phone's pending-requests
 * page so the user can recognize the device making the request. We aim for
 * "this looks like the right TV", not exact accuracy.
 */
export function getDeviceName(): string {
  const ua = navigator.userAgent;

  // Android TV — try to extract the model from the UA, fall back to platform.
  if (/AndroidTV\/\d/.test(ua)) {
    return parseAndroidModel(ua) ?? 'Android TV';
  }
  if (/BRAVIA/i.test(ua)) return 'Sony Bravia';
  if (/SHIELD/i.test(ua)) return 'NVIDIA Shield';
  if (/AFT[A-Z0-9]+/i.test(ua)) return 'Fire TV';
  if (/GoogleTV/i.test(ua)) return 'Google TV';

  // Phone / tablet — Android model parse, iPhone/iPad recognised as such.
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return parseAndroidModel(ua) ?? 'Android';

  // Desktop — best-effort browser + OS.
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} — ${os}` : browser;
}

function parseAndroidModel(ua: string): string | null {
  // "Mozilla/5.0 (Linux; Android 13; Pixel 8 Build/...) ..." → "Pixel 8"
  const m = /Android\s+\d+(?:\.\d+)*;\s*([^)]+?)(?:\s+Build|;|\))/.exec(ua);
  if (!m) return null;
  const model = m[1].trim();
  // Drop variant suffixes like "wv" added on some WebViews.
  return model.replace(/\s+wv$/i, '').trim() || null;
}

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122-ish fallback for older runtimes.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function readDeviceId(isNative: boolean): Promise<string | null> {
  if (isNative) {
    try {
      const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
      if (value) return value;
    } catch {
      /* fall through */
    }
  }
  return localStorage.getItem(DEVICE_ID_KEY);
}

async function writeDeviceId(id: string, isNative: boolean): Promise<void> {
  if (isNative) {
    try {
      await Preferences.set({ key: DEVICE_ID_KEY, value: id });
      return;
    } catch {
      /* fall through */
    }
  }
  localStorage.setItem(DEVICE_ID_KEY, id);
}

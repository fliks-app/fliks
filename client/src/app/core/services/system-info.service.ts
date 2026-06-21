import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { detectOs } from '../utils/ua-parser';

const MOBILE_OS: Record<string, string> = {
  ios: 'iOS',
  android: 'Android',
  mac: 'macOS',
  windows: 'Windows',
};

/**
 * Resolves a human host-OS string ("macOS 26", "Windows 11", "iOS 18.5") from
 * the best NATIVE source — the browser UA can't expose a real OS version, so we
 * read it natively where possible and fall back to the UA OS *name* on the web.
 *
 * Resolution order: Electron preload bridge → Capacitor `Device.getInfo()` →
 * UA name only. Resolved once at construction into a signal; callers that must
 * have the value before sending it (pairing) should `await ready()` first.
 */
@Injectable({ providedIn: 'root' })
export class SystemInfoService {
  private readonly _systemName = signal('');
  private readonly _ready: Promise<void>;

  constructor() {
    this._ready = this.resolve()
      .then((name) => this._systemName.set(name))
      .catch(() => {
        /* leave '' — display falls back to the UA-derived label */
      });
  }

  /** Human OS name + version, or '' until resolved / unavailable. On the web
   *  it's the OS name only (the UA freezes the version). */
  systemName(): string {
    return this._systemName();
  }

  /** Resolves once the native lookup has completed (or failed). */
  ready(): Promise<void> {
    return this._ready;
  }

  private async resolve(): Promise<string> {
    // 1. Electron desktop shell — real OS name + version from the main process.
    const bridge = typeof window !== 'undefined' ? window.fliksDesktop : undefined;
    if (bridge?.getSystemInfo) {
      try {
        const info = await bridge.getSystemInfo();
        if (info?.systemName) return info.systemName;
      } catch {
        /* fall through */
      }
    }
    // 2. Capacitor native (iOS / Android) — Device.getInfo gives a real version.
    if (Capacitor.isNativePlatform()) {
      try {
        const info = await Device.getInfo();
        const os = MOBILE_OS[info.operatingSystem] ?? info.operatingSystem;
        return info.osVersion ? `${os} ${info.osVersion}` : os;
      } catch {
        /* fall through */
      }
    }
    // 3. Web — OS name only (the UA freezes the version).
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return detectOs(ua) ?? '';
  }
}

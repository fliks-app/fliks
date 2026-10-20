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

/** Resolves the host's real OS version (`systemName`) and user-assigned `deviceName` from the best native source (Electron bridge → Capacitor → UA), since the UA can't expose them.
 *  Resolved once at construction; callers needing the value first (pairing) should `await ready()`. */
@Injectable({ providedIn: 'root' })
export class SystemInfoService {
  private readonly _systemName = signal('');
  private readonly _deviceName = signal('');
  private readonly _ready: Promise<void>;

  constructor() {
    this._ready = this.resolve()
      .then((r) => {
        this._systemName.set(r.systemName);
        this._deviceName.set(r.deviceName);
      })
      .catch(() => {
        /* leave '' — callers fall back to the UA-derived label */
      });
  }

  /** Human OS name + version, or '' until resolved / unavailable. On the web
   *  it's the OS name only (the UA freezes the version). */
  systemName(): string {
    return this._systemName();
  }

  /** User-assigned device/computer name, or '' when unavailable (web, or iOS
   *  without the device-name entitlement). */
  deviceName(): string {
    return this._deviceName();
  }

  /** Resolves once the native lookup has completed (or failed). */
  ready(): Promise<void> {
    return this._ready;
  }

  private async resolve(): Promise<{ systemName: string; deviceName: string }> {
    // 1. Electron desktop shell — real OS + machine name from the main process.
    const bridge = typeof window !== 'undefined' ? window.fliksDesktop : undefined;
    if (bridge?.getSystemInfo) {
      try {
        const info = await bridge.getSystemInfo();
        return { systemName: info?.systemName ?? '', deviceName: info?.deviceName ?? '' };
      } catch {
        /* fall through */
      }
    }
    // 2. Capacitor native (iOS / Android) — real version + (Android) device name.
    if (Capacitor.isNativePlatform()) {
      try {
        const info = await Device.getInfo();
        const os = MOBILE_OS[info.operatingSystem] ?? info.operatingSystem;
        return {
          systemName: info.osVersion ? `${os} ${info.osVersion}` : os,
          deviceName: info.name ?? '',
        };
      } catch {
        /* fall through */
      }
    }
    // 3. Web — OS name only (the UA freezes the version; no device name).
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return { systemName: detectOs(ua) ?? '', deviceName: '' };
  }
}

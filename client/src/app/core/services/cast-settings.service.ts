import { Injectable, signal } from '@angular/core';

/** Subtitle presets, same vocabulary as the local player settings; each consumer maps them to its rendering (Shaka CSS, Cast `TextTrackStyle`). */
export interface CastSubtitleStyle {
  size: string;        // 'xsmall' | 'small' | 'normal' | 'large' | 'xlarge'
  color: string;       // 'white' | 'yellow' | 'green' | 'cyan'
  shadow: string;      // 'none' | 'drop' | 'outline' | 'raised'
  background: string;  // 'transparent' | 'semi' | 'black'
}

export interface CastDeviceCapabilities {
  /** Codecs `MediaSource.isTypeSupported` accepts on the receiver, which may differ from the HDMI-passthrough set. */
  audioCodecs: string[];
  /** Video codecs `MediaSource.isTypeSupported` accepts on the receiver. */
  videoCodecs: string[];
}

export interface CastSettings {
  hdr: boolean;
  maxQuality: string; // 'original' | '2160p' | '1080p' | '720p' | '480p'
  audioChannels: number; // 2 = stereo, 6 = 5.1, 8 = 7.1
  subtitleStyle: CastSubtitleStyle;
  /** Per-device display choice: holding the permission doesn't mean wanting the longer list daily. */
  showHouseholdTargets: boolean;
  /** Cache keyed by device friendly name, filled by the `urn:x-cast:app.fliks.caps` probe so later sessions skip the round-trip. */
  capabilities?: Record<string, CastDeviceCapabilities>;
}

const STORAGE_KEY = 'cast.settings';

/** Match the receiver's bake-in (`cast-receiver/receiver.js`) so a first run looks the same whoever applies the fallback. */
export const DEFAULT_CAST_SUBTITLE_STYLE: CastSubtitleStyle = {
  size: 'normal',
  color: 'white',
  shadow: 'drop',
  background: 'transparent',
};

const DEFAULTS: CastSettings = {
  hdr: false,
  maxQuality: '1080p',
  audioChannels: 2,
  subtitleStyle: { ...DEFAULT_CAST_SUBTITLE_STYLE },
  showHouseholdTargets: true,
};

@Injectable({ providedIn: 'root' })
export class CastSettingsService {
  readonly settings = signal<CastSettings>(this.load());

  constructor() {
    // First-run seed keeps the form, localStorage and what the sender transmits in lockstep; unseeded, a reload or second tab would diverge.
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings()));
      }
    } catch { /* private mode / SSR */ }
  }

  private load(): CastSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<CastSettings>;
        return {
          ...DEFAULTS,
          ...parsed,
          // Nested object — spread so older payloads without subtitleStyle
          // get the defaults instead of `undefined`.
          subtitleStyle: { ...DEFAULTS.subtitleStyle, ...(parsed.subtitleStyle ?? {}) },
        };
      }
    } catch { /* ignore */ }
    return { ...DEFAULTS, subtitleStyle: { ...DEFAULTS.subtitleStyle } };
  }

  save(settings: CastSettings) {
    this.settings.set(settings);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  get(): CastSettings {
    return this.settings();
  }

  /** `null` on first sight; the sender then probes and calls {@link setDeviceCapabilities}. */
  getDeviceCapabilities(deviceName: string): CastDeviceCapabilities | null {
    const caps = this.settings().capabilities?.[deviceName];
    return caps ?? null;
  }

  setDeviceCapabilities(deviceName: string, caps: CastDeviceCapabilities) {
    const current = this.settings();
    const updated: CastSettings = {
      ...current,
      capabilities: { ...(current.capabilities ?? {}), [deviceName]: caps },
    };
    this.save(updated);
  }
}

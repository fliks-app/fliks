import { Injectable, signal } from '@angular/core';

/** Subtitle appearance presets — same vocabulary as the local player
 *  settings (`SubtitleAppearanceComponent`). Each consumer translates
 *  the presets to its native rendering: Shaka CSS for local playback,
 *  Cast SDK `TextTrackStyle` enums + `#AARRGGBB` colours for the
 *  receiver. Storing presets (rather than RGB / numeric scale) keeps
 *  one shared UI between local and Cast and matches user expectations
 *  ("Normal / Grand", "Blanc / Jaune") rather than raw values. */
export interface CastSubtitleStyle {
  size: string;        // 'small' | 'normal' | 'large' | 'xlarge'
  color: string;       // 'white' | 'yellow' | 'green' | 'cyan'
  shadow: string;      // 'none' | 'drop' | 'outline' | 'raised'
  background: string;  // 'transparent' | 'semi' | 'black'
}

export interface CastSettings {
  hdr: boolean;
  maxQuality: string; // 'original' | '2160p' | '1080p' | '720p' | '480p'
  audioChannels: number; // 2 = stereo, 6 = 5.1, 8 = 7.1
  subtitleStyle: CastSubtitleStyle;
}

const STORAGE_KEY = 'cast.settings';

/** Defaults match the receiver's bake-in (`cast-receiver/receiver.js`)
 *  so the user-never-opened-settings path is visually identical
 *  whether the receiver applies its fallback or the sender forwards
 *  these presets. */
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
};

@Injectable({ providedIn: 'root' })
export class CastSettingsService {
  readonly settings = signal<CastSettings>(this.load());

  constructor() {
    // First-run: persist the defaults so the cast-settings form, the
    // localStorage payload, and what the sender actually transmits to
    // the receiver all stay in lockstep. Without this seed, an empty
    // storage would still work in-memory (the signal is hydrated from
    // DEFAULTS), but a hard reload, a second tab, or any future code
    // path that re-reads storage would diverge silently.
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
}

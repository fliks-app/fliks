import { Injectable, signal } from '@angular/core';

export interface PlayerSettings {
  preferredAudioLanguage: string; // ISO 639-2/B: 'fra', 'eng', 'jpn', '' = none
  useDefaultAudioStream: boolean;
  rememberAudioSelections: boolean;
}

const SETTINGS_KEY = 'player.settings';
const SELECTIONS_KEY = 'player.audioSelections';

const DEFAULTS: PlayerSettings = {
  preferredAudioLanguage: '',
  useDefaultAudioStream: false,
  rememberAudioSelections: false,
};

/** Map ISO 639-1 (2-letter) to ISO 639-2/B (3-letter) for language matching. */
const ISO_MAP: Record<string, string> = {
  fr: 'fra', en: 'eng', ja: 'jpn', de: 'deu', es: 'spa',
  it: 'ita', pt: 'por', ko: 'kor', zh: 'zho', ru: 'rus', ar: 'ara',
  hi: 'hin', nl: 'nld', pl: 'pol', sv: 'swe', th: 'tha', tr: 'tur',
};

/** Normalize any language code to 3-letter ISO 639-2/B. */
export function normalizeLang(code: string | undefined): string {
  if (!code) return 'und';
  const lower = code.toLowerCase();
  return ISO_MAP[lower] ?? lower;
}

@Injectable({ providedIn: 'root' })
export class PlayerSettingsService {
  readonly settings = signal<PlayerSettings>(this.load());

  private load(): PlayerSettings {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULTS };
  }

  save(settings: PlayerSettings) {
    this.settings.set(settings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  get(): PlayerSettings {
    return this.settings();
  }

  getRememberedAudioTrack(mediaFileId: number): string | null {
    try {
      const raw = localStorage.getItem(SELECTIONS_KEY);
      if (raw) {
        const map: Record<string, string> = JSON.parse(raw);
        return map[String(mediaFileId)] ?? null;
      }
    } catch { /* ignore */ }
    return null;
  }

  saveRememberedAudioTrack(mediaFileId: number, trackId: string) {
    try {
      const raw = localStorage.getItem(SELECTIONS_KEY);
      const map: Record<string, string> = raw ? JSON.parse(raw) : {};
      map[String(mediaFileId)] = trackId;
      localStorage.setItem(SELECTIONS_KEY, JSON.stringify(map));
    } catch { /* ignore */ }
  }
}

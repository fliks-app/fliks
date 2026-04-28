import { Injectable, signal } from '@angular/core';


export interface PlayerSettings {
  // Audio
  preferredAudioLanguage: string;
  useDefaultAudioStream: boolean;
  rememberAudioSelections: boolean;
  // Video
  forceDisableHdr: boolean;
  hdrAutoBrightness: boolean;
  // Subtitles
  preferredSubtitleLanguage: string;
  subtitleMode: 'off' | 'intelligent' | 'always';
  rememberSubtitleSelections: boolean;
  // Subtitle appearance
  subtitleSize: string;
  subtitleColor: string;
  subtitleShadow: string;
  subtitleBackground: string;
  // Subtitle position
  subtitleBottomMargin: number;
  subtitleTopMargin: number;
  // Skip intro
  autoSkipIntro: boolean;
}

const SETTINGS_KEY = 'player.settings';
const AUDIO_SELECTIONS_KEY = 'player.audioSelections';
const SUB_SELECTIONS_KEY = 'player.subtitleSelections';

const DEFAULTS: PlayerSettings = {
  preferredAudioLanguage: '',
  useDefaultAudioStream: false,
  rememberAudioSelections: true,
  forceDisableHdr: false,
  hdrAutoBrightness: true,
  preferredSubtitleLanguage: '',
  subtitleMode: 'intelligent',
  rememberSubtitleSelections: true,
  subtitleSize: 'normal',
  subtitleColor: 'white',
  subtitleShadow: 'drop',
  subtitleBackground: 'transparent',
  subtitleBottomMargin: 10,
  subtitleTopMargin: 5,
  autoSkipIntro: false,
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

// ── Subtitle appearance maps ──

export const SUBTITLE_SIZE_MAP: Record<string, string> = {
  small: '2.2vh', normal: '3vh', large: '3.5vh', xlarge: '4.5vh',
};

export const SUBTITLE_COLOR_MAP: Record<string, string> = {
  white: '#ffffff', yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff',
};

export const SUBTITLE_SHADOW_MAP: Record<string, string> = {
  none: 'none',
  drop: '0 2px 4px rgba(0,0,0,0.9)',
  outline: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
  raised: '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7), 1px 1px 2px rgba(0,0,0,0.8)',
};

export const SUBTITLE_BG_MAP: Record<string, string> = {
  transparent: 'transparent',
  semi: 'rgba(0,0,0,0.5)',
  black: 'rgba(0,0,0,0.9)',
};

@Injectable({ providedIn: 'root' })
export class PlayerSettingsService {
  readonly settings = signal<PlayerSettings>(this.load());

  private load(): PlayerSettings {
    // 10-foot UI: default to large subtitles on Android TV (still overridable by the user)
    const isTv = typeof navigator !== 'undefined' && /AndroidTV\/\d/.test(navigator.userAgent);
    const defaults: PlayerSettings = isTv ? { ...DEFAULTS, subtitleSize: 'large' } : { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return { ...defaults, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return defaults;
  }

  save(settings: PlayerSettings) {
    this.settings.set(settings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  get(): PlayerSettings {
    return this.settings();
  }

  /**
   * Resolve the preferred audio stream index for a media file.
   * Used by both the local player and Cast to ensure consistent audio selection.
   */
  resolveAudioStreamIndex(
    mediaFileId: number,
    audioStreams: { language?: string }[],
    mediaId?: number,
  ): number | undefined {
    const s = this.get();

    // Priority 1: remembered selection always wins (even with "use default" enabled)
    // Uses mediaId (series/movie) so the choice carries across episodes.
    if (s.rememberAudioSelections && mediaId) {
      const savedLang = this.getRememberedAudioTrack(mediaId);
      if (savedLang) {
        const idx = audioStreams.findIndex(
          (a) => normalizeLang(a.language) === savedLang,
        );
        if (idx >= 0) return idx;
      }
    }

    // "Use default audio stream" skips language/auto-selection but not remembered choices
    if (s.useDefaultAudioStream) return undefined;

    // Priority 2: preferred language
    if (s.preferredAudioLanguage) {
      const idx = audioStreams.findIndex(
        (a) => normalizeLang(a.language) === s.preferredAudioLanguage,
      );
      if (idx >= 0) return idx;
    }

    // Priority 3: default to first stream for multi-audio files
    if (audioStreams.length > 1) return 0;

    return undefined;
  }

  // ── Audio track memory ──

  getRememberedAudioTrack(mediaFileId: number): string | null {
    return this.getFromMap(AUDIO_SELECTIONS_KEY, mediaFileId);
  }

  saveRememberedAudioTrack(mediaFileId: number, trackId: string) {
    this.saveToMap(AUDIO_SELECTIONS_KEY, mediaFileId, trackId);
  }

  // ── Subtitle track memory ──

  getRememberedSubtitleTrack(mediaFileId: number): string | null {
    return this.getFromMap(SUB_SELECTIONS_KEY, mediaFileId);
  }

  saveRememberedSubtitleTrack(mediaFileId: number, trackId: string | null) {
    if (trackId == null) {
      this.removeFromMap(SUB_SELECTIONS_KEY, mediaFileId);
    } else {
      this.saveToMap(SUB_SELECTIONS_KEY, mediaFileId, trackId);
    }
  }

  clearRememberedAudioTracks() {
    localStorage.removeItem(AUDIO_SELECTIONS_KEY);
  }

  clearRememberedSubtitleTracks() {
    localStorage.removeItem(SUB_SELECTIONS_KEY);
  }

  // ── Helpers ──

  private getFromMap(key: string, id: number): string | null {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const map: Record<string, string> = JSON.parse(raw);
        return map[String(id)] ?? null;
      }
    } catch { /* ignore */ }
    return null;
  }

  private saveToMap(key: string, id: number, value: string) {
    try {
      const raw = localStorage.getItem(key);
      const map: Record<string, string> = raw ? JSON.parse(raw) : {};
      map[String(id)] = value;
      localStorage.setItem(key, JSON.stringify(map));
    } catch { /* ignore */ }
  }

  private removeFromMap(key: string, id: number) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const map: Record<string, string> = JSON.parse(raw);
        delete map[String(id)];
        localStorage.setItem(key, JSON.stringify(map));
      }
    } catch { /* ignore */ }
  }
}

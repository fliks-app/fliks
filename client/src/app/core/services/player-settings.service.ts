import { Injectable, inject, signal } from '@angular/core';
import { DeviceService } from './device.service';
import { normalizeLangCode } from '../utils/language.utils';
import {
  DOM_SUBTITLE_HEIGHT_FRACTION,
  NATIVE_SUBTITLE_SIZE_SCALE,
  SUBTITLE_MIN_TEXT_PX,
} from '../utils/subtitle-presets';


/** How much the viewer wants a hearing-impaired (SDH) track: `avoid` keeps the
 *  annotations out unless nothing else carries the language, `prefer` asks for
 *  them, `any` takes whichever track comes first. */
export type HearingImpairedPreference = 'avoid' | 'any' | 'prefer';

export interface PlayerSettings {
  // Audio
  preferredAudioLanguage: string;
  /** `preferred`: the language above. `original`: the title's own language.
   *  `default`: the track the file flags as default. `first`: the first track,
   *  whatever it is. Every mode falls back to the first track when it can't be
   *  satisfied. */
  audioSelectionMode: 'preferred' | 'original' | 'default' | 'first';
  rememberAudioSelections: boolean;
  // Video
  forceDisableHdr: boolean;
  /** Show the low-consumption ("faible consommation") quality rungs in the
   *  player quality menu. */
  showEcoQualities: boolean;
  // Subtitles
  preferredSubtitleLanguage: string;
  /** `off`: never. `onlyForced`: just the foreign-dialogue track. `intelligent`:
   *  a full track when the audio is foreign, the forced one when it isn't.
   *  `always`: a full track whenever the language exists. */
  subtitleMode: 'off' | 'onlyForced' | 'intelligent' | 'always';
  subtitleHearingImpaired: HearingImpairedPreference;
  rememberSubtitleSelections: boolean;
  // Hide image-based (PGS/VOBSUB) subtitles from the pickers and native player
  hideImageSubtitles: boolean;
  /** Show the file format (SRT, VTT, ASS…) in the subtitle pickers. Off by
   *  default: the language and the flags are what most viewers pick on. */
  showSubtitleFormat: boolean;
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
  // Play the next episode automatically when one finishes (series).
  autoPlayNext: boolean;
}

/** Empty stays empty: it is the "no preference" value, not a language. */
function foldLang(code: string): string {
  return code ? normalizeLangCode(code) : '';
}

const SETTINGS_KEY = 'player.settings';
const AUDIO_SELECTIONS_KEY = 'player.audioSelections';
const SUB_SELECTIONS_KEY = 'player.subtitleSelections';

const DEFAULTS: PlayerSettings = {
  preferredAudioLanguage: '',
  audioSelectionMode: 'default',
  rememberAudioSelections: true,
  forceDisableHdr: false,
  showEcoQualities: true,
  preferredSubtitleLanguage: '',
  subtitleMode: 'intelligent',
  subtitleHearingImpaired: 'avoid',
  rememberSubtitleSelections: true,
  hideImageSubtitles: true,
  showSubtitleFormat: false,
  subtitleSize: 'normal',
  subtitleColor: 'white',
  subtitleShadow: 'drop',
  subtitleBackground: 'transparent',
  subtitleBottomMargin: 5,
  subtitleTopMargin: 5,
  autoSkipIntro: false,
  autoPlayNext: true,
};

/** The audio-stream fields the track selection reads. */
export interface AudioStreamChoice {
  language?: string;
  isDefault?: boolean;
}

/** Normalize any language code to 3-letter ISO 639-2/B. */
// ── Subtitle appearance maps ──

/** The DOM cue sizes are the native ladder in `vmin` — the viewport's short
 *  side, so a rotation doesn't resize the cues (`vh` collapsed them to ~12px
 *  in landscape on a phone) — under the same floor the native renderers use. */
export function domCueFontSize(scale: number): string {
  return `max(${+(scale * SUBTITLE_MIN_TEXT_PX).toFixed(2)}px, ${+(scale * DOM_SUBTITLE_HEIGHT_FRACTION * 100).toFixed(2)}vmin)`;
}

export const SUBTITLE_SIZE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(NATIVE_SUBTITLE_SIZE_SCALE).map(([size, scale]) => [
    size,
    domCueFontSize(scale),
  ]),
);

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
  private readonly device = inject(DeviceService);
  readonly settings = signal<PlayerSettings>(this.load());

  private load(): PlayerSettings {
    // 10-foot UI: default to large subtitles on every TV form factor
    // (AndroidTV / Tizen / webOS — still overridable by the user).
    const defaults: PlayerSettings = this.device.isTv()
      ? { ...DEFAULTS, subtitleSize: 'xlarge' }
      : { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const stored = JSON.parse(raw);
        if (!stored.audioSelectionMode) {
          stored.audioSelectionMode = stored.useDefaultAudioStream ? 'default' : 'preferred';
        }
        delete stored.useDefaultAudioStream;
        const merged = { ...defaults, ...stored };
        // Older builds stored ISO 639-2 ("fra"), which matches no track: every
        // list is canonicalised to ISO 639-1 now.
        merged.preferredAudioLanguage = foldLang(merged.preferredAudioLanguage);
        merged.preferredSubtitleLanguage = foldLang(merged.preferredSubtitleLanguage);
        return merged;
      }
    } catch { /* ignore */ }
    return defaults;
  }

  save(settings: PlayerSettings) {
    this.settings.set(settings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  /** Save a single field (or a few) without rebuilding the whole object —
   *  used by the in-player panels that change one setting per tap. */
  patch(partial: Partial<PlayerSettings>) {
    this.save({ ...this.settings(), ...partial });
  }

  get(): PlayerSettings {
    return this.settings();
  }

  /**
   * The language the audio auto-selection targets, if any. Undefined in the
   * `default` and `first` modes, which don't select by language at all.
   *
   * @param originalLanguage The title's original language (TMDB, ISO 639-1).
   */
  audioLanguage(originalLanguage?: string | null): string | undefined {
    const s = this.get();
    if (s.audioSelectionMode === 'original') {
      return originalLanguage ? normalizeLangCode(originalLanguage) : undefined;
    }
    if (s.audioSelectionMode === 'preferred') {
      return s.preferredAudioLanguage || undefined;
    }
    return undefined;
  }

  /**
   * The single language to configure an engine with before load, so it picks
   * the right rendition during manifest parse instead of switching after.
   */
  resolveAudioLanguage(
    mediaId?: number,
    originalLanguage?: string | null,
  ): string | undefined {
    const s = this.get();
    if (s.rememberAudioSelections && mediaId) {
      // The stored value may carry a ":n" ordinal (same-language
      // disambiguator); engines pre-pick by language, so strip it here.
      const saved = this.getRememberedAudioTrack(mediaId)?.split(':')[0];
      if (saved) return saved;
    }
    return this.audioLanguage(originalLanguage);
  }

  /**
   * Resolve the preferred audio stream index for a media file.
   * Used by both the local player and Cast to ensure consistent audio selection.
   */
  resolveAudioStreamIndex(
    mediaFileId: number,
    audioStreams: AudioStreamChoice[],
    mediaId?: number,
    originalLanguage?: string | null,
  ): number | undefined {
    if (!audioStreams.length) return undefined;
    const s = this.get();
    const indexOfLang = (lang: string) =>
      audioStreams.findIndex(
        (a) => normalizeLangCode(a.language) === normalizeLangCode(lang),
      );

    // Priority 1: remembered selection always wins, whatever the mode.
    // Uses mediaId (series/movie) so the choice carries across episodes.
    if (s.rememberAudioSelections && mediaId) {
      const savedLang = this.getRememberedAudioTrack(mediaId)?.split(':')[0];
      if (savedLang) {
        const idx = indexOfLang(savedLang);
        if (idx >= 0) return idx;
      }
    }

    // Priority 2: the mode's target language.
    const lang = this.audioLanguage(originalLanguage);
    if (lang) {
      const idx = indexOfLang(lang);
      if (idx >= 0) return idx;
    }

    // Priority 3: the track the file flags as default. Resolved here rather
    // than left to the container — the HLS paths rebuild the audio group and
    // would otherwise always mark the first rendition as the default one.
    if (s.audioSelectionMode === 'default') {
      const idx = audioStreams.findIndex((a) => a.isDefault);
      if (idx >= 0) return idx;
    }

    // Priority 4: the first track, and the fallback for every unmet mode.
    return 0;
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

import { Injectable, inject, signal } from '@angular/core';
import { TextAlignment, type IEpubPreferences } from '@readium/navigator';
import { StorageScopeService } from '../../core/services/storage-scope.service';
import { COMIC_MODES, COMIC_PREFS_DEFAULT, type ComicPrefs } from './comic-layout';

export type ReaderTheme = 'original' | 'sepia' | 'calm' | 'slate' | 'night' | 'black';
export type ReaderFont = 'publisher' | 'literata' | 'sans' | 'atkinson';
export type ReaderMargins = 'narrow' | 'normal' | 'wide';
export type ReaderColumns = 'auto' | '1' | '2';

export interface ReaderSettings {
  /** Multiplier of the publication's font size. */
  fontSize: number;
  fontFamily: ReaderFont;
  theme: ReaderTheme;
  /** Multiplier of the font size. */
  lineHeight: number;
  margins: ReaderMargins;
  /** Continuous scroll instead of pages. */
  scroll: boolean;
  columns: ReaderColumns;
  justify: boolean;
  /** PDF page width as a multiple of the fit-to-width size. */
  zoom: number;
}

export interface ThemeColors {
  background: string;
  text: string;
  link: string;
}

/** A theme is a page colour pair plus the font and line height it reads best with. */
export interface ThemePreset extends ThemeColors {
  fontFamily: ReaderFont;
  lineHeight: number;
}

export const FONT_SIZE_RANGE = { min: 0.8, max: 2, step: 0.1 } as const;
export const LINE_HEIGHT_RANGE = { min: 1.2, max: 2.2, step: 0.1 } as const;
export const ZOOM_RANGE = { min: 0.5, max: 3, step: 0.25 } as const;
export const READER_THEMES: readonly ReaderTheme[] = ['original', 'sepia', 'calm', 'slate', 'night', 'black'];
export const READER_FONTS: readonly ReaderFont[] = ['publisher', 'literata', 'sans', 'atkinson'];
export const READER_MARGINS: readonly ReaderMargins[] = ['narrow', 'normal', 'wide'];
export const READER_COLUMNS: readonly ReaderColumns[] = ['auto', '1', '2'];

export const READER_DEFAULTS: ReaderSettings = {
  fontSize: 1,
  fontFamily: 'publisher',
  theme: 'night',
  lineHeight: 1.5,
  margins: 'normal',
  scroll: false,
  columns: 'auto',
  justify: false,
  zoom: 1,
};

const GUTTER_PX: Record<ReaderMargins, number> = { narrow: 12, normal: 32, wide: 64 };

export const FONT_STACKS: Record<ReaderFont, string | null> = {
  publisher: null,
  literata: '"Literata Variable", Georgia, serif',
  sans: 'system-ui, "Helvetica Neue", Arial, sans-serif',
  atkinson: '"Atkinson Hyperlegible", system-ui, sans-serif',
};

export const THEME_PRESETS: Record<ReaderTheme, ThemePreset> = {
  original: { background: '#fbfaf7', text: '#1f2328', link: '#2563eb', fontFamily: 'publisher', lineHeight: 1.5 },
  sepia: { background: '#f4ecd8', text: '#3b2f22', link: '#8a4b14', fontFamily: 'literata', lineHeight: 1.7 },
  calm: { background: '#ecebe6', text: '#2b2b2b', link: '#2f6b4f', fontFamily: 'sans', lineHeight: 1.6 },
  slate: { background: '#2b3036', text: '#dfe3e8', link: '#8ab4ff', fontFamily: 'literata', lineHeight: 1.7 },
  night: { background: '#15191e', text: '#c9d1da', link: '#8a88ff', fontFamily: 'publisher', lineHeight: 1.5 },
  black: { background: '#000000', text: '#a7adb5', link: '#8a88ff', fontFamily: 'atkinson', lineHeight: 1.6 },
};

export const isDarkTheme = (theme: ReaderTheme): boolean => theme === 'slate' || theme === 'night' || theme === 'black';

export const readerThemeColors = (theme: ReaderTheme): ThemeColors => THEME_PRESETS[theme];

/** The settings a preset sets, for one tap on its swatch. */
export const presetPatch = (theme: ReaderTheme): Partial<ReaderSettings> => ({
  theme,
  fontFamily: THEME_PRESETS[theme].fontFamily,
  lineHeight: THEME_PRESETS[theme].lineHeight,
});

export function toReaderPreferences(settings: ReaderSettings, colors: ThemeColors): IEpubPreferences {
  const gutter = GUTTER_PX[settings.margins];
  return {
    fontSize: settings.fontSize,
    fontFamily: FONT_STACKS[settings.fontFamily],
    lineHeight: settings.lineHeight,
    scroll: settings.scroll,
    columnCount: settings.columns === 'auto' ? null : Number(settings.columns),
    textAlign: settings.justify ? TextAlignment.justify : null,
    hyphens: settings.justify ? true : null,
    pageGutter: gutter,
    scrollPaddingLeft: gutter,
    scrollPaddingRight: gutter,
    backgroundColor: colors.background,
    textColor: colors.text,
    linkColor: colors.link,
    visitedColor: colors.link,
  };
}

const clamp = (value: unknown, range: { min: number; max: number }, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(range.max, Math.max(range.min, value))
    : fallback;

const oneOf = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** Values stored before the six presets and four fonts. */
const LEGACY: Record<string, string> = { light: 'original', dark: 'night', serif: 'literata' };

/** Anything a stored blob got wrong falls back to its default, field by field. */
export function sanitizeReaderSettings(raw: unknown): ReaderSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    fontSize: clamp(r['fontSize'], FONT_SIZE_RANGE, READER_DEFAULTS.fontSize),
    fontFamily: oneOf(READER_FONTS, LEGACY[String(r['fontFamily'])] ?? r['fontFamily'], READER_DEFAULTS.fontFamily),
    theme: oneOf(READER_THEMES, LEGACY[String(r['theme'])] ?? r['theme'], READER_DEFAULTS.theme),
    lineHeight: clamp(r['lineHeight'], LINE_HEIGHT_RANGE, READER_DEFAULTS.lineHeight),
    margins: oneOf(READER_MARGINS, r['margins'], READER_DEFAULTS.margins),
    scroll: typeof r['scroll'] === 'boolean' ? r['scroll'] : READER_DEFAULTS.scroll,
    columns: oneOf(READER_COLUMNS, r['columns'], READER_DEFAULTS.columns),
    justify: typeof r['justify'] === 'boolean' ? r['justify'] : READER_DEFAULTS.justify,
    zoom: clamp(r['zoom'], ZOOM_RANGE, READER_DEFAULTS.zoom),
  };
}

/** Provided per reader page, so each opening reads the signed-in user's own settings. */
@Injectable()
export class ReaderSettingsService {
  private readonly scope = inject(StorageScopeService);
  private readonly key = `reader.settings:${this.scope.suffix()}`;

  readonly settings = signal<ReaderSettings>(this.load());

  save(patch: Partial<ReaderSettings>): void {
    const next = sanitizeReaderSettings({ ...this.settings(), ...patch });
    this.settings.set(next);
    if (!this.scope.canPersist()) return;
    try {
      localStorage.setItem(this.key, JSON.stringify(next));
    } catch {
      // Storage blocked or full: the settings last for this page only.
    }
  }

  private readonly comicKey = `reader.comics:${this.scope.suffix()}`;
  private comics: Record<string, unknown> = this.loadComics();

  comicPrefs(mediaId: number): ComicPrefs {
    return sanitizeComicPrefs(this.comics[mediaId]);
  }

  saveComicPrefs(mediaId: number, prefs: ComicPrefs): void {
    this.comics = { ...this.comics, [mediaId]: sanitizeComicPrefs(prefs) };
    if (!this.scope.canPersist()) return;
    try {
      localStorage.setItem(this.comicKey, JSON.stringify(this.comics));
    } catch {
      // Storage blocked or full: the layout lasts for this page only.
    }
  }

  private loadComics(): Record<string, unknown> {
    try {
      const raw = JSON.parse(localStorage.getItem(this.comicKey) ?? 'null');
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  private load(): ReaderSettings {
    try {
      const raw = localStorage.getItem(this.key);
      return sanitizeReaderSettings(raw ? JSON.parse(raw) : null);
    } catch {
      return { ...READER_DEFAULTS };
    }
  }
}

/** Per-volume comic layout, kept apart from the text settings so each volume remembers manga, webtoon or paged. */
export function sanitizeComicPrefs(raw: unknown): ComicPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    mode: oneOf(COMIC_MODES, r['mode'], COMIC_PREFS_DEFAULT.mode),
    spread: typeof r['spread'] === 'boolean' ? r['spread'] : COMIC_PREFS_DEFAULT.spread,
  };
}

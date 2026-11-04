import { Injectable, inject, signal, untracked } from '@angular/core';
import { TextAlignment, type IEpubPreferences } from '@readium/navigator';
import { StorageScopeService } from '../../core/services/storage-scope.service';
import { ANNOTATION_COLOURS, type AnnotationColour } from './annotations-api.service';
import { COMIC_MODES, COMIC_PREFS_DEFAULT, type ComicPrefs } from './comic-layout';
import type { SidebarTab } from './reader-sidebar';

/** Where the side panel was left: its tab and the notes colour filter. */
export interface ReaderPanelState {
  tab: SidebarTab;
  notesFilter: AnnotationColour | null;
}
const SIDEBAR_TABS: readonly SidebarTab[] = ['contents', 'bookmarks', 'notes', 'search'];

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

/** The reset button: the current theme's own preset, and the defaults of the size, margins, columns and justification. */
export const resetPatch = (theme: ReaderTheme): Partial<ReaderSettings> => {
  const { fontSize, margins, columns, justify } = READER_DEFAULTS;
  return { ...presetPatch(theme), fontSize, margins, columns, justify };
};

/** Translucent Fliks violet: legible on every theme and unlike any highlight colour. */
const SELECTION = 'rgba(96, 93, 255, 0.35)';

/** `compact` (a phone-width reader) halves the side margins: the screen is too narrow to spare them. */
export function toReaderPreferences(settings: ReaderSettings, colors: ThemeColors, compact = false): IEpubPreferences {
  const gutter = GUTTER_PX[settings.margins] / (compact ? 2 : 1);
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
    selectionBackgroundColor: SELECTION,
    selectionTextColor: colors.text,
  };
}

const clamp = (value: unknown, range: { min: number; max: number }, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(range.max, Math.max(range.min, value))
    : fallback;

const oneOf = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** Names a stored blob may carry for a theme or a font, mapped to the current ones. */
const ALIASES: Record<string, string> = { light: 'original', dark: 'night', serif: 'literata' };

/** Anything a stored blob got wrong falls back to its default, field by field. */
export function sanitizeReaderSettings(raw: unknown): ReaderSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    fontSize: clamp(r['fontSize'], FONT_SIZE_RANGE, READER_DEFAULTS.fontSize),
    fontFamily: oneOf(READER_FONTS, ALIASES[String(r['fontFamily'])] ?? r['fontFamily'], READER_DEFAULTS.fontFamily),
    theme: oneOf(READER_THEMES, ALIASES[String(r['theme'])] ?? r['theme'], READER_DEFAULTS.theme),
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
  private readonly comicKey = `reader.comics:${this.scope.suffix()}`;
  private readonly panelKey = `reader.panel:${this.scope.suffix()}`;

  readonly settings = signal<ReaderSettings>(sanitizeReaderSettings(this.read(this.key)));
  readonly panel = signal<ReaderPanelState>(sanitizePanel(this.read(this.panelKey)));
  private comics = recordOf(this.read(this.comicKey));

  save(patch: Partial<ReaderSettings>): void {
    this.settings.set(sanitizeReaderSettings({ ...this.settings(), ...patch }));
    this.write(this.key, this.settings());
  }

  /** Untracked, so an effect saving one field doesn't rerun on the write it makes. */
  savePanel(patch: Partial<ReaderPanelState>): void {
    const next = sanitizePanel({ ...untracked(this.panel), ...patch });
    this.panel.set(next);
    this.write(this.panelKey, next);
  }

  comicPrefs(mediaId: number): ComicPrefs {
    return sanitizeComicPrefs(this.comics[mediaId]);
  }

  saveComicPrefs(mediaId: number, prefs: ComicPrefs): void {
    this.comics = { ...this.comics, [mediaId]: sanitizeComicPrefs(prefs) };
    this.write(this.comicKey, this.comics);
  }

  private read(key: string): unknown {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  }

  /** Storage blocked or full: the value lasts for this page only. */
  private write(key: string, value: unknown): void {
    if (!this.scope.canPersist()) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* kept in memory */
    }
  }
}

const recordOf = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

function sanitizePanel(raw: unknown): ReaderPanelState {
  const r = recordOf(raw);
  return {
    tab: oneOf(SIDEBAR_TABS, r['tab'], 'contents'),
    notesFilter: ANNOTATION_COLOURS.includes(r['notesFilter'] as AnnotationColour)
      ? (r['notesFilter'] as AnnotationColour)
      : null,
  };
}

/** Per-volume comic layout, kept apart from the text settings so each volume remembers manga, webtoon or paged. */
export function sanitizeComicPrefs(raw: unknown): ComicPrefs {
  const r = recordOf(raw);
  return {
    mode: oneOf(COMIC_MODES, r['mode'], COMIC_PREFS_DEFAULT.mode),
    spread: typeof r['spread'] === 'boolean' ? r['spread'] : COMIC_PREFS_DEFAULT.spread,
  };
}

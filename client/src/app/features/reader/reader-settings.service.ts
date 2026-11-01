import { Injectable, inject, signal } from '@angular/core';
import type { IEpubPreferences } from '@readium/navigator';
import { StorageScopeService } from '../../core/services/storage-scope.service';

export type ReaderTheme = 'light' | 'sepia' | 'dark';
export type ReaderFont = 'publisher' | 'serif' | 'sans';
export type ReaderMargins = 'narrow' | 'normal' | 'wide';

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
}

export interface ThemeColors {
  background: string;
  text: string;
  link: string;
}

export const FONT_SIZE_RANGE = { min: 0.8, max: 2, step: 0.1 } as const;
export const LINE_HEIGHT_RANGE = { min: 1.2, max: 2.2, step: 0.1 } as const;
export const READER_THEMES: readonly ReaderTheme[] = ['light', 'sepia', 'dark'];
export const READER_FONTS: readonly ReaderFont[] = ['publisher', 'serif', 'sans'];
export const READER_MARGINS: readonly ReaderMargins[] = ['narrow', 'normal', 'wide'];

export const READER_DEFAULTS: ReaderSettings = {
  fontSize: 1,
  fontFamily: 'publisher',
  theme: 'dark',
  lineHeight: 1.5,
  margins: 'normal',
  scroll: false,
};

const GUTTER_PX: Record<ReaderMargins, number> = { narrow: 12, normal: 32, wide: 64 };

const FONT_STACKS: Record<ReaderFont, string | null> = {
  publisher: null,
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, "Helvetica Neue", Arial, sans-serif',
};

const FIXED_THEMES: Record<'light' | 'sepia', ThemeColors> = {
  light: { background: '#ffffff', text: '#1f2937', link: '#2563eb' },
  sepia: { background: '#f4ecd8', text: '#433422', link: '#8a4b14' },
};

/** Dark follows the app's own tokens, so the page matches the chrome around it. */
export function readerThemeColors(theme: ReaderTheme, root: Element = document.documentElement): ThemeColors {
  if (theme !== 'dark') return FIXED_THEMES[theme];
  const css = getComputedStyle(root);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--color-base-100', '#1d232a'),
    text: token('--color-base-content', '#e5e7eb'),
    link: token('--color-primary', '#7a3ff2'),
  };
}

export function toReaderPreferences(settings: ReaderSettings, colors: ThemeColors): IEpubPreferences {
  const gutter = GUTTER_PX[settings.margins];
  return {
    fontSize: settings.fontSize,
    fontFamily: FONT_STACKS[settings.fontFamily],
    lineHeight: settings.lineHeight,
    scroll: settings.scroll,
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

/** Anything a stored blob got wrong falls back to its default, field by field. */
export function sanitizeReaderSettings(raw: unknown): ReaderSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    fontSize: clamp(r['fontSize'], FONT_SIZE_RANGE, READER_DEFAULTS.fontSize),
    fontFamily: oneOf(READER_FONTS, r['fontFamily'], READER_DEFAULTS.fontFamily),
    theme: oneOf(READER_THEMES, r['theme'], READER_DEFAULTS.theme),
    lineHeight: clamp(r['lineHeight'], LINE_HEIGHT_RANGE, READER_DEFAULTS.lineHeight),
    margins: oneOf(READER_MARGINS, r['margins'], READER_DEFAULTS.margins),
    scroll: typeof r['scroll'] === 'boolean' ? r['scroll'] : READER_DEFAULTS.scroll,
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

  private load(): ReaderSettings {
    try {
      const raw = localStorage.getItem(this.key);
      return sanitizeReaderSettings(raw ? JSON.parse(raw) : null);
    } catch {
      return { ...READER_DEFAULTS };
    }
  }
}

import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

/**
 * Formats a date in the currently-selected language's convention (fr →
 * DD/MM/YYYY, en → M/D/YYYY, …). Impure so it re-renders on a live language
 * switch — Angular's DatePipe can't, since `LOCALE_ID` is fixed at bootstrap.
 * Pass `Intl.DateTimeFormatOptions` (e.g. `{ dateStyle: 'long' }` or
 * `{ dateStyle: 'short', timeStyle: 'short' }`) for other shapes; the default
 * is a numeric date. Date-only strings (`YYYY-MM-DD`) format in UTC to avoid an
 * off-by-one day.
 */
@Pipe({ name: 'localeDate', standalone: true, pure: false })
export class LocaleDatePipe implements PipeTransform {
  private readonly translate = inject(TranslateService);
  private static readonly formatters = new Map<string, Intl.DateTimeFormat>();

  transform(
    value: string | number | Date | null | undefined,
    options: Intl.DateTimeFormatOptions = {},
  ): string {
    if (value === null || value === undefined || value === '') return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const lang =
      this.translate.currentLang() || this.translate.fallbackLang() || 'en';
    const dateOnly =
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    const opts: Intl.DateTimeFormatOptions = {
      ...(dateOnly ? { timeZone: 'UTC' } : {}),
      ...options,
    };
    const key = `${lang}|${JSON.stringify(opts)}`;
    let formatter = LocaleDatePipe.formatters.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(lang, opts);
      LocaleDatePipe.formatters.set(key, formatter);
    }
    return formatter.format(date);
  }
}

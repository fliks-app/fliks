import { HttpBackend, HttpClient } from '@angular/common/http';
import type { TranslationObject } from '@ngx-translate/core';
import { TranslateLoader, mergeDeep } from '@ngx-translate/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

/** Per-track namespace files under `i18n/<ns>/{lang}.json`, merged over the core file. */
export const I18N_FEATURE_FILES = ['books-library', 'books-work', 'books-people', 'books-search'];

/** Charge les JSON i18n via HttpBackend, hors interceptors, pour éviter la dépendance circulaire TranslateService ↔ errorInterceptor. */
export function translateBrowserLoaderFactory(
  backend: HttpBackend,
): TranslateLoader {
  const http = new HttpClient(backend);
  // Relative to <base href>: a leading "/" resolves to the filesystem root on TV (file://) and 404s.
  // A missing locale file degrades to empty so ngx-translate falls back instead of blanking the UI.
  const load = (path: string) =>
    http.get<TranslationObject>(path).pipe(catchError(() => of<TranslationObject>({})));
  return {
    getTranslation(lang: string): Observable<TranslationObject> {
      const v = Date.now();
      return forkJoin([
        load(`i18n/${lang}.json?v=${v}`),
        ...I18N_FEATURE_FILES.map((ns) => load(`i18n/${ns}/${lang}.json?v=${v}`)),
      ]).pipe(map((files) => files.reduce((acc, f) => mergeDeep(acc, f), {} as TranslationObject)));
    },
  };
}

import { HttpBackend, HttpClient } from '@angular/common/http';
import type { TranslationObject } from '@ngx-translate/core';
import { TranslateLoader } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { DEFAULT_LOCALE, resolveInitialLocale } from '../core/constants/app-locale';

/** Charge les JSON i18n via HttpBackend, hors interceptors, pour éviter la dépendance circulaire TranslateService ↔ errorInterceptor. */
export function translateBrowserLoaderFactory(
  backend: HttpBackend,
): TranslateLoader {
  const http = new HttpClient(backend);
  return {
    getTranslation(lang: string): Observable<TranslationObject> {
      // `en` is the fallback language: a non-English session only needs it as an empty bag for plugin strings, not its 5k keys.
      if (lang === DEFAULT_LOCALE && resolveInitialLocale() !== DEFAULT_LOCALE) return of({});
      // Relative to <base href>: a leading "/" resolves to the filesystem root on TV (file://) and 404s.
      // `v` keys the service worker's cache to the release; a missing file degrades to {} so the fallback language shows.
      return http
        .get<TranslationObject>(`i18n/${lang}.json?v=${environment.version}`)
        .pipe(catchError(() => of<TranslationObject>({})));
    },
  };
}

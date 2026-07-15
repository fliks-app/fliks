import { HttpBackend, HttpClient } from '@angular/common/http';
import type { TranslationObject } from '@ngx-translate/core';
import { TranslateLoader } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * Charge les JSON i18n via HttpBackend pour ne pas passer par les interceptors HttpClient.
 * Évite la dépendance circulaire TranslateService ↔ errorInterceptor.
 */
export function translateBrowserLoaderFactory(
  backend: HttpBackend,
): TranslateLoader {
  const http = new HttpClient(backend);
  return {
    getTranslation(lang: string): Observable<TranslationObject> {
      // Relative to <base href> so it resolves against the app bundle: on
      // web that's the server root, on Smart TV (file:// with baseHref "./")
      // it's the app directory where the JSON ships. A leading "/" resolves
      // to the filesystem root on TV and 404s.
      // A missing/late locale file must not blank the UI — degrade to empty so
      // ngx-translate falls back to the fallback language instead of erroring.
      return http
        .get<TranslationObject>(`i18n/${lang}.json?v=${Date.now()}`)
        .pipe(catchError(() => of<TranslationObject>({})));
    },
  };
}

import { HttpBackend, HttpClient } from '@angular/common/http';
import type { TranslationObject } from '@ngx-translate/core';
import { TranslateLoader } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

/** Charge les JSON i18n via HttpBackend, hors interceptors, pour éviter la dépendance circulaire TranslateService ↔ errorInterceptor. */
export function translateBrowserLoaderFactory(
  backend: HttpBackend,
): TranslateLoader {
  const http = new HttpClient(backend);
  return {
    getTranslation(lang: string): Observable<TranslationObject> {
      // Relative to <base href>: a leading "/" resolves to the filesystem root on TV (file://) and 404s.
      // A missing locale file degrades to empty so ngx-translate falls back instead of blanking the UI.
      return http
        .get<TranslationObject>(`i18n/${lang}.json?v=${Date.now()}`)
        .pipe(catchError(() => of<TranslationObject>({})));
    },
  };
}

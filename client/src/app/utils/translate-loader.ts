import { HttpBackend, HttpClient } from '@angular/common/http';
import type { TranslationObject } from '@ngx-translate/core';
import { TranslateLoader } from '@ngx-translate/core';
import { Observable } from 'rxjs';

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
      return http.get<TranslationObject>(`i18n/${lang}.json?v=${Date.now()}`);
    },
  };
}

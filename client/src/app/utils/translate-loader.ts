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
      return http.get<TranslationObject>(`/i18n/${lang}.json?v=${Date.now()}`);
    },
  };
}

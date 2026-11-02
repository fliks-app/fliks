import { provideZonelessChangeDetection, type EnvironmentProviders, type Provider } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';

/** Providers shared by the book work page specs: missing keys render as themselves. */
export function bookSpecProviders(...extra: Provider[]): (Provider | EnvironmentProviders)[] {
  return [
    provideZonelessChangeDetection(),
    provideRouter([]),
    provideHttpClient(),
    provideHttpClientTesting(),
    provideTranslateService({
      lang: 'en',
      loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
    }),
    ...extra,
  ];
}

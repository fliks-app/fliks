import {
  ApplicationConfig,
  isDevMode,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { provideServiceWorker } from '@angular/service-worker';
import { provideRouter, withInMemoryScrolling, withViewTransitions } from '@angular/router';
import { HttpBackend, provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { routes } from './app.routes';
import { serverUrlInterceptor } from './core/interceptors/server-url.interceptor';
import { credentialsInterceptor } from './core/interceptors/credentials.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { cacheInterceptor } from './core/interceptors/cache.interceptor';
import { translateBrowserLoaderFactory } from './utils/translate-loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(
      routes,
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
      // Enables document.startViewTransition() around every navigation. Browsers
      // without VT support (Safari < 18, iOS WebKit) get a no-op fallback —
      // Angular feature-detects internally. Combined with view-transition-name
      // on the card poster + the matching detail-page hero, this morphs the
      // poster between list and detail rather than cross-fading the page.
      withViewTransitions(),
    ),
    provideHttpClient(
      // cacheInterceptor must run BEFORE serverUrlInterceptor: the cache keys on
      // logical paths (/api/...). Once serverUrl rewrites them to absolute URLs
      // (native), every startsWith('/api/...') check inside the cache misses,
      // so on native nothing was cached and invalidation never fired.
      withInterceptors([cacheInterceptor, serverUrlInterceptor, credentialsInterceptor, errorInterceptor]),
    ),
    provideTranslateService({
      loader: {
        provide: TranslateLoader,
        useFactory: translateBrowserLoaderFactory,
        deps: [HttpBackend],
      },
      lang: 'fr',
      fallbackLang: 'fr',
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode() && Capacitor.getPlatform() === 'web',
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};

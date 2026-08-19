import {
  ApplicationConfig,
  inject,
  isDevMode,
  LOCALE_ID,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEn from '@angular/common/locales/en';
import localeFr from '@angular/common/locales/fr';
import localeEs from '@angular/common/locales/es';
import localeDe from '@angular/common/locales/de';
import localeIt from '@angular/common/locales/it';
import localePt from '@angular/common/locales/pt';
import { Capacitor } from '@capacitor/core';
import { provideServiceWorker } from '@angular/service-worker';
import { provideRouter, RouteReuseStrategy, withInMemoryScrolling, withViewTransitions } from '@angular/router';
import { HttpBackend, provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';

// Register CLDR data for every shipped UI language so DatePipe / DecimalPipe /
// CurrencyPipe honour the active locale (resolved below) instead of the Angular
// default. Registration is idempotent on Angular's side.
[localeEn, localeFr, localeEs, localeDe, localeIt, localePt].forEach(
  registerLocaleData,
);
import { routes } from './app.routes';
import { resolveInitialLocale, DEFAULT_LOCALE } from './core/constants/app-locale';
import { serverUrlInterceptor } from './core/interceptors/server-url.interceptor';
import { credentialsInterceptor } from './core/interceptors/credentials.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { cacheInterceptor } from './core/interceptors/cache.interceptor';
import { CachingReuseStrategy } from './core/services/route-reuse.strategy';
import { AuthService } from './core/services/auth.service';
import { ServerConfigService } from './core/services/server-config.service';
import { SessionStoreService } from './core/services/session-store.service';
import { translateBrowserLoaderFactory } from './utils/translate-loader';
import { PluginUiRegistryService } from './core/plugin-ui/plugin-ui-registry.service';
import { PluginI18nService } from './core/plugin-ui/plugin-i18n.service';

/** Read the persisted server URL, sessions and credentials before bootstrap:
 *  guards, interceptors and the first /auth/me all depend on them. Resolves
 *  even on a storage failure, or the app would never leave its splash screen.
 *  The plugin UI registry loads last — it needs the session for the
 *  authenticated request, and it fails open internally so it can never
 *  delay this past its own short timeout. */
export function loadPersistedState(): Promise<unknown> {
  const serverConfig = inject(ServerConfigService);
  const sessions = inject(SessionStoreService);
  const auth = inject(AuthService);
  const pluginUi = inject(PluginUiRegistryService);
  const pluginI18n = inject(PluginI18nService);
  return Promise.all([serverConfig.load(), sessions.load()])
    .then(() => void auth.loadPersistedSession())
    .then(() => pluginUi.load())
    .then(() => pluginI18n.init())
    .catch(() => undefined);
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideAppInitializer(loadPersistedState),
    { provide: LOCALE_ID, useFactory: resolveInitialLocale },
    provideRouter(
      routes,
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
      // Poster→hero morph. Off on Capacitor: its WebView never completes a snapshot
      // capture for a launch-created document, so every navigation waits Chrome's 4s timeout.
      ...(Capacitor.isNativePlatform() ? [] : [withViewTransitions()]),
    ),
    { provide: RouteReuseStrategy, useExisting: CachingReuseStrategy },
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
      lang: resolveInitialLocale(),
      fallbackLang: DEFAULT_LOCALE,
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode() && Capacitor.getPlatform() === 'web',
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};

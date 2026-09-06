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
import {
  provideRouter,
  RouteReuseStrategy,
  withInMemoryScrolling,
  withRouterConfig,
  withViewTransitions,
} from '@angular/router';
import { detectDevice, viewTransitionsEnabled } from './core/services/device.service';
import { HttpBackend, provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';

// Register CLDR data for every shipped UI language so DatePipe / DecimalPipe /
// CurrencyPipe honour the active locale (resolved below) instead of the Angular
// default. Registration is idempotent on Angular's side.
[localeEn, localeFr, localeEs, localeDe, localeIt, localePt].forEach(registerLocaleData);
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
import { ImageCacheService } from './core/services/image-cache.service';
import {
  clearStalePosterStamps,
  enteringPosterPage,
  leavingPosterPage,
  leafRoutePath,
  markViewTransition,
  stampChromeInsets,
  WATCH_PATH,
} from './shared/utils/view-transition';

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
  const imageCache = inject(ImageCacheService);
  return Promise.all([serverConfig.load(), sessions.load(), imageCache.warm()])
    .then(() => void auth.loadPersistedSession())
    .then(() => pluginUi.load())
    .then(() => pluginI18n.init())
    .catch(() => undefined);
}

const EPISODE_PATH = 'series/:id/episode/:episodeId';
const PLAYER_CLOSE_CLASS = 'vt-player-close';
const POSTER_IN_CLASS = 'vt-poster-in';
const POSTER_OUT_CLASS = 'vt-poster-out';
const NATIVE_PLAYER_CLASS = 'native-player-active';
const IS_TV = detectDevice().formFactor === 'tv';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideAppInitializer(loadPersistedState),
    { provide: LOCALE_ID, useFactory: resolveInitialLocale },
    provideRouter(
      routes,
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
      // A route reads its own params only; an ancestor's are not inherited.
      withRouterConfig({ paramsInheritanceStrategy: 'emptyOnly' }),
      // Poster→hero morph. On TV the root snapshot costs ~400 ms on a Tizen 9
      // panel, so only the player close earns one.
      ...(!viewTransitionsEnabled()
        ? []
        : [
            withViewTransitions({
              // The launch navigation has no previous page to morph from, and its
              // snapshot capture never completes under Capacitor's splash: `ready`
              // rejects on Chromium's 4 s timeout, and the splash only hides once
              // the navigation does.
              skipInitialTransition: true,
              // Episode → episode: the cross-fade keeps the old page (and its scroll
              // offset) on screen, so the jump to top only lands once it ends.
              onViewTransitionCreated: ({ transition, from, to }) => {
                const closingPlayer =
                  leafRoutePath(from) === WATCH_PATH && leafRoutePath(to) !== WATCH_PATH;
                // A native surface renders outside the WebView, and the class that
                // lets it through has made every layer transparent — the old
                // snapshot is an empty rectangle, so animating it paints black over
                // the destination.
                if (
                  closingPlayer &&
                  document.documentElement.classList.contains(NATIVE_PLAYER_CLASS)
                ) {
                  transition.skipTransition();
                  return;
                }
                // Skipping here is free: Angular calls this synchronously, before the
                // rendering opportunity that captures the old state.
                if (IS_TV && !closingPlayer) {
                  transition.skipTransition();
                  return;
                }
                if (leafRoutePath(from) === EPISODE_PATH && leafRoutePath(to) === EPISODE_PATH) {
                  transition.skipTransition();
                  return;
                }
                // A stamp outlives its navigation so the back morph can pair it.
                clearStalePosterStamps(from, to);
                // Leaving the player is the one navigation that re-enables the
                // root pair: the closing player has to shrink over the page
                // behind it, which only exists inside the transition.
                if (closingPlayer) {
                  const root = document.documentElement;
                  root.classList.add(PLAYER_CLOSE_CLASS);
                  const done = () => root.classList.remove(PLAYER_CLOSE_CLASS);
                  void transition.finished.then(done, done);
                }
                // The morph is tuned per direction: the box grows into a
                // poster one way and collapses onto a card the other.
                const posterTrip =
                  (leavingPosterPage(from, to) && POSTER_OUT_CLASS) ||
                  (enteringPosterPage(from, to) && POSTER_IN_CLASS);
                if (posterTrip) {
                  const root = document.documentElement;
                  stampChromeInsets();
                  root.classList.add(posterTrip);
                  const done = () => root.classList.remove(posterTrip);
                  void transition.finished.then(done, done);
                }
                markViewTransition(transition);
              },
            }),
          ]),
    ),
    { provide: RouteReuseStrategy, useExisting: CachingReuseStrategy },
    provideHttpClient(
      withXhr(),
      // cacheInterceptor must run BEFORE serverUrlInterceptor: the cache keys on
      // logical paths (/api/...). Once serverUrl rewrites them to absolute URLs
      // (native), every startsWith('/api/...') check inside the cache misses,
      // so on native nothing was cached and invalidation never fired.
      withInterceptors([
        cacheInterceptor,
        serverUrlInterceptor,
        credentialsInterceptor,
        errorInterceptor,
      ]),
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

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
  Router,
  RouteReuseStrategy,
  withInMemoryScrolling,
  withRouterConfig,
  withViewTransitions,
} from '@angular/router';
import { detectDevice, viewTransitionsEnabled } from './core/services/device.service';
import { HttpBackend, provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';

// CLDR data for every shipped UI language so Date/Decimal/Currency pipes honour the active locale.
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
  classUntilDone,
  clearStalePosterStamps,
  betweenPosterPages,
  enteringPosterPage,
  hasPosterStamp,
  leafRoutePath,
  leavingPosterPage,
  markViewTransition,
  muteHeroUntilDone,
  swipeBackActive,
  WATCH_PATH,
} from './shared/utils/view-transition';
import {
  confirmPush,
  consumeArmed,
  goingBack,
  nextSlide,
  pageSlideAvailable,
  releaseStackedPop,
  resetStack,
  slidePage,
} from './shared/utils/page-slide';

/** Reads the persisted server URL, sessions and credentials before bootstrap; resolves even on storage failure or the splash never ends.
 * The plugin UI registry loads last (needs the session) and fails open within its own short timeout. */
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

const PLAYER_CLOSE_CLASS = 'vt-player-close';
const POSTER_IN_CLASS = 'vt-poster-in';
const POSTER_OUT_CLASS = 'vt-poster-out';
const NATIVE_PLAYER_CLASS = 'native-player-active';
const IS_TV = detectDevice().formFactor === 'tv';
// The desktop shell composites video under its UI bitmap, so an empty snapshot reveals the frame; phone/TV surfaces reveal black.
const IS_DESKTOP_SHELL =
  typeof window !== 'undefined' &&
  (!!window.fliksDesktop || /\bElectron\//.test(navigator.userAgent));

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
              // No previous page to morph from, and the snapshot never completes under Capacitor's splash (`ready` rejects after 4 s), which holds the splash.
              skipInitialTransition: true,
              // Picks the animation per navigation (player's own, poster morph, stack slide) and drops the transition if none applies.
              onViewTransitionCreated: ({ transition, from, to }) => {
                // getCurrentNavigation(), not history.state: with deferred URL update the browser state isn't swapped in yet.
                // Also true on a popstate back to a root page, which flattens the stack too.
                const rootEntry =
                  !!inject(Router).getCurrentNavigation()?.extras.state?.['rootEntry'];
                // Consumed before any guard can return early and strand it; root chrome switches root, so it spends the arming without using it.
                const armed = consumeArmed() && !rootEntry;
                if (rootEntry) resetStack();
                // The native gesture already animated the trip; settle its pop before any guard returns early (backgrounding mid-gesture included).
                if (swipeBackActive()) releaseStackedPop(from, to);
                // A transition begun while backgrounded can resume on the next dock tap.
                if (document.hidden) {
                  // Still a trip back: spend its pop as nextSlide would have.
                  const watchPair =
                    leafRoutePath(from) === WATCH_PATH || leafRoutePath(to) === WATCH_PATH;
                  if (!swipeBackActive() && !watchPair) releaseStackedPop(from, to);
                  transition.skipTransition();
                  return;
                }
                if (swipeBackActive()) {
                  transition.skipTransition();
                  return;
                }
                const closingPlayer =
                  leafRoutePath(from) === WATCH_PATH && leafRoutePath(to) !== WATCH_PATH;
                // Native surfaces render outside the WebView under a class making every layer transparent, so the old snapshot is empty and would paint black.
                if (
                  closingPlayer &&
                  !IS_DESKTOP_SHELL &&
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
                // Opening the player animates itself and the root pair is off; skip, keeping the stamp the back morph pairs with.
                if (leafRoutePath(to) === WATCH_PATH) {
                  transition.skipTransition();
                  return;
                }
                // A stamp outlives its navigation so the back morph can pair it.
                clearStalePosterStamps(from, to);
                // Leaving the player re-enables the root pair: the closing player must shrink over the page behind it.
                if (closingPlayer) classUntilDone(transition, PLAYER_CLOSE_CLASS);
                // Morph is tuned per direction. For a card opening its poster-page sibling the stack slides that pair, else the morph;
                // the stamp tells it from a rail whose links open the page they sit on.
                const sibling =
                  betweenPosterPages(from, to) && !pageSlideAvailable() && hasPosterStamp();
                const posterTrip =
                  ((leavingPosterPage(from, to) || (sibling && goingBack())) &&
                    POSTER_OUT_CLASS) ||
                  ((enteringPosterPage(from, to) || sibling) && POSTER_IN_CLASS);
                if (posterTrip) classUntilDone(transition, posterTrip);
                // Going the other way the hero is the half the stamped card
                // pairs with, so only the trip in may take its name away.
                if (sibling && !goingBack()) muteHeroUntilDone(transition);
                // What a pair with no morph of its own gets: the pages stack.
                const direction = nextSlide(from, to, armed, !!posterTrip);
                const slid = !!direction && slidePage(transition, direction);
                // Counted only once its slide actually ran, or a push skipped
                // for want of a dock would owe a pop that never showed.
                if (direction === 'push') confirmPush(slid);
                // Nothing would move, yet a transition would cross-fade each named hero against itself and hold the page swap behind snapshots.
                if (!posterTrip && !closingPlayer && !slid) {
                  transition.skipTransition();
                  return;
                }
                markViewTransition(transition);
              },
            }),
          ]),
    ),
    { provide: RouteReuseStrategy, useExisting: CachingReuseStrategy },
    provideHttpClient(
      withXhr(),
      // cacheInterceptor must run BEFORE serverUrlInterceptor: the cache keys on logical /api/... paths, which serverUrl rewrites to absolute URLs on native.
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

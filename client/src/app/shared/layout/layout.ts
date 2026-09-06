import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  effect,
  OnInit,
  OnDestroy,
  DestroyRef,
  viewChild,
  ElementRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { RouterLink, RouterLinkActive, RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { LibraryPrefsService } from '../../core/services/library-prefs.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { CountsApiService } from '../../core/services/api/counts-api.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { SseService } from '../../core/services/sse.service';
import { CastService } from '../../core/services/cast.service';
import { RemoteService } from '../../core/services/remote.service';
import { NavbarService } from '../../core/services/navbar.service';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { NavigationHistoryService } from '../../core/services/navigation-history.service';
import { NetworkService } from '../../core/services/network.service';
import { CardActionsPanelComponent } from '../components/card-actions-panel/card-actions-panel';
import { AddToPlaylistModalComponent } from '../components/add-to-playlist-modal/add-to-playlist-modal.component';
import { RecommendModalComponent } from '../components/recommend-modal/recommend-modal.component';
import { IdentifyModalHostComponent } from '../components/identify-modal-host/identify-modal-host';
import { TrackingModalHostComponent } from '../components/tracking-modal-host/tracking-modal-host';
import { UserMenuComponent } from '../components/user-menu';
import { AppUpdateModalComponent } from '../components/app-update-modal/app-update-modal';
import { AppUpdateService } from '../../core/services/app-update.service';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { RecommendService } from '../../core/services/recommend.service';
import { LucideIconComponent } from '../components/lucide-icon';
import { TvRowDirective } from '../directives/tv-row.directive';
import { BackgroundComponent } from '../components/background/background';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { BackgroundService } from '../../core/services/background.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { NavContributionsService, DOCK_PINNED_IDS, MOBILE_HIDDEN_IDS, type ResolvedNavItem } from '../../core/plugin-ui/nav-contributions.service';
import { NavIconComponent } from './nav-icon';
import { CachedSrcDirective } from '../directives/cached-src.directive';
import { remoteOverlayOpen } from '../../core/services/remote-playback-target';
import { RemotePickerComponent } from '../remote-picker/remote-picker';
import { parseDeviceLabel } from '../../core/utils/format-device-label';
import {
  LucideMenu,
  LucideChevronLeft,
  LucideSearch,
  LucideCast,
  LucideEllipsisVertical,
  LucidePin,
  LucideRocket,
} from '@lucide/angular';


/** Coalesces a burst of count-bearing SSE events (e.g. a season-pack import) into one request. */
const SIDEBAR_COUNTS_DEBOUNCE_MS = 400;

@Component({
  selector: 'app-layout',
  imports: [
    CachedSrcDirective,
    RouterOutlet, RouterLink, RouterLinkActive, TranslatePipe,
    LucideMenu, LucideChevronLeft, LucideSearch, LucideCast, LucideEllipsisVertical, LucidePin, LucideRocket,
    RemotePickerComponent,
    CardActionsPanelComponent,
    AddToPlaylistModalComponent,
    RecommendModalComponent,
    TrackingModalHostComponent,
    IdentifyModalHostComponent,
    UserMenuComponent,
    AppUpdateModalComponent,
    LucideIconComponent,
    NavIconComponent,
    TvRowDirective,
    BackgroundComponent,
    ResolveUrlPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './layout.html',
})
export class LayoutComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly libraryPrefs = inject(LibraryPrefsService);
  private readonly countsApi = inject(CountsApiService);
  readonly serverConfig = inject(ServerConfigService);
  private readonly sse = inject(SseService);
  private readonly downloadManager = inject(DownloadManagerService);
  // Instantiate eagerly from the shell so it records the page the user was on
  // BEFORE the first player open. It is `providedIn: 'root'` but otherwise only
  // injected by the player, which is created too late (during the → /watch nav)
  // to observe the launching page — leaving the player's onBack without a
  // previousUrl on the first play and forcing a replaceUrl that strands a
  // history entry (back button then needs two presses to leave the detail page).
  private readonly navHistory = inject(NavigationHistoryService);
  private readonly addToPlaylistSvc = inject(AddToPlaylistService);
  private readonly addToPlaylistModal = viewChild(AddToPlaylistModalComponent);
  // Bridge the global "add to playlist" requests (from cards / the media-detail
  // header) to the single modal instance mounted in the layout. The request is
  // consumed (cleared) once handed over, so it can't reopen the modal when this
  // layout is re-created — e.g. after exiting the player, which lives on a route
  // OUTSIDE this shell, so the shell is destroyed on play and rebuilt on exit.
  private readonly addToPlaylistBridge = effect(() => {
    const req = this.addToPlaylistSvc.request();
    const modal = this.addToPlaylistModal();
    if (req && modal) {
      this.addToPlaylistSvc.clear();
      modal.open(req.target);
    }
  });
  private readonly recommendSvc = inject(RecommendService);
  private readonly recommendModal = viewChild(RecommendModalComponent);
  // Bridge the global "recommend to a member" requests to the layout modal.
  private readonly recommendBridge = effect(() => {
    const req = this.recommendSvc.request();
    const modal = this.recommendModal();
    if (req && modal) {
      this.recommendSvc.clear();
      void modal.open(req.target);
    }
  });
  readonly networkService = inject(NetworkService);
  readonly castService = inject(CastService);
  readonly remote = inject(RemoteService);
  readonly navbar = inject(NavbarService);
  readonly background = inject(BackgroundService);
  private readonly searchState = inject(SearchStateService);
  readonly tv = inject(TvService);
  readonly device = inject(DeviceService);
  readonly castPlayer = inject(CastPlayerService);
  readonly appUpdate = inject(AppUpdateService);
  private readonly updateModal = viewChild(AppUpdateModalComponent);
  private readonly title = inject(Title);

  openUpdateModal(): void {
    this.updateModal()?.open();
  }
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  /** Bumps when language changes so the document title effect re-reads `app.name`. */
  private readonly langTick = signal(0);
  readonly canGoBack = this.navbar.canGoBack;

  readonly isNative = Capacitor.isNativePlatform();
  private readonly topSentinel = viewChild<ElementRef<HTMLElement>>('topSentinel');
  readonly bottomMenuOpen = signal(false);
  readonly keyboardOpen = signal(false);
  readonly navbarHidden = signal(false);
  readonly navbarTransparent = this.navbar.navbarTransparent;
  /** The hero logo URL whose image failed to load. The backend can hand back a
   *  logo path for media whose file was never stored (or got cleaned up), so
   *  the URL is truthy but 404s — fall back to the title instead of a broken
   *  image. Keyed by URL so it resets automatically on the next hero page. */
  private readonly failedHeroLogoUrl = signal<string | null>(null);
  readonly showHeroLogo = computed(
    () => !!this.navbar.heroLogoUrl() && this.failedHeroLogoUrl() !== this.navbar.heroLogoUrl(),
  );
  onHeroLogoError(): void {
    this.failedHeroLogoUrl.set(this.navbar.heroLogoUrl());
  }
  readonly isHomeRoute = signal(this.router.url === '/' || this.router.url.startsWith('/?'));

  // Sync Android status bar icons with navbar state. App is dark-only, so the
  // bar gets dark icons (light=true) only when the navbar is fully visible
  // (non-transparent) and would otherwise blend with white text on its own
  // dark bg — which is never the case here, hence always light=false.
  private readonly statusBarEffect = Capacitor.isNativePlatform() ? effect(() => {
    // Read the signal so the effect re-runs when transparency flips, in case
    // future code wants to react to it.
    void this.navbarTransparent();
    const Immersive = registerPlugin<any>('Immersive');
    Immersive.setLightStatusBar({ light: false }).catch(() => {});
  }) : null;

  private readonly documentTitleEffect = effect(() => {
    this.langTick();
    const main = this.navbar.mobileNavTitle();
    if (!main) return;
    this.title.setTitle(`${main} · ${this.translate.instant('app.name')}`);
  });
  private lastScrollY = 0;
  private scrollRaf: number | null = null;
  private topSentinelObserver?: IntersectionObserver;
  /** TV never hides the navbar, so the scroll handler would exist only to
   *  recompute `scrollAtTop` — and reading `scrollY` flushes whatever layout
   *  the frame has dirtied, which on a windowed library grid is a relayout of
   *  a 60 000 px document. The sentinel below reports the same thing with no
   *  layout read at all, so the handler is skipped there entirely. */
  private readonly onScroll = () => {
    if (this.device.isTv() || this.scrollRaf !== null) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = null;
      this.readScroll();
    });
  };
  private readScroll(): void {
    const y = window.scrollY;
    this.navbar.scrollAtTop.set(y < 20);
    if (Math.abs(y - this.lastScrollY) < 10) return;
    // TV keeps the topbar anchored — it is a D-pad target, and sliding it out
    // from under the focus ring strands the cursor.
    this.navbarHidden.set(y > this.lastScrollY && y > 56);
    this.lastScrollY = y;
  }

  /** `scrollAtTop` without touching the scroll position: a zero-width strip
   *  pinned to the top of the page, watched by an IntersectionObserver. */
  private watchTopSentinel(): void {
    const el = this.topSentinel()?.nativeElement;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    this.topSentinelObserver = new IntersectionObserver(
      ([entry]) => this.navbar.scrollAtTop.set(entry.isIntersecting),
    );
    this.topSentinelObserver.observe(el);
  }

  /** Accessible libraries for the sidebar (raw, as fetched). */
  readonly libraries = signal<LibrarySummary[]>([]);
  /** Sidebar-facing list: the user's chosen order with hidden ones removed. */
  readonly displayLibraries = computed(() =>
    this.libraryPrefs.present(this.libraries()),
  );
  /** Libraries excluding the default Films / Séries — those have their own
   *  shortcut elsewhere (or are deliberately omitted from the mobile More
   *  menu to keep it short). Custom libraries (Anime, Docs, …) stay. */
  readonly customLibraries = computed(() =>
    this.displayLibraries().filter(
      (lib) => !lib.isDefaultForMovies && !lib.isDefaultForSeries,
    ),
  );
  /** Media count per library ID. */
  readonly libraryCounts = signal<Record<number, number>>({});
  /** Badge counts by contribution `badgeKey` — the API's `badgeCounts` map
   *  plus `pendingRequests` folded in, so lookup stays one generic line. */
  readonly badgeCounts = signal<Record<string, number>>({});

  private readonly navContrib = inject(NavContributionsService);
  /** `nav.main` items before/after the library block, and `nav.acquisition` —
   *  the sidebar, the phone dock and the more-sheet all read these same lists. */
  readonly mainItemsBeforeLibraries = this.navContrib.mainItemsBeforeLibraries;
  readonly mainItemsAfterLibraries = this.navContrib.mainItemsAfterLibraries;
  readonly acquisitionItems = this.navContrib.acquisitionItems;
  readonly dockHome = computed(() => this.mainItemsBeforeLibraries().find((i) => i.id === 'core.home'));
  readonly dockDownloads = computed(() => this.mainItemsAfterLibraries().find((i) => i.id === 'core.downloads'));
  readonly dockRequests = computed(() => this.acquisitionItems().find((i) => i.id === 'core.requests'));
  /** Everything not pinned to the dock's primary row — the more-sheet's content,
   *  so a plugin item always reaches at least one native-phone surface. */
  readonly sheetMainItems = computed(() =>
    [...this.mainItemsBeforeLibraries(), ...this.mainItemsAfterLibraries()].filter(
      (i) => !DOCK_PINNED_IDS.includes(i.id) && !MOBILE_HIDDEN_IDS.includes(i.id),
    ),
  );
  readonly sheetAcquisitionItems = computed(() =>
    this.acquisitionItems().filter((i) => !DOCK_PINNED_IDS.includes(i.id)),
  );

  /** Looks up a contribution's badge count by its declared key, whatever
   *  publisher (core or a plugin) it came from. Absent means no badge. */
  badgeCountFor(item: ResolvedNavItem): number {
    return (item.badgeKey && this.badgeCounts()[item.badgeKey]) || 0;
  }

  private sidebarCountsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Refresh counts when relevant SSE events arrive */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    if (!event) return;
    switch (event.type) {
      // import.complete / import.failed are user-targeted (only the requester
      // receives them), so library counts ride the broadcast queue.updated that
      // follows every import — otherwise non-requesters' sidebars go stale.
      case 'queue.updated':
      case 'stalled.removed':
      case 'request.approved':
      case 'request.declined':
        this.debouncedRefreshSidebarCounts();
        break;
    }
  });

  ngOnInit() {
    if (navigator.onLine) {
      this.refreshCounts();
    } else {
      window.addEventListener('online', () => {
        this.refreshCounts();
      }, { once: true });
    }
    if (this.device.isTv()) {
      console.debug('[layout] remote-control entry point suppressed on tv: no controller UI on the 10-foot surface');
    }
    // DownloadManagerService is activated by injection (effect in constructor)
    window.addEventListener('scroll', this.onScroll, { passive: true });
    this.watchTopSentinel();
    if (this.isNative) {
      Keyboard.addListener('keyboardWillShow', () => this.keyboardOpen.set(true));
      Keyboard.addListener('keyboardWillHide', () => this.keyboardOpen.set(false));
    }
    this.translate.onLangChange.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.langTick.update((n) => n + 1);
      this.syncNavbarTitleFromRoute();
    });
    this.router.events
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(e => {
        if (e instanceof NavigationEnd) {
          this.replayPageEnter();
          this.bottomMenuOpen.set(false);
          this.isHomeRoute.set(e.urlAfterRedirects === '/' || e.urlAfterRedirects.startsWith('/?'));
          this.syncNavbarTitleFromRoute();
        }
      });
    this.syncNavbarTitleFromRoute();
  }

  /** Restart the page-enter animation. Re-adding the class a frame later is
   *  what lets the same animation run again — reading a layout property to
   *  force the reflow synchronously costs a full-document relayout, which on
   *  a long library page lands right where the spinner should stay smooth. */
  private replayPageEnter(): void {
    if (!this.device.isTv()) return;
    const main = document.querySelector('main');
    if (!main) return;
    main.classList.remove('page-enter');
    requestAnimationFrame(() => main.classList.add('page-enter'));
  }

  /**
   * Applies `data.titleKey` from the deepest activated route (skipped on hero pages).
   * Routes without `titleKey` manage their own title via NavbarService (set in ngOnInit,
   * cleared in ngOnDestroy) — so we don't clear here, otherwise component-set titles get
   * wiped by the NavigationEnd that fires right after their setPageTitle call.
   */
  private syncNavbarTitleFromRoute() {
    let key: string | undefined;
    let r = this.router.routerState.snapshot.root;
    while (r.firstChild) {
      r = r.firstChild;
      if (r.data['titleKey']) key = r.data['titleKey'] as string;
    }
    if (this.navbar.isHeroPage()) return;
    if (key) this.navbar.setPageTitle(this.translate.instant(key));
  }

  ngOnDestroy() {
    window.removeEventListener('scroll', this.onScroll);
    if (this.scrollRaf !== null) cancelAnimationFrame(this.scrollRaf);
    this.topSentinelObserver?.disconnect();
    if (this.isNative) {
      Keyboard.removeAllListeners();
    }
    if (this.sidebarCountsDebounceTimer) clearTimeout(this.sidebarCountsDebounceTimer);
  }

  async refreshCounts() {
    try {
      const [libs, counts] = await Promise.all([
        this.librariesApi.listMine(),
        this.countsApi.get(),
      ]);
      this.libraries.set(libs);
      this.libraryCounts.set(counts.mediaByLibrary);
      this.badgeCounts.set({ ...counts.badgeCounts, pendingRequests: counts.pendingRequests });
    } catch {
      // silently ignore — counts are non-critical
    }
  }

  /** Refreshes the badge counts only (no library list re-fetch) — the SSE
   *  handlers ride this for every count-bearing event. */
  private async refreshSidebarCounts() {
    try {
      const counts = await this.countsApi.get();
      this.libraryCounts.set(counts.mediaByLibrary);
      this.badgeCounts.set({ ...counts.badgeCounts, pendingRequests: counts.pendingRequests });
    } catch { /* ignore */ }
  }

  /** Trailing debounce so a burst of SSE events (a season pack importing many
   *  episodes) collapses into a single request, keeping only the final state. */
  private debouncedRefreshSidebarCounts(): void {
    if (this.sidebarCountsDebounceTimer) clearTimeout(this.sidebarCountsDebounceTimer);
    this.sidebarCountsDebounceTimer = setTimeout(() => {
      this.sidebarCountsDebounceTimer = null;
      void this.refreshSidebarCounts();
    }, SIDEBAR_COUNTS_DEBOUNCE_MS);
  }

  libraryUrl(lib: LibrarySummary): string {
    return `/libraries/${encodeURIComponent(lib.name)}`;
  }

  /** Icon key for a library: explicit icon > default 'library'. */
  libraryIcon(lib: LibrarySummary): string {
    return lib.icon || 'library';
  }



  resetNavHistory() {
    this.navbar.resetNavHistory();
  }

  /** Bottom-dock search button: same-route click should re-focus the
   *  input and re-open the soft keyboard. The default Router behaviour
   *  no-ops on a same-URL navigation, so the click handler signals the
   *  search page via {@link SearchStateService.requestFocus}. */
  onSearchNavClick(): void {
    if (this.router.url.split('?')[0] === '/search') {
      // Already on search: re-focus the input (re-open the keyboard). No
      // navigation happens, so we must NOT resetNavHistory() here — its
      // isPoppingBack flag would linger with nothing to consume it and then
      // swallow the history push of the next navigation (tapping a result),
      // leaving that page with no back arrow / dead back gesture.
      this.searchState.requestFocus();
      return;
    }
    // Navigating to search fresh — a top-level dock entry, so clear the stack.
    this.resetNavHistory();
  }

  toggleBottomMenu() {
    this.bottomMenuOpen.update(v => !v);
  }

  goBack() {
    this.navbar.goBack();
  }

  retryConnection() {
    window.location.reload();
  }

  toggleCastOverlay() {
    this.castPlayer.expanded.update(v => !v);
  }

  /** Mirrors `toggleCastOverlay`: the chip shown once a remote target is
   *  already selected opens its control card, not the device picker. */
  toggleRemoteControlOverlay(): void {
    remoteOverlayOpen.update(v => !v);
  }

  formatDevice(
    ua: string | null | undefined,
    systemName?: string | null,
    deviceName?: string | null,
  ): string {
    const label = parseDeviceLabel(ua ?? null, systemName, deviceName);
    return label ? this.translate.instant(label.key, label.params) : '';
  }
}

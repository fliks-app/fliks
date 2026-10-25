import { fromEvent, startWith } from 'rxjs';
import {
  Component,
  inject,
  signal,
  computed,
  effect,
  untracked,
  OnInit,
  OnDestroy,
  DestroyRef,
  viewChild,
  ElementRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { RouterLink, RouterLinkActive, RouterOutlet, Router, NavigationEnd, Scroll } from '@angular/router';
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
import { AirPlayService } from '../../core/services/airplay.service';
import { RemoteService } from '../../core/services/remote.service';
import { NavbarService } from '../../core/services/navbar.service';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { NavigationHistoryService } from '../../core/services/navigation-history.service';
import { NetworkService } from '../../core/services/network.service';
import { PageScrollerService } from '../../core/services/page-scroller.service';
import { CardActionsPanelComponent } from '../components/card-actions-panel/card-actions-panel';
import { AddToPlaylistModalComponent } from '../components/add-to-playlist-modal/add-to-playlist-modal.component';
import { PartyCreateModalComponent } from '../../features/party/party-create-modal';
import { RecommendModalComponent } from '../components/recommend-modal/recommend-modal.component';
import { IdentifyModalHostComponent } from '../components/identify-modal-host/identify-modal-host';
import { TrackingModalHostComponent } from '../components/tracking-modal-host/tracking-modal-host';
import { UserMenuComponent } from '../components/user-menu';
import { AppUpdateModalComponent } from '../components/app-update-modal/app-update-modal';
import { AppUpdateService } from '../../core/services/app-update.service';
import { AppResumeService } from '../../core/services/app-resume.service';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { RecommendService } from '../../core/services/recommend.service';
import { LucideIconComponent } from '../components/lucide-icon';
import { TvRowDirective } from '../directives/tv-row.directive';
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
  LucideCloudOff,
  LucideDownload,
  LucideRotateCw,
} from '@lucide/angular';


/** Coalesces a burst of count-bearing SSE events (e.g. a season-pack import) into one request. */
const SIDEBAR_COUNTS_DEBOUNCE_MS = 400;

@Component({
  selector: 'app-layout',
  imports: [
    CachedSrcDirective,
    RouterOutlet, RouterLink, RouterLinkActive, TranslatePipe,
    LucideMenu, LucideChevronLeft, LucideSearch, LucideCast, LucideEllipsisVertical, LucidePin, LucideRocket,
    LucideCloudOff, LucideDownload, LucideRotateCw,
    RemotePickerComponent,
    CardActionsPanelComponent,
    AddToPlaylistModalComponent,
    RecommendModalComponent,
    PartyCreateModalComponent,
    TrackingModalHostComponent,
    IdentifyModalHostComponent,
    UserMenuComponent,
    AppUpdateModalComponent,
    LucideIconComponent,
    NavIconComponent,
    TvRowDirective,
    ResolveUrlPipe,
  ],
  templateUrl: './layout.html',
})
export class LayoutComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly libraryPrefs = inject(LibraryPrefsService);
  private readonly countsApi = inject(CountsApiService);
  readonly serverConfig = inject(ServerConfigService);
  readonly sse = inject(SseService);
  private readonly appResume = inject(AppResumeService);
  private readonly downloadManager = inject(DownloadManagerService);
  // Instantiate eagerly so it records the launching page BEFORE the player opens (the player injects it too late).
  private readonly navHistory = inject(NavigationHistoryService);
  private readonly addToPlaylistSvc = inject(AddToPlaylistService);
  private readonly addToPlaylistModal = viewChild(AddToPlaylistModalComponent);
  // Bridge global "add to playlist" requests to the modal in this layout; consumed once so a rebuilt shell (player is outside it) doesn't reopen it.
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
  private readonly pageScroller = inject(PageScrollerService);
  readonly networkService = inject(NetworkService);
  readonly castService = inject(CastService);
  readonly airPlay = inject(AirPlayService);
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
  private readonly keyboardClass = effect(() =>
    document.documentElement.classList.toggle('keyboard-open', this.keyboardOpen()),
  );
  readonly navbarHidden = signal(false);
  readonly navbarTransparent = this.navbar.navbarTransparent;
  /** Hero logo URL whose image failed to load (the backend may return a path for a file never stored): fall back to the title. */
  private readonly failedHeroLogoUrl = signal<string | null>(null);
  readonly showHeroLogo = computed(
    () => !!this.navbar.heroLogoUrl() && this.failedHeroLogoUrl() !== this.navbar.heroLogoUrl(),
  );
  onHeroLogoError(): void {
    this.failedHeroLogoUrl.set(this.navbar.heroLogoUrl());
  }
  readonly isHomeRoute = signal(this.router.url === '/' || this.router.url.startsWith('/?'));
  /** The downloads page is where an unreachable server sends you, so it doesn't repeat the warning. */
  readonly isDownloadsRoute = signal(this.router.url.split('?')[0] === '/downloads');

  /** Fixed navbar's own clearance: height (0 on TV) plus safe area; 0 where the mobile navbar is hidden.
   *  Hero-blind on purpose: `body.hero-page` (styles.css) applies synchronously, a later value lets iOS 18.7 never re-lay out a cached page. */
  private readonly navbarSpacerHeight = computed(() => {
    if (!this.navbar.mobileNavbarVisible()) return '0px';
    if (this.tv.isTv()) return '0px';
    return 'calc(3rem + env(safe-area-inset-top, 0px))';
  });
  private readonly contentGapTop = computed(() =>
    !this.isNative && this.navbar.mobileNavbarVisible() ? '2rem' : '1rem',
  );
  /** Published as a CSS var so content still scrolls under the fixed navbar. */
  readonly chromeTop = computed(() => `calc(${this.navbarSpacerHeight()} + ${this.contentGapTop()})`);
  /** The 6rem term is the native phone dock's height. */
  readonly chromeBottom = computed(() => {
    const dock = this.isNative && this.device.isPhone() ? '6rem' : '0px';
    return `calc(${dock} + 1rem)`;
  });

  // Android status bar icons: the app is dark-only, so light=false always.
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
  /** Offset past which the bar has scrolled out of the page's top. */
  private static readonly NAVBAR_LEAVES_AT = 56;
  private lastScrollY = 0;
  /** NavigationEnd until the new page's navbar has painted: gates scroll
   *  reads and, bound to the element, its CSS transition. */
  readonly restorePending = signal(false);
  private restoreFallback: ReturnType<typeof setTimeout> | undefined;
  private scrollRaf: number | null = null;
  private topSentinelObserver?: IntersectionObserver;
  /** TV never hides the navbar, so skip the scroll handler: reading the offset forces a layout; the sentinel below reports `scrollAtTop` without it. */
  private readonly onScroll = () => {
    if (this.device.isTv() || this.scrollRaf !== null) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = null;
      this.readScroll();
    });
  };
  private readScroll(): void {
    if (this.restorePending()) return;
    const y = this.pageScroller.offset();
    this.navbar.scrollAtTop.set(y < 20);
    // The bar is a D-pad target: sliding it out from under the focus ring
    // would strand the cursor, so a focus inside it anchors the bar.
    const focusInBar = !!document.activeElement?.closest('nav.navbar');
    if (Math.abs(y - this.lastScrollY) < 10) return;
    this.navbarHidden.set(!focusInBar && y > this.lastScrollY && y > LayoutComponent.NAVBAR_LEAVES_AT);
    this.lastScrollY = y;
  }

  private readonly topSentinelObserverEffect = effect(() => {
    const el = this.topSentinel()?.nativeElement;
    this.topSentinelObserver?.disconnect();
    if (!el || typeof IntersectionObserver === 'undefined') return;
    this.topSentinelObserver = new IntersectionObserver(
      ([entry]) => this.navbar.scrollAtTop.set(entry.isIntersecting),
      { root: null },
    );
    this.topSentinelObserver.observe(el);
  });

  /** Accessible libraries for the sidebar (raw, as fetched). */
  readonly libraries = signal<LibrarySummary[]>([]);
  readonly librariesLoaded = signal(false);
  /** Sidebar-facing list: the user's chosen order with hidden ones removed. */
  readonly displayLibraries = computed(() =>
    this.libraryPrefs.present(this.libraries()),
  );
  /** Media count per library ID. */
  readonly libraryCounts = signal<Record<number, number>>({});
  /** Badge counts by contribution `badgeKey` — the API's `badgeCounts` map
   *  plus `pendingRequests` folded in, so lookup stays one generic line. */
  readonly badgeCounts = signal<Record<string, number>>({});

  private readonly navContrib = inject(NavContributionsService);
  /** `nav.main` items before/after the library block, and `nav.acquisition` —
   *  the sidebar, the phone dock and the more-sheet all read these same lists. */
  /** The TV tab row shows the whole `nav.main` list; the drawer never opens there. */
  readonly tvNavItems = this.navContrib.mainItems;
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
      // import.complete / import.failed reach only the requester, so library counts ride the broadcast queue.updated after each import.
      case 'queue.updated':
      case 'stalled.removed':
      case 'request.approved':
      case 'request.declined':
        this.debouncedRefreshSidebarCounts();
        break;
    }
  });

  // The shell is instantiated once, so ngOnInit's boot fetch never repeats: a
  // reconnect after backgrounding is the only later signal that counts may be stale.
  private readonly reconnectCountsEffect = effect(() => {
    if (!this.sse.connectionId()) return;
    untracked(() => void this.refreshCounts());
  });

  ngOnInit() {
    if (navigator.onLine) {
      this.refreshCounts();
    } else {
      this.librariesLoaded.set(true);
      window.addEventListener('online', () => {
        this.refreshCounts();
      }, { once: true });
    }
    // DownloadManagerService is activated by injection (effect in constructor)
    this.pageScroller.changes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(this.onScroll);
    if (this.isNative) {
      Keyboard.addListener('keyboardWillShow', () => this.keyboardOpen.set(true));
      Keyboard.addListener('keyboardWillHide', () => this.keyboardOpen.set(false));
      // Android's settled state (MainActivity), which the plugin misses when a back
      // gesture over the keyboard is cancelled.
      fromEvent<CustomEvent<{ visible: boolean }>>(window, 'ime')
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((e) => this.keyboardOpen.set(e.detail.visible));
      // The height before the keyboard took its share, for what must hold still over it.
      fromEvent(window, 'resize')
        .pipe(startWith(null), takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          if (this.keyboardOpen()) return;
          document.documentElement.style.setProperty('--keyboard-closed-height', `${window.innerHeight}px`);
        });
    }
    this.translate.onLangChange.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.langTick.update((n) => n + 1);
      this.syncNavbarTitleFromRoute();
    });
    this.router.events
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(e => {
        if (e instanceof Scroll) this.endScrollRestore();
        if (e instanceof NavigationEnd) {
          this.beginScrollRestore();
          this.replayPageEnter();
          this.bottomMenuOpen.set(false);
          this.isHomeRoute.set(e.urlAfterRedirects === '/' || e.urlAfterRedirects.startsWith('/?'));
          this.isDownloadsRoute.set(e.urlAfterRedirects.split('?')[0] === '/downloads');
          this.syncNavbarTitleFromRoute();
        }
      });
    this.syncNavbarTitleFromRoute();
  }

  /** Pages swap before the router restores scroll, so reads in between report the old page: seed the restored state and hold reads. */
  private beginScrollRestore(): void {
    this.restorePending.set(true);
    this.navbarHidden.set(false);
    this.navbar.scrollAtTop.set(true);
    clearTimeout(this.restoreFallback);
    // The router owes us a Scroll event; don't stay deaf to scrolling if it
    // never comes (in-memory scrolling turned off, a skipped navigation).
    this.restoreFallback = setTimeout(() => this.endScrollRestore(), 1000);
  }

  /** Two frames, not now: this runs from the event stream that drives the
   *  scroll, and the navbar must paint the new page once before re-arming. */
  private endScrollRestore(): void {
    if (!this.restorePending()) return;
    clearTimeout(this.restoreFallback);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        this.restorePending.set(false);
        // Adopt the restored offset instead of reading it: against a zero baseline it reads as a scroll down and hides the navbar.
        const y = this.pageScroller.offset();
        this.lastScrollY = y;
        this.navbar.scrollAtTop.set(y < 20);
      }),
    );
  }

  /** Restart the page-enter animation by re-adding the class a frame later; a forced synchronous reflow is a full-document relayout. */
  private replayPageEnter(): void {
    if (!this.device.isTv()) return;
    const main = document.querySelector('main');
    if (!main) return;
    main.classList.remove('page-enter');
    requestAnimationFrame(() => main.classList.add('page-enter'));
  }

  /** Applies `data.titleKey` from the deepest activated route (skipped on hero pages); routes without it set their own title, so don't clear here. */
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
    if (this.scrollRaf !== null) cancelAnimationFrame(this.scrollRaf);
    this.topSentinelObserver?.disconnect();
    if (this.isNative) {
      Keyboard.removeAllListeners();
    }
    if (this.sidebarCountsDebounceTimer) clearTimeout(this.sidebarCountsDebounceTimer);
    clearTimeout(this.restoreFallback);
  }

  async refreshCounts() {
    // The list paints from cache; waiting on the uncached counts lets it drop in late and shift the nav.
    const libs = this.librariesApi
      .listMine()
      .then((l) => this.libraries.set(l), () => undefined)
      .finally(() => this.librariesLoaded.set(true));
    try {
      const counts = await this.countsApi.get();
      this.libraryCounts.set(counts.mediaByLibrary);
      this.badgeCounts.set({ ...counts.badgeCounts, pendingRequests: counts.pendingRequests });
    } catch {
      // silently ignore — counts are non-critical
    }
    await libs;
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




  /** Bottom-dock search button: a same-URL navigation no-ops, so the click signals the search page via {@link SearchStateService.requestFocus}. */
  onSearchNavClick(): void {
    if (this.router.url.split('?')[0] === '/search') this.searchState.requestFocus();
  }

  toggleBottomMenu() {
    this.bottomMenuOpen.update(v => !v);
  }

  goBack() {
    this.navbar.goBack();
  }

  /** Set by Retry, cleared by the next connection outcome or the dial timeout. */
  readonly retrying = signal(false);
  private wasUnreachable = false;

  private readonly reconnectedEffect = effect(() => {
    const unreachable = this.sse.serverUnreachable();
    const connected = this.sse.connected();
    untracked(() => {
      if (connected) this.retrying.set(false);
      if (connected && this.wasUnreachable && !unreachable) this.appResume.refresh();
      this.wasUnreachable = unreachable;
    });
  });

  retryConnection() {
    this.retrying.set(true);
    this.sse.reconnect();
    setTimeout(() => this.retrying.set(false), 10_000);
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

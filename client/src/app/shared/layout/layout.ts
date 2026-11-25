import { fromEvent, merge, startWith } from 'rxjs';
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
import { Capacitor } from '@capacitor/core';
import { Immersive } from '../../core/plugins/immersive.plugin';
import { Keyboard } from '@capacitor/keyboard';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { LibraryPrefsService } from '../../core/services/library-prefs.service';
import { MyLibrariesService } from '../../core/services/my-libraries.service';
import type { LibrarySummary } from '../../core/services/api/libraries-api.service';
import { PushService } from '../../core/services/push.service';
import { CountsApiService, SidebarCounts } from '../../core/services/api/counts-api.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { SseEvent, SseService, requestActivity } from '../../core/services/sse.service';
import { ToastService } from '../../core/services/toast.service';
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
import { UserMenuComponent } from '../components/user-menu';
import { CastOverlayComponent } from '../cast-overlay/cast-overlay';
import { PlaybackSurface } from '../../core/services/playback/playback-surface';
import { AudioPlayerComponent } from '../audio-player/audio-player';
import { PartyCreateModalComponent } from '../../features/party/party-create-modal';
import { PartyReconnectComponent } from '../../features/party/party-reconnect';
import { OptimizeModalComponent } from '../components/optimize-modal/optimize-modal';
import { ReportProblemDialogComponent } from '../components/report-problem-dialog/report-problem-dialog';
import { ReportProblemService } from '../../core/services/report-problem.service';
import { IdentifyModalHostComponent } from '../components/identify-modal-host/identify-modal-host';
import { TrackingModalHostComponent } from '../components/tracking-modal-host/tracking-modal-host';
import { WhatsNewModalComponent } from '../components/whats-new-modal/whats-new-modal';
import { AddToPlaylistModalComponent } from '../components/add-to-playlist-modal/add-to-playlist-modal.component';
import { RecommendModalComponent } from '../components/recommend-modal/recommend-modal.component';
import { AppUpdateModalComponent } from '../components/app-update-modal/app-update-modal';
import { AppUpdateService } from '../../core/services/app-update.service';
import { PartyService } from '../../core/services/party/party.service';
import { TrackingModalService } from '../../core/services/tracking-modal.service';
import { IdentifyModalService } from '../../core/services/identify-modal.service';
import { OptimizeModalService } from '../../core/services/optimize-modal.service';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { RecommendService } from '../../core/services/recommend.service';
import { LucideIconComponent } from '../components/lucide-icon';
import { NavRailComponent } from '../nav-rail/nav-rail';
import { TvRowDirective } from '../directives/tv-row.directive';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { BackgroundService } from '../../core/services/background.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { NavContributionsService, DOCK_PINNED_IDS, MOBILE_HIDDEN_IDS, type ResolvedNavItem } from '../../core/plugin-ui/nav-contributions.service';
import { NavIconComponent } from './nav-icon';
import { libraryColorVar, libraryIcon, libraryUrl } from '../../core/constants/library-appearance';
import { BottomSheetComponent } from '../components/bottom-sheet';
import { CachedSrcDirective } from '../directives/cached-src.directive';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { RemotePickerComponent } from '../remote-picker/remote-picker';
import { parseDeviceLabel } from '../../core/utils/format-device-label';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../icons';

/** Coalesces a burst of count-bearing SSE events (e.g. a season-pack import) into one request. */
const SIDEBAR_COUNTS_DEBOUNCE_MS = 400;
/** Server-side pairing TTL (`PAIRING_TTL_SECS`). */
const PAIRING_TTL_MS = 600_000;

@Component({
  selector: 'app-layout',
  imports: [
    CachedSrcDirective,
    RouterOutlet, RouterLink, RouterLinkActive, TranslatePipe,
    RemotePickerComponent,
    CastOverlayComponent,
    AudioPlayerComponent,
    CardActionsPanelComponent,
    AddToPlaylistModalComponent,
    RecommendModalComponent,
    PartyCreateModalComponent,
    PartyReconnectComponent,
    TrackingModalHostComponent,
    IdentifyModalHostComponent,
    OptimizeModalComponent,
    ReportProblemDialogComponent,
    AppUpdateModalComponent,
    WhatsNewModalComponent,
    UserMenuComponent,
    LucideIconComponent,
    NavIconComponent,
    NavRailComponent,
    BottomSheetComponent,
    TvRowDirective,
    ResolveUrlPipe, LucideDynamicIcon,
  ],
  templateUrl: './layout.html',
})
export class LayoutComponent implements OnInit, OnDestroy {
  protected readonly icons = icons;

  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly libraryPrefs = inject(LibraryPrefsService);
  private readonly countsApi = inject(CountsApiService);
  private readonly push = inject(PushService);
  readonly serverConfig = inject(ServerConfigService);
  readonly sse = inject(SseService);
  private readonly downloadManager = inject(DownloadManagerService);
  // Instantiate eagerly so it records the launching page BEFORE the player opens (the player injects it too late).
  private readonly navHistory = inject(NavigationHistoryService);
  protected readonly party = inject(PartyService);
  protected readonly trackingModal = inject(TrackingModalService);
  protected readonly identifyModal = inject(IdentifyModalService);
  protected readonly optimizeModal = inject(OptimizeModalService);
  protected readonly reportProblem = inject(ReportProblemService);
  protected readonly addToPlaylistSvc = inject(AddToPlaylistService);
  private readonly addToPlaylistModal = viewChild<AddToPlaylistModalComponent>('addToPlaylistModal');
  // Bridge global "add to playlist" requests to the modal in this layout; consumed once so a rebuilt shell (player is outside it) doesn't reopen it.
  private readonly addToPlaylistBridge = effect(() => {
    const req = this.addToPlaylistSvc.request();
    const modal = this.addToPlaylistModal();
    if (req && modal) {
      this.addToPlaylistSvc.clear();
      modal.open(req.target);
    }
  });
  protected readonly recommendSvc = inject(RecommendService);
  private readonly recommendModal = viewChild<RecommendModalComponent>('recommendModal');
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
  private readonly session = inject(PlaybackSession);
  private readonly surface = inject(PlaybackSurface);
  /** The controlled device plays something to open; an idle one only offers the picker. */
  protected readonly hasRemotePlayer = computed(() => !!this.session.playing());
  protected readonly nowPlayingTitle = computed(() => this.session.nowPlaying()?.title ?? '');
  readonly appUpdate = inject(AppUpdateService);
  private readonly updateModal = viewChild<AppUpdateModalComponent>('updateModal');
  protected readonly updateModalRequested = signal(false);
  // The modal is a lazy chunk: open it once its @defer block has rendered.
  private readonly updateModalBridge = effect(() => {
    const modal = this.updateModal();
    if (!modal || !this.updateModalRequested()) return;
    this.updateModalRequested.set(false);
    modal.open();
  });
  private readonly title = inject(Title);

  openUpdateModal(): void {
    this.updateModalRequested.set(true);
  }
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  /** Bumps when language changes so the document title effect re-reads `app.name`. */
  private readonly langTick = signal(0);
  readonly canGoBack = this.navbar.canGoBack;

  readonly isNative = Capacitor.isNativePlatform();
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
  /** The downloads page is where an unreachable server sends you, so it doesn't repeat the warning. */
  readonly isDownloadsRoute = signal(this.router.url.split('?')[0] === '/downloads');

  /** Fixed navbar's own clearance: height plus safe area; 0 where the mobile navbar is hidden.
   *  Hero-blind on purpose: `body.hero-page` (styles.css) applies synchronously, a later value lets iOS 18.7 never re-lay out a cached page. */
  private readonly navbarSpacerHeight = computed(() => {
    if (!this.navbar.mobileNavbarVisible()) return '0px';
    return 'calc(3rem + env(safe-area-inset-top, 0px))';
  });
  private readonly contentGapTop = computed(() =>
    !this.isNative && this.navbar.mobileNavbarVisible() ? '2rem' : '1rem',
  );
  /** Published as a CSS var so content still scrolls under the fixed navbar. */
  readonly chromeTop = computed(() => `calc(${this.navbarSpacerHeight()} + ${this.contentGapTop()})`);
  /** The native phone dock is daisyUI's 4rem plus the bottom safe area it pads itself with. */
  readonly dockHeight = computed(() => (this.navbar.phoneDock() ? 'calc(4rem + env(safe-area-inset-bottom, 0px))' : '0px'));
  readonly chromeBottom = computed(() => `calc(${this.dockHeight()} + 1rem)`);
  /** `chromeBottom` plus the cast and audio mini-bars (3.5rem, borders, 0.5rem gap each) while they float over the page: what content and sticky bars clear. Bars docked in the rail count for nothing. */
  readonly chromeBottomTotal = computed(() => {
    // The bar of another device's session and the audio mini-player share one slot.
    const bars = this.navbar.railDocked() ? 0 : (this.surface.outputBar() ? 1 : 0) + (this.surface.bar() || this.surface.aboveAudio() ? 1 : 0);
    return bars ? `calc(${this.chromeBottom()} + ${bars * 4.25}rem)` : this.chromeBottom();
  });

  /** On the root so the toasts and other top-level overlays outside the layout clear the same chrome. */
  private readonly chromeVars = (() => {
    const root = document.documentElement.style;
    const vars = {
      '--chrome-top': this.chromeTop,
      '--dock-h': this.dockHeight,
      '--chrome-bottom': this.chromeBottom,
      '--chrome-bottom-total': this.chromeBottomTotal,
    };
    inject(DestroyRef).onDestroy(() => Object.keys(vars).forEach((k) => root.removeProperty(k)));
    return effect(() => Object.entries(vars).forEach(([k, v]) => root.setProperty(k, v())));
  })();

  // Android status bar icons: the app is dark-only, so light=false always.
  private readonly statusBarEffect = Capacitor.isNativePlatform() ? effect(() => {
    // Read the signal so the effect re-runs when transparency flips, in case
    // future code wants to react to it.
    void this.navbarTransparent();
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
  /** TV never hides the navbar, so skip the scroll handler: reading the offset forces a layout. */
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
    // The bar is a D-pad target: sliding it out from under the focus ring
    // would strand the cursor, so a focus inside it anchors the bar.
    const focusInBar = !!document.activeElement?.closest('nav.navbar');
    if (Math.abs(y - this.lastScrollY) < 10) return;
    this.navbarHidden.set(!focusInBar && y > this.lastScrollY && y > LayoutComponent.NAVBAR_LEAVES_AT);
    this.lastScrollY = y;
  }

  private readonly myLibraries = inject(MyLibrariesService);
  readonly librariesLoaded = this.myLibraries.loaded;
  /** Sidebar-facing list: the user's chosen order with hidden ones removed. */
  readonly displayLibraries = computed(() =>
    this.libraryPrefs.present(this.myLibraries.list()),
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
  /** The collapsed rail is open over the page, which dims. */
  readonly railOverlaying = signal(false);
  readonly librarySheetOpen = signal(false);
  /** The libraries sheet rests still on the dock, which then lets the sheet's surface run on under it. */
  protected readonly librarySheetSettled = signal(false);
  readonly isLibraryRoute = signal(this.router.url.startsWith('/libraries/'));
  /** The dock's Library cell opens the library itself when there is only one, else a sheet. */
  readonly soleLibrary = computed(() => (this.displayLibraries().length === 1 ? this.displayLibraries()[0] : null));
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
  // import.complete / import.failed reach only the requester, so library counts ride the broadcast queue.updated after each import.
  private readonly sseCounts = merge(this.sse.on('queue.updated', 'stalled.removed'), requestActivity(this.sse))
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(() => this.debouncedRefreshSidebarCounts());

  /** The SSE channel isn't per-user: a foreign request would 403 on approve. */
  private onPairingEvent(event: SseEvent): void {
    if (event['userId'] !== this.auth.user()?.id) return;
    if (event.type === 'pairing.requested') {
      this.promptPairing(event);
      return;
    }
    const pairingId = event['pairingId'] as string;
    const toastId = this.pairingToasts.get(pairingId);
    if (toastId !== undefined) this.toast.dismiss(toastId);
    this.pairingToasts.delete(pairingId);
  }

  private readonly pairingToasts = new Map<string, number>();

  private promptPairing(event: SseEvent) {
    const id = event['pairingId'] as string;
    const settle = (call: (id: string) => Promise<void>, doneKey: string) => () => {
      this.pairingToasts.delete(id);
      void call(id).then(
        () => this.toast.success(this.translate.instant(doneKey)),
        () => this.toast.error(this.translate.instant('pending_requests.action_error')),
      );
    };
    const legacy = event['legacyClient'] === true;
    const toastId = this.toast.info(
      this.translate.instant(legacy ? 'pending_requests.update_device' : 'pending_requests.requested_toast', { device: event['deviceName'] }),
      PAIRING_TTL_MS,
      ...(legacy ? [] : [{ label: this.translate.instant('pending_requests.enter_code'), run: () => void this.router.navigate(['/pending-requests']) }]),
      { label: this.translate.instant('pending_requests.deny'), run: settle((i) => this.auth.pairingDeny(i), 'pending_requests.denied_toast') },
    );
    this.pairingToasts.set(id, toastId);
    setTimeout(() => this.pairingToasts.delete(id), PAIRING_TTL_MS);
  }

  // The shell is instantiated once, so ngOnInit's boot fetch never repeats: a
  // reconnect after backgrounding is the only later signal that counts may be stale.
  private firstConnectionSeen = false;
  private readonly reconnectCountsEffect = effect(() => {
    if (!this.sse.connectionId()) return;
    // The first connection follows the boot fetch.
    if (!this.firstConnectionSeen) {
      this.firstConnectionSeen = true;
      return;
    }
    untracked(() => void this.refreshCounts());
  });

  ngOnInit() {
    if (navigator.onLine) {
      this.refreshCounts();
    } else {
      this.myLibraries.loaded.set(true);
      window.addEventListener('online', () => {
        this.refreshCounts();
      }, { once: true });
    }
    // DownloadManagerService is activated by injection (effect in constructor)
    this.pageScroller.changes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(this.onScroll);
    this.sse.pairingEvents.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => this.onPairingEvent(e));
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
          this.isLibraryRoute.set(e.urlAfterRedirects.startsWith('/libraries/'));
          this.librarySheetOpen.set(false);
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
    this.navbar.showPage(null);
    if (this.scrollRaf !== null) cancelAnimationFrame(this.scrollRaf);
    if (this.isNative) {
      Keyboard.removeAllListeners();
    }
    if (this.sidebarCountsDebounceTimer) clearTimeout(this.sidebarCountsDebounceTimer);
    clearTimeout(this.restoreFallback);
  }

  private applyCounts(counts: SidebarCounts) {
    this.libraryCounts.set(counts.mediaByLibrary);
    this.badgeCounts.set({ ...counts.badgeCounts, pendingRequests: counts.pendingRequests + (counts.openProblems ?? 0) });
    if (counts.attention !== undefined) this.push.setBadge(counts.attention);
  }

  async refreshCounts() {
    // Waiting on the uncached counts would let the list drop in late and shift the nav.
    const libs = this.myLibraries.refresh();
    try {
      this.applyCounts(await this.countsApi.get());
    } catch {
      // silently ignore — counts are non-critical
    }
    await libs;
  }

  /** Refreshes the badge counts only (no library list re-fetch) — the SSE
   *  handlers ride this for every count-bearing event. */
  private async refreshSidebarCounts() {
    try {
      this.applyCounts(await this.countsApi.get());
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

  libraryColor(lib: LibrarySummary): string {
    return libraryColorVar(lib.color);
  }

  readonly libraryUrl = libraryUrl;
  readonly libraryIcon = libraryIcon;

  /** Bottom-dock search button: a same-URL navigation no-ops, so the click signals the search page via {@link SearchStateService.requestFocus}. */
  onSearchNavClick(): void {
    if (this.dismissLibrarySheet()) return;
    if (this.router.url.split('?')[0] === '/search') this.searchState.requestFocus();
  }

  /** Every dock tap closes the libraries sheet; the return value tells a tap that only dismissed it from one that acts. */
  dismissLibrarySheet(): boolean {
    const wasOpen = this.librarySheetOpen();
    this.librarySheetOpen.set(false);
    return wasOpen;
  }

  toggleLibrarySheet(): void {
    this.bottomMenuOpen.set(false);
    this.librarySheetOpen.update((v) => !v);
  }

  toggleBottomMenu() {
    this.bottomMenuOpen.update(v => !v);
  }

  goBack() {
    this.navbar.goBack();
  }

  /** Set by Retry, cleared by the next connection outcome or the dial timeout. */
  readonly retrying = signal(false);

  private readonly reconnectedEffect = effect(() => {
    if (this.sse.connected()) untracked(() => this.retrying.set(false));
  });

  retryConnection() {
    this.retrying.set(true);
    this.sse.reconnect();
    setTimeout(() => this.retrying.set(false), 10_000);
  }

  /** The chip of a cast or an already selected remote target opens the player on it, not the device picker. */
  openCastPlayer() {
    this.session.openPlayer();
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

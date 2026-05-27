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
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { RouterLink, RouterLinkActive, RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { MediaService } from '../../core/services/api/media.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { DownloadClientsApiService, QueueItem } from '../../core/services/api/download-clients-api.service';
import { RequestsService } from '../../core/services/api/requests.service';
import { ServerCacheService } from '../../core/services/server-cache.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { SseService } from '../../core/services/sse.service';
import { CastService } from '../../core/services/cast.service';
import { NavbarService } from '../../core/services/navbar.service';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { NetworkService } from '../../core/services/network.service';
import { CastOverlayComponent } from '../cast-overlay/cast-overlay';
import { CardActionsPanelComponent } from '../components/card-actions-panel/card-actions-panel';
import { UserMenuComponent } from '../components/user-menu';
import { LucideIconComponent } from '../components/lucide-icon';
import { TvRowDirective } from '../directives/tv-row.directive';
import { BackgroundComponent } from '../components/background/background';
import { BackgroundService } from '../../core/services/background.service';
import { SearchStateService } from '../../core/services/search-state.service';
import {
  LucideMenu,
  LucideChevronLeft,
  LucideHome,
  LucideSearch,
  LucideClipboardList,
  LucideDownload,
  LucideCalendar,
  LucideCast,
  LucideHistory,
  LucideEllipsisVertical,
  LucideUsers,
  LucidePin,
} from '@lucide/angular';


@Component({
  selector: 'app-layout',
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive, TranslateModule,
    LucideMenu, LucideChevronLeft, LucideHome, LucideSearch,
    LucideClipboardList, LucideDownload, LucideCalendar, LucideCast,
    LucideHistory, LucideEllipsisVertical, LucideUsers, LucidePin,
    CastOverlayComponent,
    CardActionsPanelComponent,
    UserMenuComponent,
    LucideIconComponent,
    TvRowDirective,
    BackgroundComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './layout.html',
})
export class LayoutComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly mediaService = inject(MediaService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly downloadApi = inject(DownloadClientsApiService);
  private readonly requestsService = inject(RequestsService);
  readonly serverConfig = inject(ServerConfigService);
  private readonly serverCache = inject(ServerCacheService);
  private readonly sse = inject(SseService);
  private readonly downloadManager = inject(DownloadManagerService);
  readonly networkService = inject(NetworkService);
  readonly castService = inject(CastService);
  readonly navbar = inject(NavbarService);
  readonly background = inject(BackgroundService);
  private readonly searchState = inject(SearchStateService);
  readonly tv = inject(TvService);
  readonly device = inject(DeviceService);
  readonly castPlayer = inject(CastPlayerService);
  private readonly title = inject(Title);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  /** Bumps when language changes so the document title effect re-reads `app.name`. */
  private readonly langTick = signal(0);
  readonly canGoBack = this.navbar.canGoBack;

  readonly isNative = Capacitor.isNativePlatform();
  readonly bottomMenuOpen = signal(false);
  readonly keyboardOpen = signal(false);
  readonly navbarHidden = signal(false);
  readonly navbarTransparent = this.navbar.navbarTransparent;
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
    const app = this.translate.instant('app.name');
    const main = this.navbar.mobileNavTitle();
    this.title.setTitle(main ? `${main} · ${app}` : app);
  });
  private lastScrollY = 0;
  private readonly onScroll = () => {
    const y = window.scrollY;
    this.navbar.scrollAtTop.set(y < 20);
    if (Math.abs(y - this.lastScrollY) < 10) return;
    this.navbarHidden.set(y > this.lastScrollY && y > 56);
    this.lastScrollY = y;
  };

  /** Accessible libraries for the sidebar. */
  readonly libraries = signal<LibrarySummary[]>([]);
  /** Libraries excluding the default Films / Séries — those have their own
   *  shortcut elsewhere (or are deliberately omitted from the mobile More
   *  menu to keep it short). Custom libraries (Anime, Docs, …) stay. */
  readonly customLibraries = computed(() =>
    this.libraries().filter(
      (lib) => !lib.isDefaultForMovies && !lib.isDefaultForSeries,
    ),
  );
  /** Media count per library ID. */
  readonly libraryCounts = signal<Record<number, number>>({});
  readonly queueCount = signal(0);
  readonly pendingRequestCount = signal(0);


  /** Refresh counts when relevant SSE events arrive */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    if (!event) return;
    switch (event.type) {
      // import.complete / import.failed are user-targeted (only the requester
      // receives them), so library counts ride the broadcast queue.updated that
      // follows every import — otherwise non-requesters' sidebars go stale.
      case 'queue.updated':
        this.refreshMediaCounts();
        this.refreshQueueCount();
        break;
      case 'stalled.removed':
        this.refreshQueueCount();
        break;
      case 'request.approved':
      case 'request.declined':
        this.refreshRequestCount();
        break;
    }
  });

  ngOnInit() {
    if (navigator.onLine) {
      this.refreshCounts();
      this.sse.connect();
    } else {
      window.addEventListener('online', () => {
        this.refreshCounts();
        this.sse.connect();
      }, { once: true });
    }
    // DownloadManagerService is activated by injection (effect in constructor)
    window.addEventListener('scroll', this.onScroll, { passive: true });
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
          this.bottomMenuOpen.set(false);
          this.isHomeRoute.set(e.urlAfterRedirects === '/' || e.urlAfterRedirects.startsWith('/?'));
          this.syncNavbarTitleFromRoute();
        }
      });
    this.syncNavbarTitleFromRoute();
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
    if (this.isNative) {
      Keyboard.removeAllListeners();
    }
  }

  async refreshCounts() {
    try {
      const [libs, counts, queue, requests] = await Promise.all([
        this.librariesApi.listMine(),
        this.mediaService.getCountsByLibrary(),
        this.downloadApi.getQueue({ pageSize: 100 }),
        this.requestsService.list({ status: 'pending', limit: 1 }),
      ]);
      this.libraries.set(libs);
      this.libraryCounts.set(counts);
      this.queueCount.set(queue.items.filter((q) => this.isActiveDownload(q)).length);
      this.pendingRequestCount.set(requests.total);
    } catch {
      // silently ignore — counts are non-critical
    }
  }

  /** Sidebar badge counts only torrents still doing work — excludes the
   *  terminal Fliks states (imported, failed, quality-not-upgraded) and the
   *  download-client error states (error, missing files). */
  private isActiveDownload(q: QueueItem): boolean {
    const doneStatuses = ['Imported', 'Import failed', 'Quality not upgraded'];
    const errorTracker = ['Error', 'Missing files'];
    return !doneStatuses.includes(q.status) && !errorTracker.includes(q.trackerStatus);
  }

  private async refreshMediaCounts() {
    try {
      const counts = await this.mediaService.getCountsByLibrary();
      this.libraryCounts.set(counts);
    } catch { /* ignore */ }
  }

  libraryUrl(lib: LibrarySummary): string {
    return `/libraries/${encodeURIComponent(lib.name)}`;
  }

  /** Icon key for a library: explicit icon > default 'library'. */
  libraryIcon(lib: LibrarySummary): string {
    return lib.icon || 'library';
  }

  private async refreshQueueCount() {
    try {
      const queue = await this.downloadApi.getQueue({ pageSize: 100 });
      this.queueCount.set(queue.items.filter((q) => this.isActiveDownload(q)).length);
    } catch { /* ignore */ }
  }

  private async refreshRequestCount() {
    try {
      const requests = await this.requestsService.list({ status: 'pending', limit: 1 });
      this.pendingRequestCount.set(requests.total);
    } catch { /* ignore */ }
  }



  resetNavHistory() {
    this.navbar.resetNavHistory();
  }

  /** Bottom-dock search button: same-route click should re-focus the
   *  input and re-open the soft keyboard. The default Router behaviour
   *  no-ops on a same-URL navigation, so the click handler signals the
   *  search page via {@link SearchStateService.requestFocus}. */
  onSearchNavClick(): void {
    this.resetNavHistory();
    if (this.router.url.split('?')[0] === '/search') {
      this.searchState.requestFocus();
    }
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

  async switchUser() {
    // Wipe cached server data so the next login does not inherit the previous
    // user's home rows / library views. Auth state survives — the user keeps
    // the current session until they actually log in as someone else.
    await this.serverCache.clearAll();
    this.router.navigate(['/login'], { queryParams: { switch: true } });
  }

  onToggleCastConnection() {
    if (this.castService.isConnected()) {
      this.castService.disconnect();
    } else {
      this.castService.requestSession();
    }
  }
}

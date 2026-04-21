import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  effect,
  OnInit,
  OnDestroy,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { RouterLink, RouterLinkActive, RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { Location } from '@angular/common';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { MediaService } from '../../core/services/api/media.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { DownloadClientsApiService } from '../../core/services/api/download-clients-api.service';
import { RequestsService } from '../../core/services/api/requests.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { SseService } from '../../core/services/sse.service';
import { ThemeService } from '../../core/services/theme.service';
import { CastService } from '../../core/services/cast.service';
import { NavbarService } from '../../core/services/navbar.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { NetworkService } from '../../core/services/network.service';
import { CastOverlayComponent } from '../cast-overlay/cast-overlay';
import { UserMenuComponent } from '../components/user-menu';
import { LucideIconComponent } from '../components/lucide-icon';
import {
  LucideMenu,
  LucideChevronLeft,
  LucideHome,
  LucideFilm,
  LucideTv,
  LucideSearch,
  LucideClipboardList,
  LucideDownload,
  LucideCalendar,
  LucideUpload,
  LucideArrowRightLeft,
  LucideLayoutGrid,
  LucideSettings,
  LucideUser,
  LucideSun,
  LucideMoon,
  LucideLogOut,
  LucideCast,
  LucideUserCog,
  LucideShield,
  LucideRepeat,
  LucideHistory,
  LucideEllipsisVertical,
  LucideUsers,
} from '@lucide/angular';


@Component({
  selector: 'app-layout',
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive, TranslateModule,
    LucideMenu, LucideChevronLeft, LucideHome, LucideFilm, LucideTv, LucideSearch,
    LucideClipboardList, LucideDownload, LucideCalendar, LucideUpload,
    LucideArrowRightLeft, LucideLayoutGrid, LucideSettings, LucideUser,
    LucideSun, LucideMoon, LucideLogOut, LucideCast,
    LucideUserCog, LucideShield, LucideRepeat, LucideHistory,
    LucideEllipsisVertical, LucideUsers,
    CastOverlayComponent,
    UserMenuComponent,
    LucideIconComponent,
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
  private readonly sse = inject(SseService);
  private readonly downloadManager = inject(DownloadManagerService);
  readonly networkService = inject(NetworkService);
  readonly castService = inject(CastService);
  readonly navbar = inject(NavbarService);
  readonly castPlayer = inject(CastPlayerService);
  private readonly location = inject(Location);
  private readonly title = inject(Title);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  /** Bumps when language changes so the document title effect re-reads `app.name`. */
  private readonly langTick = signal(0);
  readonly canGoBack = signal(false);

  readonly themeService = inject(ThemeService);
  readonly isNative = Capacitor.isNativePlatform();
  readonly bottomMenuOpen = signal(false);
  readonly keyboardOpen = signal(false);
  readonly navbarHidden = signal(false);
  readonly navbarTransparent = this.navbar.navbarTransparent;

  // Sync Android status bar icons with navbar state
  private readonly statusBarEffect = Capacitor.isNativePlatform() ? effect(() => {
    const transparent = this.navbarTransparent();
    const theme = this.themeService.theme();
    const light = !transparent && theme === 'light';
    const Immersive = registerPlugin<any>('Immersive');
    Immersive.setLightStatusBar({ light }).catch(() => {});
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
  /** Media count per library ID. */
  readonly libraryCounts = signal<Record<number, number>>({});
  readonly queueCount = signal(0);
  readonly pendingRequestCount = signal(0);


  /** Refresh counts when relevant SSE events arrive */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    if (!event) return;
    switch (event.type) {
      case 'import.complete':
      case 'import.failed':
        this.refreshMediaCounts();
        this.refreshQueueCount();
        break;
      case 'queue.updated':
      case 'stalled.removed':
        this.refreshQueueCount();
        break;
      case 'request.approved':
      case 'request.declined':
        this.refreshRequestCount();
        break;
    }
  });

  private navCount = 0;

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
    this.router.events.subscribe(e => {
      if (e instanceof NavigationEnd) {
        this.navCount++;
        this.canGoBack.set(this.navCount > 1 && this.router.url !== '/');
        this.bottomMenuOpen.set(false);
        this.syncNavbarTitleFromRoute();
      }
    });
    this.syncNavbarTitleFromRoute();
  }

  /** Applies `data.titleKey` from the deepest activated route (skipped on hero pages). */
  private syncNavbarTitleFromRoute() {
    let key: string | undefined;
    let r = this.router.routerState.snapshot.root;
    while (r.firstChild) {
      r = r.firstChild;
      if (r.data['titleKey']) key = r.data['titleKey'] as string;
    }
    if (this.navbar.isHeroPage()) return;
    if (key) {
      this.navbar.setPageTitle(this.translate.instant(key));
    } else {
      this.navbar.clearPageTitle();
    }
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
        this.downloadApi.getQueue(),
        this.requestsService.list({ status: 'pending', limit: 1 }),
      ]);
      this.libraries.set(libs);
      this.libraryCounts.set(counts);
      this.queueCount.set(queue.length);
      this.pendingRequestCount.set(requests.total);
    } catch {
      // silently ignore — counts are non-critical
    }
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
      const queue = await this.downloadApi.getQueue();
      this.queueCount.set(queue.filter(q => q.status !== 'Imported').length);
    } catch { /* ignore */ }
  }

  private async refreshRequestCount() {
    try {
      const requests = await this.requestsService.list({ status: 'pending', limit: 1 });
      this.pendingRequestCount.set(requests.total);
    } catch { /* ignore */ }
  }



  resetNavHistory() {
    this.navCount = 0;
  }

  toggleBottomMenu() {
    this.bottomMenuOpen.update(v => !v);
  }

  goBack() {
    this.location.back();
  }

  retryConnection() {
    window.location.reload();
  }

  toggleCastOverlay() {
    this.castPlayer.expanded.update(v => !v);
  }

  switchUser() {
    // Navigate to login without clearing the current session
    // (allows reconnection later without password)
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

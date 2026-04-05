import { Component, ChangeDetectionStrategy, inject, signal, effect, OnInit, OnDestroy } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { Location } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { MediaService } from '../../core/services/api/media.service';
import { DownloadClientsApiService } from '../../core/services/api/download-clients-api.service';
import { RequestsService } from '../../core/services/api/requests.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { SseService } from '../../core/services/sse.service';
import { CastService } from '../../core/services/cast.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { CastOverlayComponent } from '../cast-overlay/cast-overlay';
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
} from '@lucide/angular';

function getInitialTheme(): 'dark' | 'light' {
  const stored = localStorage.getItem('suitarr-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

@Component({
  selector: 'app-layout',
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive, TranslateModule,
    LucideMenu, LucideChevronLeft, LucideHome, LucideFilm, LucideTv, LucideSearch,
    LucideClipboardList, LucideDownload, LucideCalendar, LucideUpload,
    LucideArrowRightLeft, LucideLayoutGrid, LucideSettings, LucideUser,
    LucideSun, LucideMoon, LucideLogOut, LucideCast,
    CastOverlayComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './layout.html',
})
export class LayoutComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly mediaService = inject(MediaService);
  private readonly downloadApi = inject(DownloadClientsApiService);
  private readonly requestsService = inject(RequestsService);
  readonly serverConfig = inject(ServerConfigService);
  private readonly sse = inject(SseService);
  readonly castService = inject(CastService);
  readonly castPlayer = inject(CastPlayerService);
  private readonly location = inject(Location);
  readonly canGoBack = signal(false);

  readonly theme = signal<'dark' | 'light'>(getInitialTheme());
  readonly navbarHidden = signal(false);
  readonly navbarTransparent = signal(true);
  private lastScrollY = 0;
  private readonly onScroll = () => {
    const y = window.scrollY;
    this.navbarTransparent.set(y < 20);
    if (Math.abs(y - this.lastScrollY) < 10) return;
    this.navbarHidden.set(y > this.lastScrollY && y > 56);
    this.lastScrollY = y;
  };

  readonly movieCount = signal(0);
  readonly seriesCount = signal(0);
  readonly queueCount = signal(0);
  readonly pendingRequestCount = signal(0);

  private readonly themeEffect = effect(() => {
    const t = this.theme();
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('suitarr-theme', t);
  });

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
    this.refreshCounts();
    this.sse.connect();
    window.addEventListener('scroll', this.onScroll, { passive: true });
    this.router.events.subscribe(e => {
      if (e instanceof NavigationEnd) {
        this.navCount++;
        this.canGoBack.set(this.navCount > 1 && this.router.url !== '/');
      }
    });
  }

  ngOnDestroy() {
    window.removeEventListener('scroll', this.onScroll);
  }

  async refreshCounts() {
    try {
      const [counts, queue, requests] = await Promise.all([
        this.mediaService.getCounts(),
        this.downloadApi.getQueue(),
        this.requestsService.list({ status: 'pending', limit: 1 }),
      ]);
      this.movieCount.set(counts.movies);
      this.seriesCount.set(counts.series);
      this.queueCount.set(queue.length);
      this.pendingRequestCount.set(requests.total);
    } catch {
      // silently ignore — counts are non-critical
    }
  }

  private async refreshMediaCounts() {
    try {
      const counts = await this.mediaService.getCounts();
      this.movieCount.set(counts.movies);
      this.seriesCount.set(counts.series);
    } catch { /* ignore */ }
  }

  private async refreshQueueCount() {
    try {
      const queue = await this.downloadApi.getQueue();
      this.queueCount.set(queue.length);
    } catch { /* ignore */ }
  }

  private async refreshRequestCount() {
    try {
      const requests = await this.requestsService.list({ status: 'pending', limit: 1 });
      this.pendingRequestCount.set(requests.total);
    } catch { /* ignore */ }
  }

  isSettingsOpen(): boolean {
    return this.router.url.startsWith('/settings');
  }

  toggleTheme(): void {
    this.theme.update((t) => (t === 'dark' ? 'light' : 'dark'));
  }

  goBack() {
    this.location.back();
  }

  toggleCastOverlay() {
    this.castPlayer.expanded.update(v => !v);
  }

  onToggleCastConnection() {
    if (this.castService.isConnected()) {
      this.castService.disconnect();
    } else {
      this.castService.requestSession();
    }
  }
}

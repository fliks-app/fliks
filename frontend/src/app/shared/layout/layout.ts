import { Component, ChangeDetectionStrategy, inject, signal, effect, OnInit, OnDestroy } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { MediaService } from '../../core/services/api/media.service';
import { DownloadClientsApiService } from '../../core/services/api/download-clients-api.service';
import { RequestsService } from '../../core/services/api/requests.service';
import { ServerConfigService } from '../../core/services/server-config.service';

function getInitialTheme(): 'dark' | 'light' {
  const stored = localStorage.getItem('suitarr-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

@Component({
  selector: 'app-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslateModule],
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

  readonly theme = signal<'dark' | 'light'>(getInitialTheme());

  readonly movieCount = signal(0);
  readonly seriesCount = signal(0);
  readonly queueCount = signal(0);
  readonly pendingRequestCount = signal(0);

  private intervalId: ReturnType<typeof setInterval> | null = null;

  private readonly themeEffect = effect(() => {
    const t = this.theme();
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('suitarr-theme', t);
  });

  ngOnInit() {
    this.refreshCounts();
    this.intervalId = setInterval(() => this.refreshCounts(), 30_000);
  }

  ngOnDestroy() {
    if (this.intervalId !== null) clearInterval(this.intervalId);
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

  /** Keep the settings <details> open when any /settings/* route is active */
  isSettingsOpen(): boolean {
    return this.router.url.startsWith('/settings');
  }

  toggleTheme(): void {
    this.theme.update(t => t === 'dark' ? 'light' : 'dark');
  }
}

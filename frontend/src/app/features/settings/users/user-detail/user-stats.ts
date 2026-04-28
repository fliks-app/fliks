import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LucideClock,
  LucideFilm,
  LucideTv,
  LucideListVideo,
  LucideClipboardList,
  LucideCheckCircle,
  LucideXCircle,
  LucideMonitorSmartphone,
  LucideUserPlus,
  LucideZap,
} from '@lucide/angular';
import { UsersApiService, UserStats } from '../../../../core/services/api/users-api.service';
import { UserDetailState } from './user-detail.state';
import { formatRelativeTime } from '../../../../core/utils/relative-time';

interface QuotaRow {
  label: string;
  used: number;
  limit: number;
  /** percentage 0-100, capped */
  percent: number;
  /** progress class: '' (default), 'progress-warning' (≥80%), 'progress-error' (≥100%) */
  variant: '' | 'progress-warning' | 'progress-error';
}

@Component({
  selector: 'app-user-stats',
  imports: [
    TranslateModule,
    LucideClock,
    LucideFilm,
    LucideTv,
    LucideListVideo,
    LucideClipboardList,
    LucideCheckCircle,
    LucideXCircle,
    LucideMonitorSmartphone,
    LucideUserPlus,
    LucideZap,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-stats.html',
})
export class UserStatsComponent implements OnInit {
  private readonly api = inject(UsersApiService);
  private readonly translate = inject(TranslateService);
  private readonly state = inject(UserDetailState);

  readonly stats = signal<UserStats | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');

  /** Hours rounded to 1 decimal (124.3h, etc.). */
  readonly totalHours = computed(() => {
    const s = this.stats();
    if (!s) return 0;
    return Math.round((s.playback.totalWatchTimeSeconds / 3600) * 10) / 10;
  });

  /** Movie + series quota rows; empty when both quotas are unlimited. */
  readonly quotaRows = computed<QuotaRow[]>(() => {
    const s = this.stats();
    if (!s) return [];
    const rows: QuotaRow[] = [];
    if (s.requests.movieQuotaLimit > 0) {
      rows.push(this.buildQuotaRow('movies', s.requests.moviesInPeriod, s.requests.movieQuotaLimit));
    }
    if (s.requests.seriesQuotaLimit > 0) {
      rows.push(this.buildQuotaRow('series', s.requests.seriesInPeriod, s.requests.seriesQuotaLimit));
    }
    return rows;
  });

  readonly hasUnlimitedQuotas = computed(() => {
    const s = this.stats();
    return !!s && s.requests.movieQuotaLimit === 0 && s.requests.seriesQuotaLimit === 0;
  });

  /** First N devices for the truncated list; the count card shows the full count. */
  readonly visibleDevices = computed(() => this.stats()?.devices.items.slice(0, 5) ?? []);

  readonly hiddenDevicesCount = computed(() => {
    const items = this.stats()?.devices.items ?? [];
    return Math.max(0, items.length - this.visibleDevices().length);
  });

  ngOnInit() {
    void this.load();
  }

  async load() {
    const userId = this.state.userId();
    if (!userId) return;
    this.loading.set(true);
    this.error.set('');
    try {
      this.stats.set(await this.api.getStats(userId));
    } catch {
      this.error.set('settings.user_detail.stats.load_error');
    } finally {
      this.loading.set(false);
    }
  }

  formatRelative(iso: string | null): string {
    if (!iso) return '—';
    return formatRelativeTime(iso, this.translate.currentLang ?? 'fr');
  }

  private buildQuotaRow(kind: 'movies' | 'series', used: number, limit: number): QuotaRow {
    const percent = Math.min(100, Math.round((used / limit) * 100));
    const variant: QuotaRow['variant'] =
      percent >= 100 ? 'progress-error' : percent >= 80 ? 'progress-warning' : '';
    return {
      label: this.translate.instant(
        kind === 'movies'
          ? 'settings.user_detail.stats.requests_quota_movies'
          : 'settings.user_detail.stats.requests_quota_series',
      ),
      used,
      limit,
      percent,
      variant,
    };
  }
}

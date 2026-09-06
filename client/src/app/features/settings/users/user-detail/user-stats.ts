import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LucideClock,
  LucideFilm,
  LucideTv,
  LucideListVideo,
  LucideClipboardList,
  LucideCheckCircle,
  LucideXCircle,
  LucideUserPlus,
  LucideZap,
} from '@lucide/angular';
import { UsersApiService, UserStats } from '../../../../core/services/api/users-api.service';
import { UserDetailState } from './user-detail.state';
import { formatRelativeTime } from '../../../../core/utils/relative-time';

@Component({
  selector: 'app-user-stats',
  imports: [
    TranslatePipe,
    LucideClock,
    LucideFilm,
    LucideTv,
    LucideListVideo,
    LucideClipboardList,
    LucideCheckCircle,
    LucideXCircle,
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
    return formatRelativeTime(iso, this.translate.currentLang() ?? 'fr');
  }
}

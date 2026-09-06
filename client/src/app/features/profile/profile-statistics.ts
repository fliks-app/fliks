import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LucideClock,
  LucideFilm,
  LucideTv,
  LucideListVideo,
  LucideClipboardList,
} from '@lucide/angular';
import { SocialApiService } from '../../core/services/api/social-api.service';
import { UserStats } from '../../core/services/api/users-api.service';
import { ProfileContextService } from './profile-context.service';

/** The profile "statistics" tab: watch stats + total requests made. Visible for
 *  the owner, and for others only when the member opted in (backend gates it and
 *  the tab is hidden otherwise). Loads on demand from the social stats endpoint. */
@Component({
  selector: 'app-profile-statistics',
  imports: [
    TranslatePipe,
    LucideClock,
    LucideFilm,
    LucideTv,
    LucideListVideo,
    LucideClipboardList,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile-statistics.html',
})
export class ProfileStatisticsComponent {
  private readonly api = inject(SocialApiService);
  private readonly ctx = inject(ProfileContextService);

  readonly stats = signal<UserStats | null>(null);
  readonly loading = signal(true);

  private loadedFor = 0;

  /** Total watch time in hours, rounded to one decimal. */
  readonly totalHours = computed(() => {
    const s = this.stats();
    if (!s) return 0;
    return Math.round((s.playback.totalWatchTimeSeconds / 3600) * 10) / 10;
  });

  /** Every request the member has ever made, regardless of outcome. */
  readonly totalRequests = computed(() => {
    const r = this.stats()?.requests;
    if (!r) return 0;
    return r.pending + r.approved + r.declined;
  });

  constructor() {
    effect(() => {
      const p = this.ctx.profile();
      if (!p) return;
      if (this.loadedFor !== p.id) {
        this.loadedFor = p.id;
        void this.load(p.id);
      }
    });
  }

  private async load(userId: number): Promise<void> {
    this.loading.set(true);
    try {
      this.stats.set(await this.api.getUserStats(userId, { force: true }));
    } catch {
      // Global interceptor surfaces the error (404 when not shared/visible).
      this.stats.set(null);
    } finally {
      this.loading.set(false);
    }
  }
}

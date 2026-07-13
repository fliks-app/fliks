import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import {
  ReceivedRecommendation,
  SentRecommendation,
  SocialApiService,
} from '../../core/services/api/social-api.service';
import { ProfileContextService } from './profile-context.service';

/** The profile "recommendations" tab, own-profile only: content other members
 *  recommended to the viewer, and content the viewer recommended to others.
 *  Rendered as compact tables so the recipient/sender is always visible. */
@Component({
  selector: 'app-profile-recommendations',
  imports: [TranslateModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile-recommendations.html',
})
export class ProfileRecommendationsComponent {
  private readonly api = inject(SocialApiService);
  private readonly router = inject(Router);
  private readonly ctx = inject(ProfileContextService);

  readonly loading = signal(true);
  readonly received = signal<ReceivedRecommendation[]>([]);
  readonly sent = signal<SentRecommendation[]>([]);

  private loadedFor = 0;

  constructor() {
    // This tab is personal (the endpoints are always about the caller). If the
    // viewer deep-links to someone else's /recommendations, bounce them to that
    // profile's overview.
    effect(() => {
      const p = this.ctx.profile();
      if (!p) return;
      if (!p.isSelf) {
        void this.router.navigate(['/profile', p.id]);
        return;
      }
      if (this.loadedFor !== p.id) {
        this.loadedFor = p.id;
        void this.load();
      }
    });
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [received, sent] = await Promise.all([
        // Full history here (incl. items dismissed from the home card).
        this.api
          .receivedRecommendations({ force: true, includeDismissed: true })
          .catch(() => []),
        this.api.sentRecommendations({ force: true }).catch(() => []),
      ]);
      this.received.set(received);
      this.sent.set(sent);
    } finally {
      this.loading.set(false);
    }
  }

  contentLink(item: {
    mediaType: string;
    mediaId: number;
    episodeId: number | null;
  }): string[] {
    if (item.episodeId) {
      return ['/series', String(item.mediaId), 'episode', String(item.episodeId)];
    }
    return [item.mediaType === 'series' ? '/series' : '/movies', String(item.mediaId)];
  }
}

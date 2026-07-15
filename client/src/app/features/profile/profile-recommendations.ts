import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { map } from 'rxjs';
import {
  ReceivedRecommendation,
  SentRecommendation,
  SocialApiService,
} from '../../core/services/api/social-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

/** The profile "recommendations" tab, own-profile only: content other members
 *  recommended to the viewer, and content the viewer recommended to others.
 *  Rendered as compact tables so the recipient/sender is always visible. */
@Component({
  selector: 'app-profile-recommendations',
  imports: [TranslateModule, RouterLink, ResolveUrlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile-recommendations.html',
})
export class ProfileRecommendationsComponent {
  private readonly api = inject(SocialApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);

  readonly loading = signal(true);
  readonly received = signal<ReceivedRecommendation[]>([]);
  readonly sent = signal<SentRecommendation[]>([]);

  /** The profile being viewed, read straight from the parent route param so the
   *  redirect below is authoritative during navigation (the shared aggregate
   *  still holds the previously-viewed profile while its reload is in flight). */
  private readonly viewedId = toSignal(
    (this.route.parent ?? this.route).paramMap.pipe(
      map((pm) => Number(pm.get('userId'))),
    ),
    { initialValue: 0 },
  );

  private loadedFor = 0;

  constructor() {
    // This tab is personal (the endpoints are always about the caller). If the
    // viewer deep-links to someone else's /recommendations, bounce them to that
    // profile's overview.
    effect(() => {
      const viewedId = this.viewedId();
      const myId = this.auth.user()?.id;
      if (!viewedId || myId == null) return;
      if (viewedId !== myId) {
        void this.router.navigate(['/profile', viewedId]);
        return;
      }
      if (this.loadedFor !== viewedId) {
        this.loadedFor = viewedId;
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

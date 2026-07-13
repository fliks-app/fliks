import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LucideX } from '@lucide/angular';
import {
  ReceivedRecommendation,
  SocialApiService,
} from '../../../core/services/api/social-api.service';
import { SseService } from '../../../core/services/sse.service';
import { TvService } from '../../../core/services/tv.service';

/**
 * Home widget listing content other members have recommended to the viewer,
 * styled like the follow-requests card. Each row links to the recommended
 * title and can be dismissed. Renders nothing when there are none (or on TV,
 * where the social surface is hidden). Refreshes live on the
 * `social.content_recommended` SSE.
 */
@Component({
  selector: 'app-received-recommendations-card',
  imports: [RouterLink, TranslateModule, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './received-recommendations-card.html',
})
export class ReceivedRecommendationsCardComponent implements OnInit {
  private readonly api = inject(SocialApiService);
  private readonly sse = inject(SseService);
  readonly tv = inject(TvService);

  /** Adds bottom padding when stacked above the home sections. */
  readonly padding = input(false);

  readonly items = signal<ReceivedRecommendation[]>([]);
  readonly busyId = signal<number | null>(null);

  constructor() {
    // Refresh the moment a new recommendation SSE arrives, without waiting for
    // the next page load.
    effect(() => {
      if (this.sse.lastEvent()?.type === 'social.content_recommended') {
        void this.load();
      }
    });
  }

  ngOnInit(): void {
    if (!this.tv.isTv()) void this.load();
  }

  mediaLink(item: ReceivedRecommendation): string[] {
    if (item.episodeId) {
      return ['/series', String(item.mediaId), 'episode', String(item.episodeId)];
    }
    return [item.mediaType === 'series' ? '/series' : '/movies', String(item.mediaId)];
  }

  private async load(): Promise<void> {
    try {
      this.items.set(await this.api.receivedRecommendations({ force: true }));
    } catch {
      /* interceptor surfaces errors */
    }
  }

  async dismiss(item: ReceivedRecommendation): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(item.id);
    try {
      await this.api.dismissRecommendation(item.id);
      this.items.update((list) => list.filter((r) => r.id !== item.id));
    } finally {
      this.busyId.set(null);
    }
  }
}

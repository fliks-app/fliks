import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import {
  LucideEllipsisVertical,
  LucideHeart,
  LucideListPlus,
  LucideX,
} from '@lucide/angular';
import {
  ReceivedRecommendation,
  SocialApiService,
} from '../../../core/services/api/social-api.service';
import { SseService } from '../../../core/services/sse.service';
import { TvService } from '../../../core/services/tv.service';
import { DropdownMenuComponent } from '../dropdown-menu';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { LikesApiService } from '../../../core/services/api/likes-api.service';

/**
 * Home widget listing content other members have recommended to the viewer,
 * styled like the follow-requests card. Each row links to the recommended
 * title and can be dismissed. Renders nothing when there are none (or on TV,
 * where the social surface is hidden). Refreshes live on the
 * `social.content_recommended` SSE.
 */
@Component({
  selector: 'app-received-recommendations-card',
  imports: [
    RouterLink,
    TranslateModule,
    DropdownMenuComponent,
    LucideX,
    LucideEllipsisVertical,
    LucideHeart,
    LucideListPlus,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './received-recommendations-card.html',
  host: { class: 'contents' },
})
export class ReceivedRecommendationsCardComponent implements OnInit {
  private readonly api = inject(SocialApiService);
  private readonly sse = inject(SseService);
  private readonly addToPlaylistService = inject(AddToPlaylistService);
  private readonly likesApi = inject(LikesApiService);
  readonly tv = inject(TvService);

  readonly items = signal<ReceivedRecommendation[]>([]);
  readonly busyId = signal<number | null>(null);

  /** Recommendations grouped by sender, each group keeping the newest-first feed order. */
  readonly grouped = computed(() => {
    const groups: {
      senderId: number;
      senderName: string;
      items: ReceivedRecommendation[];
    }[] = [];
    const byId = new Map<number, (typeof groups)[number]>();
    for (const item of this.items()) {
      let group = byId.get(item.sender.id);
      if (!group) {
        group = { senderId: item.sender.id, senderName: item.sender.username, items: [] };
        byId.set(item.sender.id, group);
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups;
  });

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

  async toggleLike(item: ReceivedRecommendation): Promise<void> {
    const target = {
      mediaId: item.mediaId,
      seasonId: item.seasonId ?? undefined,
      episodeId: item.episodeId ?? undefined,
    };
    const nowLiked = !item.liked;
    try {
      await (nowLiked ? this.likesApi.like(target) : this.likesApi.unlike(target));
      this.items.update((list) =>
        list.map((r) => (r.id === item.id ? { ...r, liked: nowLiked } : r)),
      );
    } catch {
      /* interceptor surfaces errors */
    }
  }

  addToPlaylist(item: ReceivedRecommendation): void {
    this.addToPlaylistService.open(
      item.episodeId != null
        ? { episodeId: item.episodeId }
        : item.seasonId != null
          ? { seasonId: item.seasonId }
          : { mediaId: item.mediaId },
    );
  }
}

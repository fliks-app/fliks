import {
  Component,
  OnInit,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCheck, LucideX } from '@lucide/angular';
import { SocialApiService, SocialUser } from '../../../core/services/api/social-api.service';
import { SseService } from '../../../core/services/sse.service';
import { TvService } from '../../../core/services/tv.service';
import { UserAvatarComponent } from '../user-avatar/user-avatar';

/**
 * Home widget listing incoming follow requests to accept/reject, styled like
 * the setup checklist. Renders nothing when there are none (or on TV, where the
 * social surface is hidden). Refreshes live on the `social.follow_request` SSE.
 */
@Component({
  selector: 'app-follow-requests-card',
  imports: [UserAvatarComponent, RouterLink, TranslatePipe, LucideCheck, LucideX],
  templateUrl: './follow-requests-card.html',
})
export class FollowRequestsCardComponent implements OnInit {
  private readonly api = inject(SocialApiService);
  private readonly sse = inject(SseService);
  readonly tv = inject(TvService);

  /** Adds bottom padding when stacked above the home sections. */
  readonly padding = input(false);

  readonly requests = signal<SocialUser[]>([]);
  readonly busyId = signal<number | null>(null);

  constructor() {
    // Prepend a request the moment its SSE arrives, without a round-trip.
    effect(() => {
      if (this.sse.lastEvent()?.type === 'social.follow_request') void this.load();
    });
  }

  ngOnInit(): void {
    if (!this.tv.isTv()) void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.requests.set(await this.api.listRequests({ force: true }));
    } catch {
      /* interceptor surfaces errors */
    }
  }

  async accept(user: SocialUser): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(user.id);
    try {
      await this.api.acceptRequest(user.id);
      this.requests.update((r) => r.filter((u) => u.id !== user.id));
    } finally {
      this.busyId.set(null);
    }
  }

  async reject(user: SocialUser): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(user.id);
    try {
      await this.api.rejectRequest(user.id);
      this.requests.update((r) => r.filter((u) => u.id !== user.id));
    } finally {
      this.busyId.set(null);
    }
  }
}

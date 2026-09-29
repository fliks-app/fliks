import { signal } from '@angular/core';
import { LikesApiService, type LikeTarget } from './api/likes-api.service';

/** Like state of what a media notification shows: the episode of a series,
 *  else the media. `liked` stays null until known, which hides the heart. */
export class NotificationLike {
  readonly liked = signal<boolean | null>(null);
  private target: LikeTarget | null = null;

  constructor(private readonly api: LikesApiService) {}

  async track(mediaId: number | null | undefined, episodeId?: number | null): Promise<void> {
    const target: LikeTarget | null = mediaId
      ? episodeId ? { mediaId, episodeId } : { mediaId }
      : null;
    if (target?.mediaId === this.target?.mediaId && target?.episodeId === this.target?.episodeId) return;
    this.target = target;
    this.liked.set(null);
    if (!target) return;
    const state = await this.api.state(target.mediaId, { force: true }).catch(() => null);
    if (!state || this.target !== target) return;
    this.liked.set(target.episodeId ? state.episodeIds.includes(target.episodeId) : state.media);
  }

  async toggle(): Promise<void> {
    const target = this.target;
    const liked = this.liked();
    if (!target || liked === null) return;
    this.liked.set(!liked);
    try {
      await (liked ? this.api.unlike(target) : this.api.like(target));
    } catch {
      if (this.target === target) this.liked.set(liked);
    }
  }
}

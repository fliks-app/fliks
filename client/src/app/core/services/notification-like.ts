import { effect, signal, untracked } from '@angular/core';
import { LikesApiService, type LikeTarget } from './api/likes-api.service';

/** Like state of what a media notification shows: an item (episode or track) when it names one,
 *  else the media. `liked` stays null until known, which hides the heart. Call from an injection context. */
export class NotificationLike {
  readonly liked = signal<boolean | null>(null);
  private target: LikeTarget | null = null;
  private readSeq = 0;

  constructor(private readonly api: LikesApiService) {
    effect(() => {
      const change = this.api.changed();
      const target = untracked(() => this.target);
      if (change && target?.mediaId === change.mediaId) untracked(() => void this.read(target));
    });
  }

  async track(mediaId: number | null | undefined, itemId?: number | null): Promise<void> {
    const target: LikeTarget | null = mediaId
      ? itemId ? { mediaId, episodeId: itemId } : { mediaId }
      : null;
    if (target?.mediaId === this.target?.mediaId && target?.episodeId === this.target?.episodeId) return;
    this.target = target;
    this.liked.set(null);
    if (target) await this.read(target);
  }

  private async read(target: LikeTarget): Promise<void> {
    const seq = ++this.readSeq;
    const state = await this.api.state(target.mediaId, { force: true }).catch(() => null);
    if (!state || this.target !== target || seq !== this.readSeq) return;
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

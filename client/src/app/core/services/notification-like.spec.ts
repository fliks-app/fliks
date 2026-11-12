import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { LikeState, LikesApiService } from './api/likes-api.service';
import { NotificationLike } from './notification-like';

describe('NotificationLike', () => {
  it('never lets an older read overwrite a newer one', async () => {
    const answers: ((s: LikeState) => void)[] = [];
    const changed = signal<{ mediaId: number } | null>(null);
    const api = { changed, state: vi.fn(() => new Promise<LikeState>((r) => answers.push(r))) } as unknown as LikesApiService;
    const like = runInInjectionContext(TestBed.inject(Injector), () => new NotificationLike(api));
    const first = like.track(7);
    const inner = like as unknown as { target: { mediaId: number }; read(t: { mediaId: number }): Promise<void> };
    const second = inner.read(inner.target);
    answers[1]({ media: true, seasonIds: [], episodeIds: [] });
    await second;
    answers[0]({ media: false, seasonIds: [], episodeIds: [] });
    await first;
    expect(like.liked()).toBe(true);
  });
});

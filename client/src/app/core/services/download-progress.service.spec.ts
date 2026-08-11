import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DownloadProgressService } from './download-progress.service';

describe('DownloadProgressService', () => {
  // Core is bundled with no acquisition plugin installed, so this store must
  // expose no way at all to fetch the download-clients queue — not gated,
  // just gone — otherwise a caller could still reach a plugin route from it.
  it('exposes no seed()/queue-fetching method', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const svc = TestBed.inject(DownloadProgressService) as unknown as Record<string, unknown>;
    expect(svc['seed']).toBeUndefined();
  });

  it('folds an SSE event without any queue fetch', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const svc = TestBed.inject(DownloadProgressService);
    svc.applyProgress({
      mediaId: 1,
      mediaType: 'movie',
      progress: 0.5,
      dlspeed: 100,
      eta: 10,
      state: 'active',
    });
    expect(svc.progress().get(1)?.percent).toBe(50);
  });
});

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { SseService } from './sse.service';
import { DownloadProgressService } from './download-progress.service';
import { ToastService } from './toast.service';
import { ServerConfigService } from './server-config.service';
import { AuthService } from './auth.service';

/**
 * The seam between the wire and the store. `download.progress` carries a media's whole set, so
 * this mapping decides what the badge shows and, just as much, what it stops showing.
 */
function handle(event: Record<string, unknown>): DownloadProgressService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ToastService, useValue: { info: () => {}, success: () => {}, error: () => {}, warning: () => {} } },
      { provide: ServerConfigService, useValue: { apiUrl: () => '' } },
      { provide: AuthService, useValue: { accessToken: () => null, isAuthenticated: () => false } },
    ],
  });
  const store = TestBed.inject(DownloadProgressService);
  const sse = TestBed.inject(SseService) as unknown as { handleEvent(e: unknown): void };
  sse.handleEvent(event);
  return store;
}

const progressEvent = (over: Record<string, unknown> = {}) => ({
  type: 'download.progress',
  mediaId: 1,
  mediaType: 'series',
  downloads: [{ ref: 'aaa', seasonNumber: 1, episodeNumber: 8, progress: 0.4, dlspeed: 10, eta: 60, state: 'paused' }],
  ...over,
});

describe('SseService — download.progress', () => {
  it('maps a snapshot onto the store, field for field', () => {
    const store = handle(progressEvent());
    const leaf = [...store.progress().get(1)!.seasons!.get(1)!.leaves.values()][0]!;
    expect(leaf).toMatchObject({ percent: 40, state: 'paused', episodeNumber: 8, dlspeed: 10, eta: 60 });
  });

  it('an explicit empty set retires the media — that is what a removal looks like', () => {
    const store = handle(progressEvent());
    expect(store.progress().has(1)).toBe(true);

    const sse = TestBed.inject(SseService) as unknown as { handleEvent(e: unknown): void };
    sse.handleEvent(progressEvent({ downloads: [] }));
    expect(store.progress().has(1)).toBe(false);
  });

  it('VERDICT: an event carrying no downloads array is ignored, never read as an empty set', () => {
    const store = handle(progressEvent());
    const sse = TestBed.inject(SseService) as unknown as { handleEvent(e: unknown): void };

    // "Said nothing" and "said nothing is running" are opposite statements; only the second
    // may erase what is on screen.
    sse.handleEvent({ type: 'download.progress', mediaId: 1, mediaType: 'series' });
    sse.handleEvent({ type: 'download.progress', mediaId: 1, mediaType: 'series', downloads: null });

    expect(store.progress().has(1)).toBe(true);
  });
});

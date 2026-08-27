import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { OfflinePlaybackSyncService } from './offline-playback-sync.service';
import { StreamingApiService } from './api/streaming-api.service';
import { NetworkService } from './network.service';
import { StorageScopeService } from './storage-scope.service';
import { AppResumeService } from './app-resume.service';

/** Resolve every already-queued microtask, including chained flush passes. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function setup(opts: { online?: boolean } = {}) {
  const online = signal(opts.online ?? false);
  const updatePlaybackState = vi.fn(async () => ({}));
  const resume$ = new Subject<void>();
  localStorage.clear();

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: StreamingApiService, useValue: { updatePlaybackState } },
      { provide: NetworkService, useValue: { isOnline: online } },
      { provide: StorageScopeService, useValue: { scope: () => 'srv::1', suffix: () => 'srv::1', canPersist: () => true } },
      { provide: AppResumeService, useValue: { resume$ } },
    ],
  });
  const svc = TestBed.inject(OfflinePlaybackSyncService);
  return { svc, online, updatePlaybackState };
}

const update = (positionSeconds: number) => ({
  mediaId: 7,
  mediaFileId: 70,
  positionSeconds,
  durationSeconds: 1000,
});

describe('OfflinePlaybackSyncService', () => {
  it('serves the queued position while it is still unsynced', () => {
    const { svc } = setup();
    svc.queue(update(120));
    expect(svc.queuedPositionFor(7)?.positionSeconds).toBe(120);
  });

  it('overlays the queue on a server progress list', () => {
    const { svc } = setup();
    svc.queue(update(500));
    const [row] = svc.overlayProgress([
      {
        mediaId: 7,
        episodeId: null,
        positionSeconds: 10,
        durationSeconds: 1000,
        progressPercent: 1,
      },
    ]);
    expect(row.positionSeconds).toBe(500);
    expect(row.progressPercent).toBe(50);
  });

  it('keeps the resume point after the queue has drained', async () => {
    const { svc, online } = setup();
    svc.queue(update(300));
    online.set(true);
    await settle();
    expect(svc.queuedPositionFor(7)).toBeNull();
    expect(svc.resumePositionFor(7)?.positionSeconds).toBe(300);
  });

  it('stops the pass at the first failure instead of walking the queue into it', async () => {
    const { svc, online, updatePlaybackState } = setup();
    updatePlaybackState.mockRejectedValue(new Error('offline'));
    svc.queue(update(10));
    svc.queue({ ...update(20), mediaId: 8 });
    online.set(true);
    await settle();
    expect(updatePlaybackState).toHaveBeenCalledTimes(1);
    expect(svc.pending()).toHaveLength(2);
  });

  it('does not drop a position queued while its own PUT was in flight', async () => {
    const { svc, online } = setup({ online: true });
    let release!: () => void;
    const api = TestBed.inject(StreamingApiService) as unknown as {
      updatePlaybackState: ReturnType<typeof vi.fn>;
    };
    api.updatePlaybackState.mockImplementation(
      () => new Promise((r) => (release = () => r({}))),
    );

    svc.queue(update(100));
    await settle();
    // Newer position recorded before the first one is acknowledged.
    svc.queue(update(400));
    release();
    await settle();

    expect(svc.resumePositionFor(7)?.positionSeconds).toBe(400);
    expect(online()).toBe(true);
  });
});

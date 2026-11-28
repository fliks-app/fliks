import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSettingsService } from './app-settings.service';
import { StreamingApiService } from './api/streaming-api.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { CastSettingsService } from './cast-settings.service';
import { NowPlayingMetadataService } from './playback/now-playing-metadata.service';
import { PlaybackHeartbeat } from './playback/playback-heartbeat';
import { PlayerSettingsService } from './player-settings.service';
import { QoeReporter } from './qoe-reporter.service';
import { ServerConfigService } from './server-config.service';
import { TrackManagerService } from './track-manager.service';
import { AuthService } from './auth.service';
import { CastService } from './cast.service';
import { CastPlayerService } from './cast-player.service';
import { NetworkService } from './network.service';
import { SessionSyncService } from './session-sync.service';
import { SseService } from './sse.service';
import { sseStub } from '../../testing/sse.stub';
import { ToastService } from './toast.service';
import { ServerVersionService } from './server-version.service';

type Priv = { reloadCastStream: (...a: unknown[]) => Promise<string>; qoeReporter: unknown; controller: () => Promise<unknown> };

async function setup() {
  const cast = {
    isConnected: signal(true),
    receiverMedia: signal<Record<string, unknown> | null>(null),
    receiverPlays: () => true,
    receiverQoe: signal(null),
    playbackError$: new Subject<{ position?: number; mediaFileId?: number }>(),
    receiverError$: new Subject<object>(),
    saveResumeState: vi.fn(),
    clearResumeState: vi.fn(),
    currentTime: () => 40,
    duration: () => 100,
    isPaused: () => false,
    buffering: () => false,
  };
  const toast = { error: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: ServerVersionService, useValue: { requestAdds: () => true, supports: () => true } },
      provideZonelessChangeDetection(),
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
      { provide: CastService, useValue: cast },
      { provide: NetworkService, useValue: { isOnline: signal(true), connectivityDoubt: signal(0) } },
      { provide: ToastService, useValue: toast },
      { provide: AuthService, useValue: { user: () => ({ id: 1 }) } },
      { provide: CastSettingsService, useValue: {} },
      { provide: StreamingApiService, useValue: {} },
      { provide: SubtitlesApiService, useValue: {} },
      { provide: AppSettingsService, useValue: {} },
      { provide: ServerConfigService, useValue: {} },
      { provide: PlayerSettingsService, useValue: {} },
      { provide: TrackManagerService, useValue: {} },
      { provide: NowPlayingMetadataService, useValue: {} },
      { provide: QoeReporter, useValue: { record: vi.fn() } },
      { provide: SseService, useValue: sseStub() },
      { provide: SessionSyncService, useValue: { registerPlayer: () => () => {} } },
      { provide: PlaybackHeartbeat, useValue: { register: () => () => {}, bank: vi.fn() } },
    ],
  });
  const svc = TestBed.inject(CastPlayerService);
  svc.hasMedia.set(true);
  svc.mediaFileId.set(7);
  const reload = vi.spyOn(svc as unknown as Priv, 'reloadCastStream');
  await (svc as unknown as Priv).controller();
  TestBed.tick();
  return { svc, cast, toast, reload };
}

describe('cast receiver error recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('reloads at the reported position', async () => {
    const { cast, reload, svc } = await setup();
    reload.mockResolvedValue('done');
    (svc as unknown as { recordRecovery: () => void }).recordRecovery = vi.fn();
    cast.playbackError$.next({ position: 12 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledWith(12);
  });

  it('backs off between failing reloads, then toasts once the cap is spent', async () => {
    const { cast, reload, toast } = await setup();
    reload.mockRejectedValue(new Error('boom'));
    cast.playbackError$.next({});
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenLastCalledWith(40);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reload).toHaveBeenCalledTimes(3);
    expect(toast.error).toHaveBeenCalledWith('cast.error.recovery_failed');
  });

  it('treats a refused LOAD as a failed attempt', async () => {
    const { cast, reload } = await setup();
    reload.mockResolvedValue('refused');
    cast.playbackError$.next({});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('leaves an error during a user reload to that reload', async () => {
    const { svc, cast, reload } = await setup();
    svc.reloading.set(true);
    cast.playbackError$.next({});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when the receiver playhead freezes while playing', async () => {
    const { reload } = await setup();
    reload.mockResolvedValue('done');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi, afterEach, describe, it, expect } from 'vitest';
import { PlayerComponent } from './player';
import { PlayerStateService } from '../../core/services/player-state.service';
import { StreamingApiService, PlaybackInfoResponse } from '../../core/services/api/streaming-api.service';
import { MediaService, Media } from '../../core/services/api/media.service';
import { BrowserDeviceProfileService, DeviceProfile } from '../../core/services/browser-device-profile.service';
import { SseService } from '../../core/services/sse.service';
import { AuthService } from '../../core/services/auth.service';
import { CastService } from '../../core/services/cast.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { CastSettingsService } from '../../core/services/cast-settings.service';
import { OfflineStorageService } from '../../core/services/offline-storage.service';
import { OfflinePlaybackSyncService } from '../../core/services/offline-playback-sync.service';
import { AutoDownloadService } from '../../core/services/auto-download.service';
import { NetworkService } from '../../core/services/network.service';
import { DownloadCacheService } from '../../core/services/download-cache.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { NavigationHistoryService } from '../../core/services/navigation-history.service';
import { ToastService } from '../../core/services/toast.service';
import { NavbarService } from '../../core/services/navbar.service';
import { PlaybackQueueService } from '../../core/services/playback-queue.service';
import { TrackManagerService } from '../../core/services/track-manager.service';
import { DeviceService } from '../../core/services/device.service';

/*
 * Angular's vitest builder refuses `vi.mock` on relative specifiers, so the
 * real ShakaEngine (and its `shaka-player` dependency) can't be swapped out
 * that way. These are white-box tests instead: the component is constructed
 * via TestBed (so every injected service, computed and `effect()` is real —
 * only I/O boundaries are faked below), then the pre-roll orchestration
 * methods are driven directly, with `engine` seeded to a plain fake object.
 * `TestBed.tick()` flushes the component's own `effect()`s (registered at
 * construction) without ever calling `ngAfterViewInit` or touching a real
 * playback engine.
 */

async function flush(times = 40) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const MAIN_FILE_ID = 1;
const TRAILER_FILE_ID = 99;
const MEDIA_ID = 10;
const DEVICE_PROFILE = { deviceType: 'desktop', supportsAbr: true } as DeviceProfile;

function buildPi(mediaFileId: number, overrides: Partial<PlaybackInfoResponse> = {}): PlaybackInfoResponse {
  return {
    mediaFileId,
    playMethod: 'DirectPlay',
    playUrl: '',
    contentType: 'video/mp4',
    transcodeReasons: [],
    videoCopyStream: true,
    audioCopyStream: true,
    outputVideoCodec: 'h264',
    outputAudioCodec: 'aac',
    outputContainer: 'mp4',
    hwAccel: 'none',
    tonemapping: false,
    source: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: mediaFileId === TRAILER_FILE_ID ? 30 : 100 },
    sessionId: `sid-${mediaFileId}`,
    ...overrides,
  };
}

function fakeEngine() {
  const loadCalls: { url: string; startTime?: number; mimeType?: string }[] = [];
  return {
    loadCalls,
    currentTime: 0,
    duration: 100,
    resetRecoveryGuard: vi.fn(),
    load: vi.fn(async (url: string, startTime?: number, mimeType?: string) => {
      loadCalls.push({ url, startTime, mimeType });
    }),
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  };
}

const MOVIE: Media = {
  id: MEDIA_ID,
  title: 'Test Movie',
  originalTitle: 'Test Movie',
  year: 2024,
  type: 'movie',
  tmdbId: 1,
  overview: '',
  status: 'released',
  monitored: true,
  posterUrl: null,
  fanartUrl: null,
  logoUrl: null,
  additionalFanartUrls: [],
  rating: 0,
  runtime: 100,
  files: [{ id: MAIN_FILE_ID, quality: '1080p', relativePath: 'x', size: 0, streamInfo: { durationSeconds: 100 } as any }],
};

function createHarness(opts: {
  preRoll?: { mediaFileId: number; labelKey?: string; skippable?: boolean }[];
  trailerPlaybackInfo?: PlaybackInfoResponse | 'reject';
} = {}) {
  const router = {
    getCurrentNavigation: () => null,
    navigate: vi.fn().mockResolvedValue(true),
    navigateByUrl: vi.fn().mockResolvedValue(true),
    url: '/watch/1',
  };
  const getPlaybackInfo = vi.fn(async (mediaFileId: number) => {
    if (mediaFileId === MAIN_FILE_ID) return buildPi(MAIN_FILE_ID, { preRoll: opts.preRoll });
    if (mediaFileId === TRAILER_FILE_ID) {
      if (opts.trailerPlaybackInfo === 'reject') throw new Error('negotiation failed');
      return opts.trailerPlaybackInfo ?? buildPi(TRAILER_FILE_ID);
    }
    return buildPi(mediaFileId);
  });
  const getPlaybackState = vi.fn(async () => null);
  const stopSessions = vi.fn(async () => ({}));
  const updatePlaybackState = vi.fn(async () => ({}));
  const getStreamUrl = vi.fn((id: number, sid?: string) => `stream://${id}?sid=${sid}`);
  const getHlsUrl = vi.fn(
    (id: number, quality?: string, startAt?: number, sid?: string) =>
      `hls://${id}?q=${quality}&startAt=${startAt}&sid=${sid}`,
  );

  const streamingApi = {
    getPlaybackInfo,
    getPlaybackState,
    stopSessions,
    updatePlaybackState,
    getStreamUrl,
    getHlsUrl,
    getStopSessionsUrl: vi.fn(() => 'stop://x'),
    getThumbnailMetadataUrl: vi.fn(() => ''),
    getThumbnailSpriteUrl: vi.fn(() => ''),
    getSubtitleUrl: vi.fn(() => ''),
    getEmbeddedSubtitleUrl: vi.fn(() => ''),
  };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { params: { mediaFileId: String(MAIN_FILE_ID) }, queryParams: {} } },
      },
      {
        provide: Router,
        useValue: router,
      },
      { provide: StreamingApiService, useValue: streamingApi },
      { provide: MediaService, useValue: { getOne: vi.fn(async () => MOVIE) } },
      { provide: BrowserDeviceProfileService, useValue: { getProfile: () => DEVICE_PROFILE } },
      { provide: SseService, useValue: { connectionId: () => null, lastEvent: () => null } },
      {
        provide: AuthService,
        useValue: {
          ensureStreamToken: vi.fn(async () => {}),
          streamToken: () => 'tok',
          accessToken: 'tok',
          user: () => ({ id: 1 }),
        },
      },
      {
        provide: CastService,
        useValue: {
          isConnected: () => false,
          isAvailable: () => false,
          connecting: () => false,
          currentTime: () => 0,
          duration: () => 0,
          disconnect: vi.fn(),
          requestSession: vi.fn(),
          pause: vi.fn(),
          play: vi.fn(),
        },
      },
      {
        provide: CastPlayerService,
        useValue: {
          liveSessionId: () => undefined,
          expanded: { set: vi.fn() },
          getCastDeviceProfile: () => DEVICE_PROFILE,
          reloadCastStream: vi.fn(),
          startCast: vi.fn(),
          clear: vi.fn(),
        },
      },
      { provide: CastSettingsService, useValue: { get: () => ({ maxQuality: 'auto' }) } },
      { provide: ServerConfigService, useValue: { isNative: false, resolveUrl: (u: string) => u } },
      { provide: NavigationHistoryService, useValue: { previousUrl: null } },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      { provide: NavbarService, useValue: { markAsBackNavigation: vi.fn() } },
      {
        provide: PlaybackQueueService,
        useValue: {
          source: () => 'none',
          sourceId: () => undefined,
          active: () => false,
          peekNext: () => null,
          items: () => [],
          index: () => 0,
          advance: () => null,
          setIndex: vi.fn(),
          syncTo: vi.fn(),
          clear: vi.fn(),
          start: vi.fn(),
          autoplay: () => false,
        },
      },
      {
        provide: TrackManagerService,
        useValue: {
          loadSubtitles: vi.fn(async () => []),
          autoSelectSubtitle: vi.fn(async () => {}),
          autoSelectAudioTrack: vi.fn(),
        },
      },
      {
        provide: DeviceService,
        useValue: {
          isTv: () => false,
          isTouch: () => false,
          isDpad: () => false,
          isDesktop: () => true,
          formFactor: () => 'desktop',
          tvPlatform: () => null,
          desktopPlatform: () => null,
        },
      },
      { provide: OfflineStorageService, useValue: { getLocalUrl: vi.fn(), getSmallFileNativeUri: vi.fn() } },
      { provide: OfflinePlaybackSyncService, useValue: { queue: vi.fn() } },
      { provide: AutoDownloadService, useValue: { onItemCompleted: vi.fn(async () => {}) } },
      { provide: NetworkService, useValue: { isOnline: () => true } },
      { provide: DownloadCacheService, useValue: { load: vi.fn(() => []) } },
    ],
  });

  const fixture = TestBed.createComponent(PlayerComponent);
  const component = fixture.componentInstance as any;
  const state = TestBed.inject(PlayerStateService);

  // Seed the state ngAfterViewInit would have produced for a main-item launch.
  component.mediaFileId = MAIN_FILE_ID;
  component.mediaId = MEDIA_ID;
  component.episodeId = undefined;
  component.media = MOVIE;
  component.playbackInfo = buildPi(MAIN_FILE_ID, { preRoll: opts.preRoll });
  component.initCompleted = true;
  const engine = fakeEngine();
  component.engine = engine;

  return {
    fixture,
    component,
    state,
    streamingApi,
    engine,
    router,
    get navigated(): boolean {
      return router.navigate.mock.calls.length > 0;
    },
  };
}

describe('PlayerComponent pre-roll', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('plays the pre-roll item before the main item, then the main item after it ends', async () => {
    const h = createHarness({ preRoll: [{ mediaFileId: TRAILER_FILE_ID, labelKey: 'x' }] });

    await h.component.maybeStartPreRoll(undefined, DEVICE_PROFILE);

    expect(h.component.preRollActive()).toBe(true);
    expect(h.component.mediaFileId).toBe(TRAILER_FILE_ID);
    expect(h.streamingApi.stopSessions).toHaveBeenCalledWith(MAIN_FILE_ID, `sid-${MAIN_FILE_ID}`);

    // preRollAdvanceEffect is what calls advancePreRoll() once state.ended()
    // latches — exercised directly here because Angular's only TestBed hook
    // to flush a live effect (tick()/flushEffects()) also forces a full
    // component render, which would construct a real ShakaEngine (unmockable
    // for a relative import under this project's vitest builder) and crash
    // on unrelated template directives this suite never sets up.
    h.state.ended.set(true);
    await h.component.advancePreRoll();
    await flush();

    expect(h.component.preRollActive()).toBe(false);
    expect(h.component.mediaFileId).toBe(MAIN_FILE_ID);
    expect(h.engine.loadCalls.at(-1)?.url).toBe(`stream://${MAIN_FILE_ID}?sid=sid-${MAIN_FILE_ID}`);
  });

  it('skips pre-roll entirely on a resume launch (startTime > 0)', async () => {
    const h = createHarness({ preRoll: [{ mediaFileId: TRAILER_FILE_ID }] });

    await h.component.maybeStartPreRoll(120, DEVICE_PROFILE);

    expect(h.component.preRollActive()).toBe(false);
    expect(h.component.mediaFileId).toBe(MAIN_FILE_ID);
    // On the recorded ids: `expect.anything()` never matches the `undefined` args this call passes.
    expect(h.streamingApi.getPlaybackInfo.mock.calls.map((c: unknown[]) => c[0])).not.toContain(TRAILER_FILE_ID);
  });

  it('a failing pre-roll negotiation does not stop the main video from playing', async () => {
    const h = createHarness({ preRoll: [{ mediaFileId: TRAILER_FILE_ID }], trailerPlaybackInfo: 'reject' });

    await h.component.maybeStartPreRoll(undefined, DEVICE_PROFILE);

    expect(h.component.preRollActive()).toBe(false);
    expect(h.component.mediaFileId).toBe(MAIN_FILE_ID);
    expect(h.streamingApi.stopSessions).not.toHaveBeenCalled();
  });

  it('records no progress while a pre-roll item is playing', async () => {
    const h = createHarness({ preRoll: [{ mediaFileId: TRAILER_FILE_ID }] });
    await h.component.maybeStartPreRoll(undefined, DEVICE_PROFILE);
    expect(h.component.preRollActive()).toBe(true);

    await h.component.savePosition();

    expect(h.streamingApi.updatePlaybackState).not.toHaveBeenCalled();
  });

  it('skip advances past the current pre-roll item onto the main video', async () => {
    const h = createHarness({ preRoll: [{ mediaFileId: TRAILER_FILE_ID, skippable: true }] });
    await h.component.maybeStartPreRoll(undefined, DEVICE_PROFILE);
    expect(h.component.preRollActive()).toBe(true);
    expect(h.component.preRollSkippable()).toBe(true);

    h.component.skipPreRoll();
    await flush();

    expect(h.component.preRollActive()).toBe(false);
    expect(h.engine.loadCalls.at(-1)?.url).toBe(`stream://${MAIN_FILE_ID}?sid=sid-${MAIN_FILE_ID}`);
  });

  it('an in-place episode advance does not replay pre-roll, and still resumes that episode', async () => {
    const NEXT_FILE_ID = 2;
    // Already on the main item, as for every non-launch reload (advance(), the queue, a retry).
    const h = createHarness();
    // The backend answers `preRoll` on every playback-info call, including a plain in-place
    // reload — the client must ignore it there.
    h.streamingApi.getPlaybackInfo.mockResolvedValueOnce(
      buildPi(NEXT_FILE_ID, { preRoll: [{ mediaFileId: TRAILER_FILE_ID }] }),
    );

    await h.component.reloadForEpisode(NEXT_FILE_ID, MEDIA_ID, undefined);
    await flush();

    expect(h.component.preRollActive()).toBe(false);
    expect(h.streamingApi.getPlaybackInfo.mock.calls.map((c: unknown[]) => c[0])).not.toContain(TRAILER_FILE_ID);
    // A normal reload still looks up where to resume; only a pre-roll transition skips it.
    expect(h.streamingApi.getPlaybackState).toHaveBeenCalled();
    expect(h.engine.loadCalls.at(-1)?.url).toBe(`stream://${NEXT_FILE_ID}?sid=sid-${NEXT_FILE_ID}`);
  });

  it('a pre-roll transition does not resume it from the main film\'s stored position', async () => {
    const h = createHarness({ preRoll: [{ mediaFileId: TRAILER_FILE_ID }] });
    await h.component.maybeStartPreRoll(undefined, DEVICE_PROFILE);
    h.streamingApi.getPlaybackState.mockClear();

    h.component.skipPreRoll();
    await flush();

    // `noResumeLookup`: the stored position belongs to the film, not to what plays before it.
    expect(h.streamingApi.getPlaybackState).not.toHaveBeenCalled();
  });

  it('keeps progress gated while remounting away from a dead pre-roll', async () => {
    const h = createHarness({ preRoll: [{ mediaFileId: TRAILER_FILE_ID }] });
    await h.component.maybeStartPreRoll(undefined, DEVICE_PROFILE);
    expect(h.component.preRollActive()).toBe(true);

    h.component.remountWithoutPreRoll();
    await flush();

    // Teardown calls savePosition on the way out; ungated, the trailer's playhead
    // and duration would be written against the film's row.
    await h.component.savePosition();
    expect(h.streamingApi.updatePlaybackState).not.toHaveBeenCalled();
  });

  it('reaches the main video even when a transition is refused', async () => {
    const h = createHarness({ preRoll: [{ mediaFileId: TRAILER_FILE_ID }] });
    await h.component.maybeStartPreRoll(undefined, DEVICE_PROFILE);
    expect(h.component.preRollActive()).toBe(true);
    // reloadForEpisode refuses silently without an engine, as it does mid-reload.
    h.component.engine = null;

    h.component.skipPreRoll();
    await flush();

    // A refusal must not strand the run on a finished trailer with no way forward.
    expect(h.navigated).toBe(true);
  });

});

describe('PlayerComponent wake / resume', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  /** A clock gap the 1s tick can't explain = the process was frozen. */
  function sleep(component: any, ms: number) {
    component.lastTickAt = Date.now() - ms;
  }

  it('a clock gap warms the existing session instead of reloading the engine', async () => {
    const h = createHarness();
    const fetchMock = vi.fn(async (_url: string) => ({}) as any);
    vi.stubGlobal('fetch', fetchMock);
    h.state.playbackMode.set('transcode');
    h.engine.currentTime = 640;

    sleep(h.component, 10 * 60 * 1000);
    h.component.tickClockWatch();
    await flush();

    // Prewarm rides the live sid at the playhead: this is what revives the
    // backend session and respawns ffmpeg while the user is still paused.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toContain(`sid=sid-${MAIN_FILE_ID}`);
    expect(url).toContain('startAt=640');
    // And a beat goes out now rather than up to 10s later.
    expect(h.streamingApi.updatePlaybackState).toHaveBeenCalled();
    // The whole point: no fresh sid, no engine.load(), so no black frame.
    expect(h.streamingApi.getPlaybackInfo).not.toHaveBeenCalled();
    expect(h.engine.loadCalls.length).toBe(0);
  });

  it('the frozen interval does not read as a stalled playhead', async () => {
    const h = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => ({}) as any));
    h.state.loading.set(false);
    h.state.paused.set(false);
    h.component.lastProgressPos = 640;
    h.component.lastProgressAt = Date.now() - 60_000;
    h.engine.currentTime = 640;
    h.engine.duration = 3600;

    sleep(h.component, 60_000);
    h.component.tickClockWatch();
    h.component.checkStall();
    await flush();

    // A stall recovery here would re-mint the sid and reload the engine.
    expect(h.streamingApi.getPlaybackInfo).not.toHaveBeenCalled();
    expect(h.engine.loadCalls.length).toBe(0);
  });

  it('direct play has no encoder to warm', async () => {
    const h = createHarness();
    const fetchMock = vi.fn(async () => ({}) as any);
    vi.stubGlobal('fetch', fetchMock);
    h.state.playbackMode.set('direct');

    sleep(h.component, 60_000);
    h.component.tickClockWatch();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.streamingApi.updatePlaybackState).toHaveBeenCalled();
  });

  it('a heartbeat lost to the network is retried, not swallowed', async () => {
    const h = createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => ({}) as any));
    h.streamingApi.updatePlaybackState.mockRejectedValueOnce(
      new Error('offline'),
    );

    await h.component.savePosition();
    expect(h.component.resumeDue).toBe(true);

    // Next tick, still online: the resume path runs again on its own.
    h.component.lastTickAt = Date.now();
    h.component.lastResumeAt = 0;
    h.component.lastSaveAt = 0;
    h.component.tickClockWatch();
    await flush();
    expect(h.component.resumeDue).toBe(false);
    expect(h.streamingApi.updatePlaybackState).toHaveBeenCalledTimes(2);
  });

  it('a long buffer explains itself, a short one stays mute', async () => {
    const h = createHarness();
    h.state.loading.set(false);
    h.state.buffering.set(true);

    h.component.lastTickAt = Date.now();
    h.component.tickClockWatch();
    expect(h.component.preparing()).toBe(false);

    h.component.stalledSince = Date.now() - 6_000;
    h.component.lastTickAt = Date.now();
    h.component.tickClockWatch();
    expect(h.component.preparing()).toBe(true);

    h.state.buffering.set(false);
    h.component.lastTickAt = Date.now();
    h.component.tickClockWatch();
    expect(h.component.preparing()).toBe(false);
  });
});

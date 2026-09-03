import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
import { vi, afterEach, describe, it, expect } from 'vitest';
import { PlayerComponent } from './player';
import { PlayerStateService } from '../../core/services/player-state.service';
import { StreamingApiService, PlaybackInfoResponse } from '../../core/services/api/streaming-api.service';
import { MediaService, Media } from '../../core/services/api/media.service';
import { BrowserDeviceProfileService, DeviceProfile } from '../../core/services/browser-device-profile.service';
import { SseService, RemoteCommand } from '../../core/services/sse.service';
import { RemoteService } from '../../core/services/remote.service';
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
    muted: false,
    volume: 1,
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
        provide: RemoteService,
        useValue: {
          validated: new Subject<RemoteCommand>(),
          markApplied: vi.fn(),
          lastAppliedCmdId: () => null,
        },
      },
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
          saveAudioSelection: vi.fn(),
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
      {
        provide: OfflinePlaybackSyncService,
        useValue: { queue: vi.fn(), record: vi.fn(), resumePositionFor: vi.fn(() => null) },
      },
      { provide: AutoDownloadService, useValue: { onItemCompleted: vi.fn(async () => {}) } },
      { provide: NetworkService, useValue: { isOnline: () => true } },
      { provide: DownloadCacheService, useValue: { load: vi.fn(() => []) } },
    ],
  });

  const fixture = TestBed.createComponent(PlayerComponent);
  const component = fixture.componentInstance as any;
  const state = TestBed.inject(PlayerStateService);
  const remoteService = TestBed.inject(RemoteService) as unknown as {
    validated: Subject<RemoteCommand>;
    markApplied: (id: string) => void;
    lastAppliedCmdId: () => string | null;
  };

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
    remoteService,
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

  /** Closing before the seek to the resume point lands must not write the
   *  engine's 0 over it. ExoPlayer renders its first frame before that seek, so
   *  the guard reads the clock rather than `videoStarted`. */
  it.each([false, true])(
    'reports the resume point while the clock still reads 0 (videoStarted=%s)',
    async (started) => {
      const h = createHarness();
      (h.component as unknown as { pendingStartTime: number }).pendingStartTime = 3600;
      h.state.videoStarted.set(started);
      h.engine.currentTime = 0;

      await h.component.savePosition();

      expect(h.streamingApi.updatePlaybackState).toHaveBeenCalledWith(
        MEDIA_ID,
        expect.objectContaining({ positionSeconds: 3600 }),
      );
    },
  );

  it('reports the engine once it moves, and never substitutes again', async () => {
    const h = createHarness();
    const c = h.component as unknown as { pendingStartTime: number };
    c.pendingStartTime = 3600;
    h.engine.currentTime = 12;

    await h.component.savePosition();
    expect(c.pendingStartTime).toBe(0);

    // A later reading of 0 is the truth: the user seeked to the start.
    h.engine.currentTime = 0;
    h.component.lastSaveAt = 0;
    await h.component.savePosition();

    expect(h.streamingApi.updatePlaybackState).toHaveBeenLastCalledWith(
      MEDIA_ID,
      expect.objectContaining({ positionSeconds: 0 }),
    );
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

describe('PlayerComponent seek OSD', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const press = (key: string) =>
    ({ key, keyCode: 0, target: document.body, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as KeyboardEvent;

  function hiddenBar() {
    const h = createHarness();
    const scrubFromKey = vi.fn();
    h.component.controls = () => ({ scrubFromKey });
    h.component.onSeek = vi.fn();
    h.component.controlsVisible.set(false);
    h.component.seekOsd.set(false);
    return { ...h, scrubFromKey };
  }

  it('an arrow on a hidden bar raises the seek-only OSD and hands the press to the seekbar', () => {
    const h = hiddenBar();

    h.component.onKeyDown(press('ArrowRight'));

    expect(h.component.controlsVisible()).toBe(true);
    expect(h.component.seekOsd()).toBe(true);
    // The seekbar owns the scrub: no per-key seek fired from the player.
    expect(h.scrubFromKey).toHaveBeenCalledTimes(1);
    expect(h.component.onSeek).not.toHaveBeenCalled();
  });

  it('a further arrow keeps the OSD, any other key escalates to the full bar', () => {
    const h = hiddenBar();

    h.component.onKeyDown(press('ArrowLeft'));
    h.component.onKeyDown(press('ArrowLeft'));
    expect(h.component.seekOsd()).toBe(true);

    h.component.onKeyDown(press('a'));
    expect(h.component.seekOsd()).toBe(false);
    expect(h.component.controlsVisible()).toBe(true);
  });

  it('hiding from the OSD fades out as-is, without flashing the full bar in', () => {
    const h = hiddenBar();

    h.component.onKeyDown(press('ArrowRight'));
    h.component.hideControls();

    expect(h.component.controlsVisible()).toBe(false);
    // The tier survives the hide: clearing it here would remount every full-bar
    // row for the length of the fade-out.
    expect(h.component.seekOsd()).toBe(true);
    expect(h.component.nativeSubtitleBottomBump()).toBe(0);
  });

  it('cues clear a smaller bar in OSD mode, and sit flush once it hides', () => {
    const h = hiddenBar();
    expect(h.component.nativeSubtitleBottomBump()).toBe(0);

    h.component.onKeyDown(press('ArrowRight'));
    expect(h.component.nativeSubtitleBottomBump()).toBe(5);

    h.component.showControls();
    expect(h.component.nativeSubtitleBottomBump()).toBe(10);
  });
});

describe('PlayerComponent remote control', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function baseCmd(overrides: Partial<RemoteCommand> = {}): RemoteCommand {
    return {
      type: 'remote.command',
      cmdId: 'cmd-1',
      expiresAt: Date.now() + 10_000,
      byTargetId: 'controller-1',
      action: 'pause',
      ...overrides,
    };
  }

  it('a remote pause always pauses, even mid-toggle-coalesce window (absolute, not a toggle)', () => {
    const h = createHarness();
    h.state.paused.set(false);
    // Simulate a local spacebar toggle having just fired, still inside its
    // coalesce window: onTogglePlay() would drop a second call here.
    h.component.lastTogglePlayAt = Date.now();

    h.remoteService.validated.next(baseCmd({ action: 'pause' }));

    expect(h.engine.pause).toHaveBeenCalled();
    expect(h.state.paused()).toBe(true);
  });

  it('a remote mute sets the flag absolutely instead of toggling audible/silent', () => {
    const h = createHarness();
    h.engine.muted = false;
    h.engine.volume = 1;

    h.remoteService.validated.next(baseCmd({ action: 'mute', muted: true }));

    expect(h.engine.muted).toBe(true);
  });

  it('rejects a seek received before duration is known instead of clamping to 0', () => {
    const h = createHarness();
    h.state.duration.set(0);
    h.engine.currentTime = 42;

    h.remoteService.validated.next(baseCmd({ action: 'seek', positionSeconds: 30 }));

    // No clamp-to-0 jump, and no false ack for a command that didn't apply.
    expect(h.engine.currentTime).toBe(42);
    expect(h.remoteService.markApplied).not.toHaveBeenCalled();
  });

  it('reports a locally-driven pause at once instead of at the next save tick', () => {
    const h = createHarness();
    h.state.videoStarted.set(true);
    // The source does not matter (spacebar, click, media key, mpv, TV remote):
    // every one of them lands on the transport flag this reads.
    h.component.reportTransportChange(true);

    expect(h.streamingApi.updatePlaybackState).toHaveBeenCalled();
  });

  it('does not re-report a transport value that has not changed', () => {
    const h = createHarness();
    h.state.videoStarted.set(true);
    h.component.reportTransportChange(true);
    h.streamingApi.updatePlaybackState.mockClear();

    h.component.reportTransportChange(true);

    expect(h.streamingApi.updatePlaybackState).not.toHaveBeenCalled();
  });

  it('stays quiet before the first frame, when the load path moves the flag', () => {
    const h = createHarness();
    h.state.videoStarted.set(false);
    h.streamingApi.updatePlaybackState.mockClear();

    h.component.reportTransportChange(true);

    expect(h.streamingApi.updatePlaybackState).not.toHaveBeenCalled();
  });

  it('resolves a controller-sent audio index against this engine own track ids', () => {
    const h = createHarness();
    // The web engine names tracks by Shaka audioId; a controller only ever
    // knows the streamInfo order, so the index has to be translated.
    h.component.availableAudioTracks.set([
      { id: 'shaka-4', label: 'French', language: 'fr' },
      { id: 'shaka-7', label: 'English', language: 'en' },
    ]);

    h.remoteService.validated.next(baseCmd({ action: 'audio', trackId: 'audio-1' }));

    expect(h.component.activeAudioTrackId()).toBe('shaka-7');
  });

  it('ignores an audio index no local track answers to', () => {
    const h = createHarness();
    h.component.availableAudioTracks.set([
      { id: 'shaka-4', label: 'French', language: 'fr' },
    ]);
    h.component.activeAudioTrackId.set('shaka-4');

    h.remoteService.validated.next(baseCmd({ action: 'audio', trackId: 'audio-9' }));

    expect(h.component.activeAudioTrackId()).toBe('shaka-4');
    expect(h.remoteService.markApplied).not.toHaveBeenCalled();
  });

  it('applying a command acks it and forces an immediate heartbeat', () => {
    const h = createHarness();
    h.state.paused.set(true);

    h.remoteService.validated.next(baseCmd({ action: 'play' }));

    expect(h.engine.play).toHaveBeenCalled();
    expect(h.remoteService.markApplied).toHaveBeenCalledWith('cmd-1');
    expect(h.streamingApi.updatePlaybackState).toHaveBeenCalled();
  });
});

describe('PlayerComponent loading spinner', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  /** Ready to play, nothing painted yet: the state a refused autoplay leaves. */
  function ready() {
    const h = createHarness();
    h.state.loading.set(false);
    h.state.buffering.set(false);
    h.state.videoStarted.set(false);
    h.state.error.set(null);
    return h;
  }

  it('hides the spinner when the browser refused autoplay', () => {
    const h = ready();
    expect(h.component.spinnerVisible()).toBe(true);

    h.component.autoplayBlocked.set(true);

    // The media is ready and paused; the play button under the spinner is the
    // real state, and a spinner over it reads as a stuck load.
    expect(h.component.spinnerVisible()).toBe(false);
  });

  it('keeps the spinner for a genuine load or rebuffer', () => {
    const h = ready();
    h.component.autoplayBlocked.set(true);

    h.state.loading.set(true);
    expect(h.component.spinnerVisible()).toBe(false);

    h.component.autoplayBlocked.set(false);
    expect(h.component.spinnerVisible()).toBe(true);

    h.state.loading.set(false);
    h.state.buffering.set(true);
    expect(h.component.spinnerVisible()).toBe(true);
  });
});

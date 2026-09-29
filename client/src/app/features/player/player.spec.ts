import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixtureAutoDetect, TestBed } from '@angular/core/testing';
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
import { QualityManagerService } from '../../core/services/quality-manager.service';
import { DeviceService } from '../../core/services/device.service';
import { DesktopEngine } from '../../core/services/playback-engine/desktop-engine';

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
  const handlers = new Map<string, Set<(data: any) => void>>();
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
    configure: vi.fn(),
    getVariantTracks: vi.fn(() => [] as any[]),
    getStats: vi.fn(() => ({ droppedFrames: 0 }) as any),
    addTextTrack: vi.fn(async (..._args: any[]) => ({ id: 'track' }) as any),
    selectTextTrack: vi.fn(),
    setTextVisibility: vi.fn(),
    // Minimal pub/sub so tests can wire the real listener method
    // (wireErrorRecovery) and fire an event.
    on: (event: string, handler: (data: any) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (data: any) => void) => {
      handlers.get(event)?.delete(handler);
    },
    emit: (event: string, data: any) => {
      for (const h of handlers.get(event) ?? []) h(data);
    },
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
  const stopSession = vi.fn(async () => ({}));
  const updatePlaybackState = vi.fn(async () => ({}));
  const directUrl = (id: number, sid?: string) => `stream://${id}?sid=${sid}`;
  const getHlsUrl = vi.fn(
    (id: number, quality?: string, startAt?: number, sid?: string) =>
      `hls://${id}?q=${quality}&startAt=${startAt}&sid=${sid}`,
  );
  // Mirrors the real dispatch (DirectPlay -> raw stream, else -> HLS master)
  // via the two mocks above, so existing loadCalls assertions stay valid.
  const buildPlayUrl = vi.fn(
    (
      pi: { mediaFileId: number; playMethod: string; sessionId?: string },
      opts: { sid?: string; startAt?: number; startQuality?: string } = {},
    ) => {
      const sid = opts.sid ?? pi.sessionId;
      return pi.playMethod === 'DirectPlay'
        ? directUrl(pi.mediaFileId, sid)
        : getHlsUrl(pi.mediaFileId, opts.startQuality, opts.startAt, sid);
    },
  );

  const streamingApi = {
    getPlaybackInfo,
    getPlaybackState,
    stopSession,
    updatePlaybackState,
    getHlsUrl,
    buildPlayUrl,
    getStopSessionUrl: vi.fn(() => 'stop://x'),
    getThumbnailMetadataUrl: vi.fn(() => ''),
    getThumbnailSpriteUrl: vi.fn(() => ''),
    getSubtitleUrl: vi.fn(() => ''),
    getEmbeddedSubtitleUrl: vi.fn(() => ''),
  };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      // Never render: tests drive the class, and some wait in real time.
      { provide: ComponentFixtureAutoDetect, useValue: false },
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
      { provide: BrowserDeviceProfileService, useValue: { getProfile: () => DEVICE_PROFILE, whenDesktopProbed: () => Promise.resolve() } },
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
          hasServerFeature: () => true,
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
    expect(h.streamingApi.stopSession).toHaveBeenCalledWith(`sid-${MAIN_FILE_ID}`);

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
    expect(h.streamingApi.stopSession).not.toHaveBeenCalled();
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
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true }) as any);
    vi.stubGlobal('fetch', fetchMock);
    h.state.playbackMode.set('transcode');
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, { playMethod: 'Transcode' });
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as any));
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
    const fetchMock = vi.fn(async () => ({ ok: true }) as any);
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as any));
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
    h.component.chrome.visible.set(false);
    h.component.chrome.seekOsd.set(false);
    return { ...h, scrubFromKey };
  }

  it('an arrow on a hidden bar raises the seek-only OSD and hands the press to the seekbar', () => {
    const h = hiddenBar();

    h.component.onKeyDown(press('ArrowRight'));

    expect(h.component.chrome.visible()).toBe(true);
    expect(h.component.chrome.seekOsd()).toBe(true);
    // The seekbar owns the scrub: no per-key seek fired from the player.
    expect(h.scrubFromKey).toHaveBeenCalledTimes(1);
    expect(h.component.onSeek).not.toHaveBeenCalled();
  });

  it('a further arrow keeps the OSD, any other key escalates to the full bar', () => {
    const h = hiddenBar();

    h.component.onKeyDown(press('ArrowLeft'));
    h.component.onKeyDown(press('ArrowLeft'));
    expect(h.component.chrome.seekOsd()).toBe(true);

    h.component.onKeyDown(press('a'));
    expect(h.component.chrome.seekOsd()).toBe(false);
    expect(h.component.chrome.visible()).toBe(true);
  });

  it('hiding from the OSD fades out as-is, without flashing the full bar in', () => {
    const h = hiddenBar();

    h.component.onKeyDown(press('ArrowRight'));
    h.component.chrome.hide();

    expect(h.component.chrome.visible()).toBe(false);
    // The tier survives the hide: clearing it here would remount every full-bar
    // row for the length of the fade-out.
    expect(h.component.chrome.seekOsd()).toBe(true);
    expect(h.component.nativeSubtitleBottomBump()).toBe(0);
  });

  it('OK on a hidden bar raises it instead of pressing the button it holds', () => {
    const h = hiddenBar();
    const e = press('Enter');

    h.component.onKeyDown(e);

    expect(h.component.chrome.visible()).toBe(true);
    // Swallowed: the first focusable in the bar is the back arrow, and
    // activating it would quit the player.
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('cues clear a smaller bar in OSD mode, and sit flush once it hides', () => {
    const h = hiddenBar();
    expect(h.component.nativeSubtitleBottomBump()).toBe(0);

    h.component.onKeyDown(press('ArrowRight'));
    expect(h.component.nativeSubtitleBottomBump()).toBe(5);

    h.component.chrome.show();
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

describe('PlayerComponent DirectStream URL building', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const DIRECT_STREAM_PI = () =>
    buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`,
    });

  it('never resolves a startQuality while playMethod is DirectStream, in auto', () => {
    const h = createHarness();
    h.component.playbackInfo = DIRECT_STREAM_PI();
    TestBed.inject(QualityManagerService).activeQualityId.set('auto');

    expect(h.component.resolveStartQuality()).toBeUndefined();
  });

  it('never resolves a startQuality while playMethod is DirectStream, even for a no-ABR client in auto', () => {
    const h = createHarness();
    const deviceProfileService = TestBed.inject(BrowserDeviceProfileService) as any;
    deviceProfileService.getProfile = () => ({ ...DEVICE_PROFILE, supportsAbr: false });
    const qm = TestBed.inject(QualityManagerService);
    qm.activeQualityId.set('auto');
    qm.availableQualities.set([
      { id: 'auto', label: 'Auto', height: 0 },
      { id: '1080p', label: '1080p', height: 1080 },
    ]);
    // Without the DirectStream gate, a no-ABR client in auto pins the top rung
    // (proves the gate is doing real work, not vacuously passing on an empty list).
    expect(qm.topRungId()).toBe('1080p');

    h.component.playbackInfo = DIRECT_STREAM_PI();
    expect(h.component.resolveStartQuality()).toBeUndefined();
  });

  it('resolves the picked rung once the backend has re-decided Transcode for it', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, { playMethod: 'Transcode' });
    TestBed.inject(QualityManagerService).activeQualityId.set('720p');

    expect(h.component.resolveStartQuality()).toBe('720p');
  });

  it('picking a rung during a DirectStream session reaches the backend and lands on the transcoded rung', async () => {
    const h = createHarness();
    const qm = TestBed.inject(QualityManagerService);
    qm.availableQualities.set([
      { id: 'auto', label: 'Auto', height: 0 },
      { id: 'original', label: 'Original', height: 1080 },
      { id: '720p', label: '720p', height: 720 },
    ] as any);
    qm.activeQualityId.set('original');
    h.component.playbackInfo = DIRECT_STREAM_PI();
    h.state.playbackMode.set('remux');
    h.streamingApi.getPlaybackInfo.mockResolvedValueOnce(
      buildPi(MAIN_FILE_ID, { playMethod: 'Transcode', playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t` }),
    );

    await h.component.onSelectQualityById('720p');

    // The stale DirectStream decision must not swallow the rung: re-ask with it.
    expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(1);
    expect((h.streamingApi.getPlaybackInfo.mock.calls[0] as any[])[4]).toBe('720p');
    expect(h.state.playbackMode()).toBe('transcode');
    expect(h.engine.loadCalls.length).toBe(1);
    expect(h.engine.loadCalls[0]!.url).toContain('q=720p');
  });

  it('buildPlayUrl carries remux=1 and no startQuality for DirectStream; DirectPlay ignores quality entirely', () => {
    const h = createHarness();
    h.component.playbackInfo = DIRECT_STREAM_PI();
    TestBed.inject(QualityManagerService).activeQualityId.set('auto');

    const { url, mimeType } = h.component.buildPlayUrl({ startTime: 30 });
    expect(mimeType).toBeUndefined();
    expect(h.streamingApi.buildPlayUrl).toHaveBeenCalledWith(
      h.component.playbackInfo,
      expect.objectContaining({ startAt: 30, startQuality: undefined }),
    );
    expect(url).toContain(`hls://${MAIN_FILE_ID}`);
  });

  it('prewarm hits the exact same URL the load path would build for the same position', async () => {
    const h = createHarness();
    h.component.playbackInfo = DIRECT_STREAM_PI();
    h.state.playbackMode.set('remux');
    h.engine.currentTime = 77;
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true }) as any);
    vi.stubGlobal('fetch', fetchMock);

    await h.component.prewarmCurrentStream();

    const prewarmUrl = fetchMock.mock.calls[0]![0];
    const { url: loadUrl } = h.component.buildPlayUrl({ startTime: 77 });
    expect(prewarmUrl).toBe(loadUrl);
  });
});

describe('PlayerComponent remux fallback (rejectCopy)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('re-negotiates once with rejectCopy on an undecodable error while delivering remux, then stops', async () => {
    const h = createHarness();
    h.state.playbackMode.set('remux');
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`,
    });
    h.streamingApi.getPlaybackInfo.mockResolvedValueOnce(
      buildPi(MAIN_FILE_ID, { playMethod: 'Transcode', playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t` }),
    );
    h.component.wireErrorRecovery(h.engine);

    h.engine.emit('error', { source: 'shaka', code: 4032 });
    await flush();

    expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(1);
    expect((h.streamingApi.getPlaybackInfo.mock.calls[0] as any[])[1]).toMatchObject({ rejectCopy: true });
    expect(h.engine.loadCalls.length).toBe(1);
    expect(h.state.playbackMode()).toBe('transcode');

    // A second failure on the same (still undecoded) session must not retry again.
    h.engine.emit('error', { source: 'shaka', code: 4032 });
    await flush();
    expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates the video crop from the new decision and re-adds the active subtitle', async () => {
    const h = createHarness();
    const crop = { width: 1920, height: 800, x: 0, y: 140 };
    h.state.playbackMode.set('remux');
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`,
      videoCopyStream: true,
      source: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 100, crop },
    });
    // Stale crop from before the fallback: replaced, never stacked on a server-side crop.
    h.component.webCrop.videoCropStyle.set({ transform: 'stale' } as any);
    h.component.availableSubtitles.set([
      { id: 'sub-1', label: 'English', url: '/subs/1.vtt', language: 'en', burnIn: false },
    ]);
    h.component.activeSubtitleId.set('sub-1');
    h.engine.addTextTrack.mockResolvedValueOnce({ id: 'sub-1' } as any);
    h.streamingApi.getPlaybackInfo.mockResolvedValueOnce(
      buildPi(MAIN_FILE_ID, {
        playMethod: 'Transcode',
        playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t`,
        videoCopyStream: false, // the backend cropped this re-encode itself
        source: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 100, crop },
      }),
    );
    h.component.wireErrorRecovery(h.engine);

    h.engine.emit('error', { source: 'shaka', code: 4032 });
    await flush();

    expect(h.component.webCrop.videoCropStyle()).toBeNull();
    expect(h.engine.addTextTrack).toHaveBeenCalledWith('/subs/1.vtt', 'en', 'English', undefined);
    expect(h.engine.selectTextTrack).toHaveBeenCalledWith({ id: 'sub-1' });
    expect(h.engine.setTextVisibility).toHaveBeenCalledWith(true);
  });

  it('cards instead of leaving a dead player when another reload never idles', async () => {
    const h = createHarness();
    h.state.playbackMode.set('remux');
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`,
    });
    h.component.reloadingStream = true; // another reload in flight, never clears

    vi.useFakeTimers();
    try {
      const handled = h.component.fallBackFromRemuxOnLoadError({ category: 4, code: 4032 }, 0);
      expect(handled).toBe(true);
      await vi.advanceTimersByTimeAsync(3_100);
    } finally {
      vi.useRealTimers();
    }

    expect(h.streamingApi.getPlaybackInfo).not.toHaveBeenCalled();
    expect(h.state.error()).toBeTruthy();
  });

  it('an error during the still-pending first load waits for it instead of racing a second load()', async () => {
    const h = createHarness();
    h.state.playbackMode.set('remux');
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`,
    });
    h.streamingApi.getPlaybackInfo.mockResolvedValueOnce(
      buildPi(MAIN_FILE_ID, { playMethod: 'Transcode', playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t` }),
    );
    h.component.wireErrorRecovery(h.engine);
    // The first ngAfterViewInit load() sets this and hasn't resolved yet.
    h.component.reloadingStream = true;

    vi.useFakeTimers();
    try {
      h.engine.emit('error', { source: 'shaka', code: 4032 });
      await vi.advanceTimersByTimeAsync(500);
      // Still waiting on the first load: no second load() fired yet.
      expect(h.streamingApi.getPlaybackInfo).not.toHaveBeenCalled();
      expect(h.engine.loadCalls.length).toBe(0);

      // The first load settles.
      h.component.reloadingStream = false;
      await vi.advanceTimersByTimeAsync(200);
    } finally {
      vi.useRealTimers();
    }

    expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(1);
    expect(h.engine.loadCalls.length).toBe(1);
    expect(h.state.playbackMode()).toBe('transcode');
  });
});

describe('PlayerComponent selectSubtitle Cast guard', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('no-ops while casting, so a racing auto-select never reloads the local (unloaded) engine', async () => {
    const h = createHarness();
    // volume/muted are stubbed too: ngOnDestroy's savePosition reads them once
    // isConnected is true, and the harness's default mock doesn't define them.
    h.component.castService.isConnected = () => true;
    h.component.castService.volume = () => 1;
    h.component.castService.muted = () => false;
    h.component.activeBurnInId = 'burn-1';

    await h.component.selectSubtitle({
      id: 'sub-1', label: 'English', url: '/subs/1.vtt', language: 'en',
      burnIn: true, subtitleDbId: 1,
    } as any);

    expect(h.engine.setTextVisibility).not.toHaveBeenCalled();
    expect(h.engine.addTextTrack).not.toHaveBeenCalled();
    expect(h.streamingApi.stopSession).not.toHaveBeenCalled();
    expect(h.component.activeBurnInId).toBe('burn-1');
  });
});

describe('PlayerComponent stats overlay: delivery-based labels', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('labels Direct Play for a raw (non-HLS) stream URL', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, { playMethod: 'DirectPlay' });
    h.component.lastStreamUrl = `stream://${MAIN_FILE_ID}?sid=sid-${MAIN_FILE_ID}`;
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.streamTypeKey).toBe('player.stats_stream_type_direct');
    expect(stats?.mismatch).toBeUndefined();
  });

  it('labels Remux for remux=1 with no startQuality, even with no variant introspection', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, { playMethod: 'DirectStream' });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`;
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.streamTypeKey).toBe('player.stats_stream_type_remux');
    expect(stats?.mismatch).toBeUndefined();
  });

  it('flags the mismatch when remux=1 + startQuality collapses delivery to a transcoded rung', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, { playMethod: 'DirectStream' });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1&startQuality=original`;

    h.component.statsVisible.set(true);
    const stats = h.component.playerStats();

    expect(stats?.streamTypeKey).toBe('player.stats_stream_type_transcode');
    expect(stats?.mismatch).toBeTruthy();
  });

  it('remux without a source video bitrate: remuxMasterBandwidthBps, never a transcode rung target', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      remuxMasterBandwidthBps: 8_000_000,
      // A transcode rung target that would show through if the rateMap
      // lookup ran unconditionally instead of gating on the delivered kind.
      transcodeBitrateByQuality: {
        '1080p': { videoBitrateBps: 1_400_000, audioBitrateBps: 128_000, totalBitrateBps: 1_500_000 },
      },
    });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`;
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.videoStreamBitrate).toBe('8.0 Mbps');
  });

  it('transcode: video bitrate is the active rung\'s rateMap entry', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'Transcode',
      transcodeBitrateByQuality: {
        '720p': { videoBitrateBps: 1_900_000, audioBitrateBps: 128_000, totalBitrateBps: 2_000_000 },
      },
    });
    TestBed.inject(QualityManagerService).activeQualityId.set('720p');
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&startQuality=720p`;
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.videoStreamBitrate).toBe('1.9 Mbps');
  });

  it('direct: video bitrate falls back to the source file bitrate, not a rateMap/remux figure', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectPlay',
      source: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', durationSeconds: 100, videoBitRate: 5_000_000 },
    });
    h.component.lastStreamUrl = `stream://${MAIN_FILE_ID}?sid=sid-${MAIN_FILE_ID}`;
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.videoStreamBitrate).toBe('5.0 Mbps');
  });

  it('audio: a transcoded track shows the measured/rung bitrate, never the source codec bitrate', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'Transcode',
      audioCopyStream: false,
      audioTracks: [{ index: 0, codec: 'dts', copy: false, outputCodec: 'aac', reasonFlags: ['AudioCodecNotSupported'] }],
      source: { container: 'mkv', videoCodec: 'h264', audioCodec: 'dts', audioBitRate: 640_000, durationSeconds: 100 },
    });
    h.component.activeAudioStreamIndex = 0;
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&startQuality=720p`;
    h.component.statsVisible.set(true);
    h.engine.getStats = vi.fn(() => ({
      droppedFrames: 0,
      activeVariant: { audioBandwidth: 128_000 },
    }));

    const stats = h.component.playerStats();
    // Never the source's 640 kbps DTS figure: that's not what's delivered.
    expect(stats?.audioStreamBitrate).toBe('128 kbps');
  });

  it('audio: a copied non-default track reports no figure rather than the source default track\'s bitrate', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      audioCopyStream: true,
      audioTracks: [
        { index: 0, codec: 'aac', copy: true, outputCodec: 'aac', reasonFlags: [] },
        { index: 1, codec: 'ac3', copy: true, outputCodec: 'ac3', reasonFlags: [] },
      ],
      source: { container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', audioBitRate: 128_000, durationSeconds: 100 },
    });
    // Track 1 (AC3) is active; sourceA (128 kbps) describes track 0, not this one.
    h.component.activeAudioStreamIndex = 1;
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`;
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.audioStreamBitrate).toBe('');
  });

  it('hides the audio section for a source with no audio stream', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectPlay',
      audioCopyStream: true,
      audioTracks: [],
      outputAudioCodec: '',
      source: { container: 'mp4', videoCodec: 'h264', audioCodec: '', durationSeconds: 100 },
    });
    h.component.lastStreamUrl = `stream://${MAIN_FILE_ID}?sid=sid-${MAIN_FILE_ID}`;
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.hasAudio).toBe(false);
  });
});

describe('PlayerComponent: playerStats reads deliveredKind from the current stream URL', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('a Transcode URL reports transcode', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, { playMethod: 'Transcode' });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&startQuality=720p`;
    h.component.statsVisible.set(true);
    expect(h.component.playerStats()?.streamTypeKey).toBe('player.stats_stream_type_transcode');
  });

  it('a DirectStream (remux) URL reports remux', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`,
    });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1&sid=sid-${MAIN_FILE_ID}`;
    h.component.statsVisible.set(true);
    expect(h.component.playerStats()?.streamTypeKey).toBe('player.stats_stream_type_remux');
  });
});

describe('PlayerComponent stats overlay: bitrate cascade', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('video: a remux pinned to a quality id does not borrow the transcode ladder target, and prefers the source bitrate over the muxed master bandwidth', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      transcodeBitrateByQuality: {
        '1080p': { videoBitrateBps: 8_000_000, audioBitrateBps: 128_000, totalBitrateBps: 8_128_000 },
      },
      remuxMasterBandwidthBps: 9_000_000,
      source: {
        container: 'mkv', videoCodec: 'hevc', audioCodec: 'aac',
        videoBitRate: 7_500_000, durationSeconds: 100,
      } as any,
    });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`;
    TestBed.inject(QualityManagerService).activeQualityId.set('1080p');
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.videoStreamBitrate).toBe('7.5 Mbps');
  });

  it('video: a genuine transcode still reads the ladder target', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'Transcode',
      transcodeBitrateByQuality: {
        '720p': { videoBitrateBps: 3_000_000, audioBitrateBps: 128_000, totalBitrateBps: 3_128_000 },
      },
      source: { container: 'mkv', videoCodec: 'hevc', audioCodec: 'aac', videoBitRate: 7_500_000, durationSeconds: 100 } as any,
    });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&startQuality=720p`;
    TestBed.inject(QualityManagerService).activeQualityId.set('720p');
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.videoStreamBitrate).toBe('3.0 Mbps');
  });

  it('audio: reads the active track\'s own bitrate/sample rate from playbackInfo.audioTracks', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      audioTracks: [{ index: 0, codec: 'aac', copy: true, outputCodec: 'aac', reasonFlags: [], bitrateBps: 256_000, sampleRate: 48_000 }],
      source: { container: 'mkv', videoCodec: 'hevc', audioCodec: 'ac3', audioBitRate: 640_000, audioSampleRate: 48_000, durationSeconds: 100 } as any,
    });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`;
    h.component.activeAudioStreamIndex = 0;
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.audioStreamBitrate).toBe('256 kbps');
    expect(stats?.audioDetailLine).toBe('48000 Hz');
  });

  it('audio: shows nothing (not the source\'s primary-stream numbers) when the backend sends no per-track bitrate for a non-DirectPlay delivery', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      audioTracks: [{ index: 0, codec: 'aac', copy: true, outputCodec: 'aac', reasonFlags: [] }],
      source: { container: 'mkv', videoCodec: 'hevc', audioCodec: 'ac3', audioBitRate: 640_000, audioSampleRate: 48_000, durationSeconds: 100 } as any,
    });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`;
    h.component.activeAudioStreamIndex = 0;
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.audioStreamBitrate).toBe('');
    expect(stats?.audioDetailLine).toBe('');
  });

  it('audio: DirectPlay falls back to the source values (byte-identical to the active track)', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectPlay',
      source: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', audioBitRate: 192_000, audioSampleRate: 44_100, durationSeconds: 100 } as any,
    });
    h.component.lastStreamUrl = `stream://${MAIN_FILE_ID}?sid=sid-${MAIN_FILE_ID}`;
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.audioStreamBitrate).toBe('192 kbps');
    expect(stats?.audioDetailLine).toBe('44100 Hz');
  });
});

describe('PlayerComponent: cropAppliedByPlayer reads what was actually applied', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('web: true once videoCropStyle is set, independent of the delivery kind', () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'Transcode',
      source: { container: 'mkv', videoCodec: 'hevc', audioCodec: 'aac', durationSeconds: 100, crop: { width: 1000, height: 1000, x: 0, y: 0 } } as any,
    });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&startQuality=720p`;
    h.component.statsVisible.set(true);
    expect(h.component.playerStats()?.cropAppliedByPlayer).toBe(false);

    h.component.webCrop.videoCropStyle.set({ width: 100, height: 100, translateX: 0, translateY: 0 });
    expect(h.component.playerStats()?.cropAppliedByPlayer).toBe(true);
  });

  it('desktop: reads the flag applyVideoCrop set on its mpv configure() call, not the delivery kind', () => {
    const h = createHarness();
    h.component.isDesktopNative = true;
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      videoCopyStream: true,
      source: { container: 'mkv', videoCodec: 'hevc', audioCodec: 'aac', durationSeconds: 100, crop: { width: 1000, height: 1000, x: 0, y: 0 } } as any,
    });
    h.component.lastStreamUrl = `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`;
    h.component.statsVisible.set(true);

    h.component.applyVideoCrop();
    expect(h.component.playerStats()?.cropAppliedByPlayer).toBe(true);

    h.component.playbackInfo.videoCopyStream = false;
    h.component.applyVideoCrop();
    expect(h.component.playerStats()?.cropAppliedByPlayer).toBe(false);
  });
});

describe('PlayerComponent: desktop far-seek reload gating', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function desktopHarness() {
    const h = createHarness();
    h.component.isDesktopNative = true;
    Object.setPrototypeOf(h.engine, DesktopEngine.prototype);
    h.engine.currentTime = 10;
    (h.engine as any)._buffered = 12;
    h.component.availableAudioTracks.set([
      { id: 'a', label: 'A', language: 'en' },
      { id: 'b', label: 'B', language: 'fr' },
    ]);
    return h;
  }

  it('applies to a multi-audio remux master too, not only transcode', () => {
    const h = desktopHarness();
    h.state.playbackMode.set('remux');
    expect(h.component.desktopFarSeekNeedsReload(200)).toBe(true);
  });

  it('still applies to a multi-audio transcode master', () => {
    const h = desktopHarness();
    h.state.playbackMode.set('transcode');
    expect(h.component.desktopFarSeekNeedsReload(200)).toBe(true);
  });

  it('never applies to DirectPlay (one raw file, no child playlists)', () => {
    const h = desktopHarness();
    h.state.playbackMode.set('direct');
    expect(h.component.desktopFarSeekNeedsReload(200)).toBe(false);
  });

  it('never applies with a single audio track, regardless of mode', () => {
    const h = desktopHarness();
    h.component.availableAudioTracks.set([{ id: 'a', label: 'A', language: 'en' }]);
    h.state.playbackMode.set('remux');
    expect(h.component.desktopFarSeekNeedsReload(200)).toBe(false);
  });
});

describe('PlayerComponent: refreshSidAndReload adopts the fresh decision', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('updates playbackMode and re-applies crop from the NEW pi, not just quality', async () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      videoCopyStream: true,
      source: { container: 'mkv', videoCodec: 'hevc', audioCodec: 'aac', durationSeconds: 100, crop: { width: 1000, height: 800, x: 0, y: 100 } } as any,
    });
    h.state.playbackMode.set('remux');
    h.streamingApi.getPlaybackInfo.mockResolvedValueOnce(
      buildPi(MAIN_FILE_ID, {
        playMethod: 'Transcode',
        videoCopyStream: false,
        source: { container: 'mkv', videoCodec: 'hevc', audioCodec: 'aac', durationSeconds: 100, crop: { width: 1000, height: 800, x: 0, y: 100 } } as any,
      }),
    );

    await h.component.refreshSidAndReload(30, { preservePause: false, unmute: false });

    expect(h.state.playbackMode()).toBe('transcode');
    // videoCopyStream flipped false server-side (it re-encoded): the client must not double-crop.
    expect(h.component.webCrop.videoCropStyle()).toBeNull();
  });
});

describe('PlayerComponent reloadStream: startAt', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('passes the live position as startAt, never the backend-saved DB position', async () => {
    const h = createHarness();
    h.engine.currentTime = 456;

    await h.component.reloadStream();

    expect((h.streamingApi.getPlaybackInfo.mock.calls[0] as any[])[5]).toBe(456);
  });

  it('passes 0 explicitly rather than omitting it, so a restart-to-0 overrides a stale saved position', async () => {
    const h = createHarness();
    h.engine.currentTime = 0;

    await h.component.reloadStream();

    expect((h.streamingApi.getPlaybackInfo.mock.calls[0] as any[])[5]).toBe(0);
  });
});

describe('PlayerComponent remux fallback on a rejected load', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const REMUX_PI = (sid = `sid-${MAIN_FILE_ID}`) =>
    buildPi(MAIN_FILE_ID, {
      playMethod: 'DirectStream',
      playUrl: `/api/stream/${MAIN_FILE_ID}/master.m3u8?token=t&remux=1`,
      sessionId: sid,
    });
  const TRANSCODE_PI = () =>
    buildPi(MAIN_FILE_ID, { playMethod: 'Transcode', sessionId: 'sid-transcode' });
  const UNDECODABLE = Object.assign(new Error('unsupported'), { category: 4, code: 4032 });
  const rejectCopyOf = (h: any, call: number) =>
    (h.streamingApi.getPlaybackInfo.mock.calls[call] as any[])[1].rejectCopy;

  function failFirstLoad(h: any): void {
    h.engine.load.mockImplementationOnce(async () => {
      throw UNDECODABLE;
    });
  }

  it('reloadStream: a Shaka load-time fatal on a remux re-negotiates with rejectCopy at the same anchor', async () => {
    const h = createHarness();
    h.component.playbackInfo = REMUX_PI('sid-old');
    h.state.playbackMode.set('remux');
    h.engine.currentTime = 42;
    h.streamingApi.getPlaybackInfo
      .mockResolvedValueOnce(REMUX_PI('sid-new'))
      .mockResolvedValueOnce(TRANSCODE_PI());
    failFirstLoad(h);

    await h.component.reloadStream();

    await vi.waitFor(() => expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.state.playbackMode()).toBe('transcode'));
    expect(rejectCopyOf(h, 0)).toBeUndefined();
    expect(rejectCopyOf(h, 1)).toBe(true);
    expect(h.engine.loadCalls.at(-1)!.startTime).toBe(42);
    expect(h.state.error()).toBeNull();
  });

  it('reloadStream: a load-time fatal on DirectPlay also re-negotiates with rejectCopy (not remux-only)', async () => {
    const h = createHarness();
    h.component.playbackInfo = buildPi(MAIN_FILE_ID, { playMethod: 'DirectPlay', sessionId: 'sid-old' });
    h.state.playbackMode.set('direct');
    h.engine.currentTime = 12;
    h.streamingApi.getPlaybackInfo
      .mockResolvedValueOnce(buildPi(MAIN_FILE_ID, { playMethod: 'DirectPlay', sessionId: 'sid-new' }))
      .mockResolvedValueOnce(TRANSCODE_PI());
    failFirstLoad(h);

    await h.component.reloadStream();

    await vi.waitFor(() => expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.state.playbackMode()).toBe('transcode'));
    expect(rejectCopyOf(h, 1)).toBe(true);
    expect(h.state.error()).toBeNull();
  });

  it('reloadForEpisode: the new file falls back when its remux fails to load', async () => {
    const h = createHarness();
    h.component.mediaFileId = 7;
    h.streamingApi.getPlaybackInfo
      .mockResolvedValueOnce(REMUX_PI('sid-ep'))
      .mockResolvedValueOnce(TRANSCODE_PI());
    failFirstLoad(h);

    await h.component.reloadForEpisode(MAIN_FILE_ID, MEDIA_ID, undefined, { noResumeLookup: true });

    await vi.waitFor(() => expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(2));
    expect(rejectCopyOf(h, 1)).toBe(true);
    expect(h.state.error()).toBeNull();
  });

  it('refreshSidAndReload: a recovery reload that lands on an undecodable remux falls back', async () => {
    const h = createHarness();
    h.component.playbackInfo = REMUX_PI('sid-old');
    h.state.playbackMode.set('remux');
    h.streamingApi.getPlaybackInfo
      .mockResolvedValueOnce(REMUX_PI('sid-recovered'))
      .mockResolvedValueOnce(TRANSCODE_PI());
    failFirstLoad(h);

    await h.component.refreshSidAndReload(30, { preservePause: false, unmute: false });

    await vi.waitFor(() => expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(2));
    expect(rejectCopyOf(h, 1)).toBe(true);
    expect(h.engine.loadCalls.at(-1)!.startTime).toBe(30);
  });

  it('seekByReload: hands the far seek to the fallback instead of polling under its guard', async () => {
    const h = createHarness();
    h.component.playbackInfo = REMUX_PI('sid-old');
    h.state.playbackMode.set('remux');
    h.state.seekLocked.set(true);
    h.streamingApi.getPlaybackInfo
      .mockResolvedValueOnce(REMUX_PI('sid-seek'))
      .mockResolvedValueOnce(TRANSCODE_PI());
    failFirstLoad(h);

    await h.component.seekByReload(600);

    expect(h.state.seekLocked()).toBe(false);
    await vi.waitFor(() => expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(2));
    expect(rejectCopyOf(h, 1)).toBe(true);
    await vi.waitFor(() => expect(h.engine.loadCalls.at(-1)!.startTime).toBe(600));
  });

  it('initial load: the catch hands the rejection to the same gate, which absorbs a duplicate report', async () => {
    const h = createHarness();
    h.component.playbackInfo = REMUX_PI();
    h.state.playbackMode.set('remux');
    h.streamingApi.getPlaybackInfo.mockResolvedValueOnce(TRANSCODE_PI());
    h.component.wireErrorRecovery(h.engine);

    // Shaka can both emit `error` and reject load() for the same failure.
    h.engine.emit('error', { source: 'shaka', code: 4032 });
    const onRecovered = vi.fn();
    expect(h.component.fallBackFromRemuxOnLoadError(UNDECODABLE, 12, onRecovered)).toBe(true);

    await vi.waitFor(() => expect(h.state.playbackMode()).toBe('transcode'));
    expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(1);
    // The catch's post-load setup still runs though the event started the fallback.
    await vi.waitFor(() => expect(onRecovered).toHaveBeenCalledTimes(1));
    // Settled on the transcode: a later failure is no longer the copy's, so it cards normally.
    expect(h.component.fallBackFromRemuxOnLoadError(UNDECODABLE, 12)).toBe(false);
  });

  it('rejectCopy sticks for the file: a later reload without a fresh failure still sends it', async () => {
    const h = createHarness();
    h.component.playbackInfo = REMUX_PI();
    h.state.playbackMode.set('remux');
    h.streamingApi.getPlaybackInfo.mockResolvedValue(TRANSCODE_PI());
    h.component.wireErrorRecovery(h.engine);

    h.engine.emit('error', { source: 'shaka', code: 4032 });
    await vi.waitFor(() => expect(h.streamingApi.getPlaybackInfo).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.component.reloadingStream).toBe(false));

    await h.component.refreshSidAndReload(5, { preservePause: false, unmute: false });
    await h.component.reloadStream();
    expect(rejectCopyOf(h, 1)).toBe(true);
    expect(rejectCopyOf(h, 2)).toBe(true);
  });
});

describe('PlayerComponent stats overlay: offline delivery', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('claims no delivery kind or copy mode for an offline copy whose packaging is not recorded', () => {
    const h = createHarness();
    h.component.isOfflinePlayback = true;
    h.component.playbackInfo = null;
    h.component.lastStreamUrl = 'offline:123';
    h.component.statsVisible.set(true);

    const stats = h.component.playerStats();
    expect(stats?.streamTypeKey).toBe('');
    expect(stats?.outputFormat).toBe('');
    expect(stats?.videoPlaybackMode).toBe('');
    expect(stats?.audioPlaybackMode).toBe('');
    expect(stats?.mismatch).toBeUndefined();
  });
});

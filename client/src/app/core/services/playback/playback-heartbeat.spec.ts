import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heartbeatOutput } from '../../../testing/heartbeat-output.stub';
import { StreamingApiService } from '../api/streaming-api.service';
import { AuthService } from '../auth.service';
import { AutoDownloadService } from '../auto-download.service';
import { NetworkService } from '../network.service';
import { OfflinePlaybackSyncService } from '../offline-playback-sync.service';
import { QoeReporter } from '../qoe-reporter.service';
import { RemoteService } from '../remote.service';
import { ServerConfigService } from '../server-config.service';
import { SessionSyncService } from '../session-sync.service';
import { HEARTBEAT_MS, PlaybackHeartbeat, type HeartbeatSource } from './playback-heartbeat';
import { PlaybackSession } from './playback-session';

function setup() {
  const online = { value: true };
  const kind = { value: 'local' };
  const streamingApi = { updatePlaybackState: vi.fn(async (..._a: unknown[]): Promise<object | null> => ({})) };
  const offlineSync = { queue: vi.fn(), record: vi.fn() };
  const qoe = { flush: vi.fn() };
  const sessionSync = { handleSuperseded: vi.fn() };
  const autoDownload = { onItemCompleted: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: StreamingApiService, useValue: streamingApi },
      { provide: AuthService, useValue: { ensureStreamToken: vi.fn(async () => 'st'), accessToken: 'tok' } },
      { provide: NetworkService, useValue: { isOnline: () => online.value } },
      { provide: OfflinePlaybackSyncService, useValue: offlineSync },
      { provide: AutoDownloadService, useValue: autoDownload },
      { provide: SessionSyncService, useValue: sessionSync },
      { provide: RemoteService, useValue: { lastAppliedCmdId: () => 'c1', lastCmdRefused: () => 'busy' } },
      { provide: QoeReporter, useValue: qoe },
      { provide: ServerConfigService, useValue: { resolveUrl: (u: string) => u } },
      { provide: PlaybackSession, useValue: { kind: () => kind.value } },
    ],
  });
  return { hb: TestBed.inject(PlaybackHeartbeat), streamingApi, offlineSync, qoe, sessionSync, autoDownload, online, kind };
}

function source(mediaId: number, over: Partial<HeartbeatSource> & { out?: Record<string, unknown> } = {}): HeartbeatSource {
  const { out, ...hooks } = over;
  const output = heartbeatOutput({ sessionId: () => `s${mediaId}`, ...out });
  return {
    output: () => output,
    item: () => ({ mediaId, fileId: mediaId * 10, episodeId: undefined }),
    reportable: () => true,
    extras: () => ({}),
    onLostSession: vi.fn(),
    ...hooks,
  };
}

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

describe('PlaybackHeartbeat, one beater while casting', () => {
  it('beats once per tick when a player page and a cast session are both registered, for the page', async () => {
    vi.useFakeTimers();
    const { hb, streamingApi } = setup();
    const receiver = source(2);
    const receiverOutput = vi.spyOn(receiver, 'output');
    hb.register(source(1), 'page');
    hb.register(receiver, 'receiver');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(streamingApi.updatePlaybackState).toHaveBeenCalledTimes(1);
    expect(streamingApi.updatePlaybackState).toHaveBeenCalledWith(1, expect.objectContaining({ sessionId: 's1' }));
    expect(receiverOutput).not.toHaveBeenCalled();
  });

  it('beats for the receiver, not the page, while the session plays on Cast', async () => {
    vi.useFakeTimers();
    const { hb, streamingApi, kind } = setup();
    kind.value = 'cast';
    hb.register(source(1), 'page');
    hb.register(source(2), 'receiver');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(streamingApi.updatePlaybackState).toHaveBeenCalledTimes(1);
    expect(streamingApi.updatePlaybackState).toHaveBeenCalledWith(2, expect.objectContaining({ sessionId: 's2' }));
  });

  it('beats once per tick for the cast session alone', async () => {
    vi.useFakeTimers();
    const { hb, streamingApi, kind } = setup();
    kind.value = 'cast';
    hb.register(source(2), 'receiver');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(streamingApi.updatePlaybackState).toHaveBeenCalledTimes(1);
    expect(streamingApi.updatePlaybackState).toHaveBeenCalledWith(2, expect.objectContaining({ sessionId: 's2' }));
  });

  it('keeps the cast session beating once the page unregisters', async () => {
    vi.useFakeTimers();
    const { hb, streamingApi, kind } = setup();
    kind.value = 'cast';
    const unregisterPage = hb.register(source(1), 'page');
    hb.register(source(2), 'receiver');
    unregisterPage();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(streamingApi.updatePlaybackState).toHaveBeenCalledTimes(1);
    expect(streamingApi.updatePlaybackState).toHaveBeenCalledWith(2, expect.anything());
  });

  it('stops its cadence with the last registration', async () => {
    vi.useFakeTimers();
    const { hb, streamingApi } = setup();
    hb.register(source(1), 'page')();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(streamingApi.updatePlaybackState).not.toHaveBeenCalled();
  });
});

describe('PlaybackHeartbeat payload and handling', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('builds the body from the output and the source extras', async () => {
    t.hb.register(source(1, { extras: () => ({ castDevice: 'TV', episodeLabel: 'E1' }) }), 'page');
    await t.hb.beat();
    expect(t.streamingApi.updatePlaybackState).toHaveBeenCalledWith(1, {
      positionSeconds: 30,
      durationSeconds: 100,
      mediaFileId: 10,
      episodeId: undefined,
      castDevice: 'TV',
      episodeLabel: 'E1',
      sessionId: 's1',
      state: 'playing',
      volume: 1,
      muted: false,
      lastCmdId: 'c1',
      lastCmdRefused: 'busy',
      quality: 'auto',
      qualities: [],
      audioTrackIndex: null,
      supportsVolume: true,
      subtitleId: null,
      autoplayBlocked: false,
      hasNext: false,
    });
  });

  it('beats at playhead 0 and carries no session fields without a session id', async () => {
    t.hb.register(source(1, { out: { position: () => 0, sessionId: () => undefined } }), 'page');
    await t.hb.beat();
    expect(t.streamingApi.updatePlaybackState).toHaveBeenCalledWith(1, { positionSeconds: 0, durationSeconds: 100, mediaFileId: 10, episodeId: undefined });
  });

  it('skips an output that another device reports for, and a source with nothing to report', async () => {
    t.hb.register(source(1, { out: { reportsHere: () => false } }), 'page');
    await t.hb.beat();
    t.hb.register(source(2, { reportable: () => false }), 'page');
    await t.hb.beat();
    expect(t.streamingApi.updatePlaybackState).not.toHaveBeenCalled();
  });

  it('lets the source correct the reading, and drops a non-finite one', async () => {
    const unregister = t.hb.register(source(1, { out: { position: () => 0 }, reading: ({ duration }) => ({ position: 42, duration }) }), 'page');
    await t.hb.beat();
    expect(t.streamingApi.updatePlaybackState).toHaveBeenCalledWith(1, expect.objectContaining({ positionSeconds: 42 }));
    t.streamingApi.updatePlaybackState.mockClear();
    unregister();
    t.hb.register(source(2, { out: { position: () => NaN } }), 'page');
    await t.hb.beat(true);
    expect(t.streamingApi.updatePlaybackState).not.toHaveBeenCalled();
  });

  it('throttles to one beat per 2 s unless forced', async () => {
    t.hb.register(source(1), 'page');
    await t.hb.beat();
    await t.hb.beat();
    expect(t.streamingApi.updatePlaybackState).toHaveBeenCalledTimes(1);
    await t.hb.bank();
    expect(t.streamingApi.updatePlaybackState).toHaveBeenCalledTimes(2);
  });

  it('coalesces forced beats fired together into one trailing beat, never dropping the last', async () => {
    vi.useFakeTimers();
    t.hb.register(source(1), 'page');
    await t.hb.beat(true);
    await t.hb.beat(true);
    await t.hb.beat(true);
    expect(t.streamingApi.updatePlaybackState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(t.streamingApi.updatePlaybackState).toHaveBeenCalledTimes(2);
  });

  it('beatIfDue waits for the cadence since the last beat', async () => {
    t.hb.register(source(1), 'page');
    t.hb.lastSaveAt = Date.now() - 4_000;
    t.hb.beatIfDue();
    expect(t.streamingApi.updatePlaybackState).not.toHaveBeenCalled();
    t.hb.lastSaveAt = Date.now() - HEARTBEAT_MS - 500;
    t.hb.beatIfDue();
    expect(t.streamingApi.updatePlaybackState).toHaveBeenCalledTimes(1);
  });

  it('hands the background hook the body without the QoE sample, and a token', async () => {
    const background = vi.fn(async ({ token }: { token: () => Promise<string | null> }) => void (await token()));
    t.hb.register(source(1, { background, extras: () => ({ qoe: { engine: 'x' } as never }) }), 'page');
    await t.hb.beat();
    const beat = background.mock.calls[0][0] as unknown as { url: string; body: { qoe?: unknown } };
    expect(beat.url).toBe('/api/playback/media/1/state');
    expect(beat.body.qoe).toBeUndefined();
    expect(t.streamingApi.updatePlaybackState).toHaveBeenCalledWith(1, expect.objectContaining({ qoe: { engine: 'x' } }));
  });

  it('flushes the session events after each beat', async () => {
    t.hb.register(source(1), 'page');
    await t.hb.beat();
    expect(t.qoe.flush).toHaveBeenCalledWith('s1');
  });

  it('records the beat on the happy path and reports a completed item', async () => {
    t.streamingApi.updatePlaybackState.mockResolvedValueOnce({ state: { completed: true } });
    t.hb.register(source(1), 'page');
    await t.hb.beat();
    expect(t.offlineSync.record).toHaveBeenCalledWith({ mediaId: 1, mediaFileId: 10, episodeId: undefined, positionSeconds: 30, durationSeconds: 100 });
    expect(t.autoDownload.onItemCompleted).toHaveBeenCalledWith(10);
  });

  it('hands a lost session to the source, unless the output has moved to another session', async () => {
    let current = 's1';
    const onLostSession = vi.fn();
    t.hb.register(source(1, { out: { sessionId: () => current }, onLostSession }), 'page');
    t.streamingApi.updatePlaybackState.mockResolvedValueOnce({ sessionLost: true });
    await t.hb.beat();
    expect(onLostSession).toHaveBeenCalledWith(30);
    t.streamingApi.updatePlaybackState.mockImplementationOnce(async () => ((current = 's2'), { sessionLost: true }));
    await t.hb.bank();
    expect(onLostSession).toHaveBeenCalledTimes(1);
  });

  it('stops for a takeover instead of recovering the session', async () => {
    const onLostSession = vi.fn();
    t.hb.register(source(1, { onLostSession }), 'page');
    t.streamingApi.updatePlaybackState.mockResolvedValueOnce({ sessionLost: true, superseded: true });
    await t.hb.beat();
    expect(t.sessionSync.handleSuperseded).toHaveBeenCalledWith('s1');
    expect(onLostSession).not.toHaveBeenCalled();
  });

  it('queues the position and tells the source when the beat fails or the device is offline', async () => {
    const onBeatFailed = vi.fn();
    t.hb.register(source(1, { onBeatFailed }), 'page');
    t.streamingApi.updatePlaybackState.mockRejectedValueOnce(new Error('network'));
    await t.hb.beat();
    expect(t.offlineSync.queue).toHaveBeenCalledTimes(1);
    expect(onBeatFailed).toHaveBeenCalledTimes(1);
    t.online.value = false;
    await t.hb.bank();
    expect(t.offlineSync.queue).toHaveBeenCalledTimes(2);
    expect(onBeatFailed).toHaveBeenCalledTimes(2);
  });

  it('drops a beat the server refused instead of queueing it', async () => {
    const onBeatFailed = vi.fn();
    t.hb.register(source(1, { onBeatFailed }), 'page');
    t.streamingApi.updatePlaybackState.mockRejectedValueOnce(new HttpErrorResponse({ status: 409 }));
    await t.hb.beat();
    expect(t.offlineSync.queue).not.toHaveBeenCalled();
    expect(onBeatFailed).not.toHaveBeenCalled();
  });
});

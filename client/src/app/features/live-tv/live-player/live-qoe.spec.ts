import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_HEARTBEAT_MS, LiveQoe } from './live-qoe';
import type { PlaybackEngine } from '../../../core/services/playback-engine/playback-engine';
import type { QoeReporter } from '../../../core/services/qoe-reporter.service';

const engineSample = {
  engine: 'shaka',
  cmcd: true,
  droppedFrames: 0,
  decodedFrames: 100,
  bandwidthBps: 5e6,
  bufferAheadS: 4,
  variantBitrate: 2e6,
  width: 1280,
  height: 720,
  videoCodec: 'avc1',
  decoderName: null,
  hwDecoder: null,
};

function setup() {
  const engine = { currentTime: 0, getQoeSample: vi.fn().mockResolvedValue(engineSample) };
  const reporter = { record: vi.fn(), flush: vi.fn(), flushKeepalive: vi.fn() };
  const beat = vi.fn().mockResolvedValue(undefined);
  const live = new LiveQoe(reporter as unknown as QoeReporter, beat);
  const eng = () => engine as unknown as PlaybackEngine;
  return { engine, reporter, beat, live, eng };
}

describe('LiveQoe', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a heartbeat every 10 s with the sample and a per-tune-in playbackId', async () => {
    const { live, beat, eng, engine } = setup();
    live.begin('s1', eng);
    live.onState('playing');
    for (let i = 1; i <= 10; i++) {
      engine.currentTime = i;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(beat).toHaveBeenCalledTimes(1);
    const [sid, qoe] = beat.mock.calls[0];
    expect(sid).toBe('s1');
    expect(qoe).toMatchObject({ engine: 'shaka', cmcd: true, stallCount: 0 });
    const first = qoe.playbackId;
    expect(first).toBeTruthy();

    live.begin('s2', eng);
    live.onState('playing');
    for (let i = 1; i <= 10; i++) {
      engine.currentTime = 100 + i;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(beat.mock.calls[1][0]).toBe('s2');
    expect(beat.mock.calls[1][1].playbackId).not.toBe(first);
  });

  it('counts a frozen playhead as a stall and records it on the session', async () => {
    const { live, beat, eng, reporter } = setup();
    live.begin('s1', eng);
    live.onState('playing');
    await vi.advanceTimersByTimeAsync(3_000);
    // The playhead never moved and the engine never said buffering.
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS - 3_000);
    expect(beat.mock.calls[0][1].stallCount).toBe(1);
    live.end();
    expect(reporter.record).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'stall', variantBitrate: 2e6 }),
      false,
      expect.any(String),
    );
  });

  it('does not count a stall while paused or right after a seek', async () => {
    const { live, beat, eng } = setup();
    live.begin('s1', eng);
    live.onState('playing');
    live.onState('paused');
    await vi.advanceTimersByTimeAsync(5_000);
    live.onState('playing');
    live.onSeek();
    live.onState('buffering');
    await vi.advanceTimersByTimeAsync(1_500);
    live.onState('playing');
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    expect(beat.mock.calls.at(-1)?.[1].stallCount).toBe(0);
  });

  it('stops beating once ended and flushes events, keepalive on page exit', async () => {
    const { live, beat, eng, reporter } = setup();
    live.begin('s1', eng);
    live.end();
    expect(reporter.flush).toHaveBeenCalledWith('s1');
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS * 2);
    expect(beat).not.toHaveBeenCalled();

    live.begin('s2', eng);
    live.end(true);
    expect(reporter.flushKeepalive).toHaveBeenCalledWith('s2');
  });

  it('reports an engine error immediately on the live session', () => {
    const { live, eng, reporter } = setup();
    live.begin('s1', eng);
    live.onError({ code: 3016, category: 'engine' });
    expect(reporter.record).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'error', code: 3016 }),
      true,
      expect.any(String),
    );
  });

  it('stops ticking and beating after a fatal error, without recording the overlay as a stall', async () => {
    const { live, beat, eng, reporter } = setup();
    live.begin('s1', eng);
    live.onState('playing');
    live.onError({ code: 3016, category: 'engine' });
    live.onState('error');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(beat).not.toHaveBeenCalled();
    expect(reporter.record).toHaveBeenCalledTimes(1);
    expect(reporter.record).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'error' }), true, expect.any(String));
  });

  it('does not read a frozen process as a frozen playhead', async () => {
    const { live, beat, eng, engine } = setup();
    live.begin('s1', eng);
    live.onState('playing');
    for (let i = 1; i <= 5; i++) {
      engine.currentTime = i;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    vi.setSystemTime(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 6; i <= 16; i++) {
      engine.currentTime = i;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(beat.mock.calls.at(-1)?.[1].stallCount).toBe(0);
  });

  it('tells the server when the player is paused', async () => {
    const { live, beat, eng } = setup();
    live.begin('s1', eng);
    live.onState('playing');
    live.onState('paused');
    await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS);
    expect(beat.mock.calls[0][2]).toBe('paused');
  });
});

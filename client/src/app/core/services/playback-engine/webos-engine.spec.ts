import { describe, expect, it, vi } from 'vitest';
import { WebOsEngine, WebOsLoadError, webOsSourceType } from './webos-engine';
import { classifyPlaybackError, isUndecodableError } from './playback-error';

function engineWith(video: Record<string, unknown>) {
  const engine = new WebOsEngine();
  (engine as unknown as { frameBaseline: unknown }).frameBaseline = { dropped: 0, decoded: 0 };
  (engine as unknown as { video: unknown }).video = {
    currentTime: 10,
    videoWidth: 1920,
    videoHeight: 1080,
    buffered: { length: 1, start: () => 0, end: () => 25 },
    ...video,
  };
  return engine;
}

describe('WebOsEngine.getQoeSample', () => {
  it('uses getVideoPlaybackQuality and the buffered range around the playhead', async () => {
    const engine = engineWith({
      getVideoPlaybackQuality: () => ({ droppedVideoFrames: 3, totalVideoFrames: 100 }),
    });
    expect(await engine.getQoeSample()).toMatchObject({
      engine: 'webos',
      cmcd: false,
      droppedFrames: 3,
      decodedFrames: 100,
      bufferAheadS: 15,
      width: 1920,
      height: 1080,
    });
  });

  it('falls back to the webkit counters', async () => {
    const engine = engineWith({ webkitDroppedFrameCount: 2, webkitDecodedFrameCount: 50 });
    expect(await engine.getQoeSample()).toMatchObject({ droppedFrames: 2, decodedFrames: 50 });
  });

  it('reports counters relative to the baseline taken at load', async () => {
    const engine = engineWith({
      getVideoPlaybackQuality: () => ({ droppedVideoFrames: 7, totalVideoFrames: 260 }),
    });
    (engine as unknown as { frameBaseline: unknown }).frameBaseline = { dropped: 5, decoded: 200 };
    expect(await engine.getQoeSample()).toMatchObject({ droppedFrames: 2, decodedFrames: 60 });
  });

  it('drops the baseline when the counters restarted below it', async () => {
    const engine = engineWith({
      getVideoPlaybackQuality: () => ({ droppedVideoFrames: 1, totalVideoFrames: 40 }),
    });
    (engine as unknown as { frameBaseline: unknown }).frameBaseline = { dropped: 5, decoded: 200 };
    expect(await engine.getQoeSample()).toMatchObject({ droppedFrames: 1, decodedFrames: 40 });
  });

  it('takes the baseline at the first sample after a load, not at load time', async () => {
    let counts = { droppedVideoFrames: 9, totalVideoFrames: 500 };
    const engine = engineWith({ getVideoPlaybackQuality: () => counts });
    (engine as unknown as { frameBaseline: unknown }).frameBaseline = null;
    expect(await engine.getQoeSample()).toMatchObject({ droppedFrames: 0, decodedFrames: 0 });
    counts = { droppedVideoFrames: 11, totalVideoFrames: 560 };
    expect(await engine.getQoeSample()).toMatchObject({ droppedFrames: 2, decodedFrames: 60 });
  });

  it('has no buffer figure when the playhead is outside every range', async () => {
    const engine = engineWith({ currentTime: 99 });
    expect((await engine.getQoeSample())?.bufferAheadS).toBeNull();
  });
});

describe('webOsSourceType', () => {
  const typeOf = (url: string, mime?: string) => decodeURIComponent(webOsSourceType(url, 0, mime)).split(';')[0];

  it('tells the native pipeline the container of a raw file', () => {
    expect(typeOf('/api/stream/1/file', 'video/x-matroska')).toBe('video/x-matroska');
    expect(typeOf('/api/stream/1/file')).toBe('video/mp4');
  });

  it('keeps the HLS type for a manifest whatever the file type', () => {
    expect(typeOf('/hls/master.m3u8', 'video/x-matroska')).toBe('application/vnd.apple.mpegurl');
  });
});

describe('WebOsEngine load failures', () => {
  function loading(fire?: (listeners: Record<string, () => void>) => void) {
    const listeners: Record<string, () => void> = {};
    return {
      error: { code: 4, message: '' },
      firstChild: null,
      appendChild: () => undefined,
      removeChild: () => undefined,
      removeAttribute: () => undefined,
      addEventListener: (e: string, fn: () => void) => (listeners[e] = fn),
      removeEventListener: () => undefined,
      load: vi.fn(() => queueMicrotask(() => fire?.(listeners))),
    };
  }

  it('rejects a native open failure as a media error the copy fallback treats as undecodable', async () => {
    const engine = new WebOsEngine();
    (engine as unknown as { video: unknown }).video = loading((l) => l['error']?.());
    const e = await engine.load('/api/stream/1/direct', 0).then(() => null, (err) => err);
    expect(e).toBeInstanceOf(WebOsLoadError);
    expect(classifyPlaybackError(e)).toEqual({ source: 'media', code: 4 });
    expect(isUndecodableError({ ...classifyPlaybackError(e), message: e.message })).toBe(true);
  });

  it('rejects a load timeout the same way, without a second attempt', async () => {
    vi.useFakeTimers();
    try {
      const engine = new WebOsEngine();
      const v = loading();
      (engine as unknown as { video: unknown }).video = v;
      const pending = engine.load('/api/stream/1/direct', 0).then(() => null, (err) => err);
      await vi.advanceTimersByTimeAsync(30_000);
      const e = await pending;
      expect(e).toMatchObject({ name: 'WebOsLoadTimeout', source: 'media', code: 4 });
      expect(v.load).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

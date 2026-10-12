import { describe, expect, it } from 'vitest';
import { WebOsEngine } from './webos-engine';

function engineWith(video: Record<string, unknown>) {
  const engine = new WebOsEngine();
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

  it('has no buffer figure when the playhead is outside every range', async () => {
    const engine = engineWith({ currentTime: 99 });
    expect((await engine.getQoeSample())?.bufferAheadS).toBeNull();
  });
});

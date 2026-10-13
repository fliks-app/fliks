import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TizenEngine, isTizenCropSupported } from './tizen-engine';

const rect = { x: 0, y: 138, width: 1920, height: 804 };

function stubAvplay(avplay: Record<string, unknown>) {
  (window as unknown as { webapis: unknown }).webapis = { avplay };
  (globalThis as unknown as { webapis: unknown }).webapis = { avplay };
}

describe('TizenEngine.setCrop', () => {
  const setVideoRoi = vi.fn();
  const setDisplayRect = vi.fn();
  const setDisplayMethod = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    stubAvplay({ setVideoRoi, setDisplayRect, setDisplayMethod });
  });
  afterEach(() => {
    delete (window as unknown as { webapis?: unknown }).webapis;
    delete (globalThis as unknown as { webapis?: unknown }).webapis;
  });

  function engineWithSurface() {
    const engine = new TizenEngine();
    (engine as unknown as { avObject: object }).avObject = {};
    return engine;
  }

  it('hands AVPlay the normalized region of interest', () => {
    expect(engineWithSurface().setCrop(rect, 1920, 1080)).toBe(true);
    expect(setVideoRoi).toHaveBeenLastCalledWith(0, 138 / 1080, 1, 804 / 1080);
  });

  it('resets the region when there is no rectangle', () => {
    const engine = engineWithSurface();
    engine.setCrop(rect, 1920, 1080);
    expect(engine.setCrop(null, 1920, 1080)).toBe(false);
    expect(setVideoRoi).toHaveBeenLastCalledWith(0, 0, 1, 1);
  });

  it('re-applies the crop with the display settings', () => {
    const engine = engineWithSurface();
    engine.setCrop(rect, 1920, 1080);
    setVideoRoi.mockClear();
    engine.setFillScreen(false);
    expect(setVideoRoi).toHaveBeenCalledWith(0, 138 / 1080, 1, 804 / 1080);
  });

  it('still reports the crop when AVPlay throws before prepare', () => {
    setVideoRoi.mockImplementation(() => {
      throw new Error('InvalidStateError');
    });
    expect(engineWithSurface().setCrop(rect, 1920, 1080)).toBe(true);
  });

  it('reports no crop and detects no support when setVideoRoi is missing', () => {
    stubAvplay({ setDisplayRect, setDisplayMethod });
    expect(isTizenCropSupported()).toBe(false);
    expect(engineWithSurface().setCrop(rect, 1920, 1080)).toBe(false);
  });
});

describe('TizenEngine seek and audio state', () => {
  afterEach(() => {
    delete (window as unknown as { webapis?: unknown }).webapis;
    delete (globalThis as unknown as { webapis?: unknown }).webapis;
  });

  function populate(engine: TizenEngine) {
    const handler = vi.fn();
    engine.on('audioTracksChanged', handler);
    (engine as unknown as { populateAudioTracks(): void }).populateAudioTracks();
    return handler.mock.calls[0][0].tracks as { id: string; selected: boolean }[];
  }

  it('refreshes the subtitle overlay after a seek completes', async () => {
    stubAvplay({ seekTo: (_ms: number, ok: () => void) => ok(), getState: () => 'PAUSED' });
    const engine = new TizenEngine();
    const overlay = (engine as unknown as { subtitles: { updateAt(t: number): void } }).subtitles;
    const updateAt = vi.spyOn(overlay, 'updateAt');
    await engine.seek(42);
    expect(updateAt).toHaveBeenCalledWith(42);
  });

  it('marks the stream AVPlay plays as selected, not the first audio entry', () => {
    const tracks = [
      { type: 'AUDIO', index: 1, extra_info: '{"language":"eng"}' },
      { type: 'AUDIO', index: 2, extra_info: '{"language":"fra"}' },
    ];
    stubAvplay({
      getTotalTrackInfo: () => tracks,
      getCurrentStreamInfo: () => [{ type: 'VIDEO', index: 0, extra_info: '' }, tracks[1]],
    });
    expect(populate(new TizenEngine()).map((t) => [t.id, t.selected])).toEqual([
      ['avplay-audio-1', false],
      ['avplay-audio-2', true],
    ]);
  });

  it('reports the requested track as selected right after a switch', async () => {
    const tracks = [
      { type: 'AUDIO', index: 1, extra_info: '{}' },
      { type: 'AUDIO', index: 2, extra_info: '{}' },
    ];
    stubAvplay({
      getTotalTrackInfo: () => tracks,
      getCurrentStreamInfo: () => [tracks[0]],
      getState: () => 'PLAYING',
      setSelectTrack: () => undefined,
    });
    const engine = new TizenEngine();
    populate(engine);
    const handler = vi.fn();
    engine.on('audioTracksChanged', handler);
    await engine.selectAudioTrack('avplay-audio-2');
    const emitted = handler.mock.calls[0][0].tracks as { id: string; selected: boolean }[];
    expect(emitted.find((t) => t.selected)?.id).toBe('avplay-audio-2');
  });

  it('falls back to the first audio entry when stream info is unavailable', () => {
    stubAvplay({ getTotalTrackInfo: () => [{ type: 'AUDIO', index: 3, extra_info: '{}' }] });
    expect(populate(new TizenEngine())[0].selected).toBe(true);
  });
});

describe('TizenEngine.getQoeSample', () => {
  afterEach(() => {
    delete (window as unknown as { webapis?: unknown }).webapis;
    delete (globalThis as unknown as { webapis?: unknown }).webapis;
  });

  it('reads the video stream info and leaves bandwidth and the decoder unmeasured', async () => {
    stubAvplay({
      getStreamingProperty: () => '8000000',
      getCurrentStreamInfo: () => [
        { type: 'AUDIO', index: 1, extra_info: '{}' },
        { type: 'VIDEO', index: 0, extra_info: '{"fourCC":"hvc1","Width":"3840","Height":"2160","Bit_rate":"15000000"}' },
      ],
    });
    expect(await new TizenEngine().getQoeSample()).toMatchObject({
      engine: 'avplay',
      cmcd: false,
      droppedFrames: null,
      bandwidthBps: null,
      variantBitrate: 15000000,
      width: 3840,
      height: 2160,
      videoCodec: 'hvc1',
      hwDecoder: null,
      bufferAheadS: null,
    });
  });

  it('does not claim a read-ahead', () => {
    expect(new TizenEngine().measuresBuffer).toBe(false);
  });

  it('nulls what AVPlay refuses or garbles', async () => {
    stubAvplay({
      getStreamingProperty: () => {
        throw new Error('InvalidStateError');
      },
      getCurrentStreamInfo: () => [{ type: 'VIDEO', index: 0, extra_info: 'not json' }],
    });
    expect(await new TizenEngine().getQoeSample()).toMatchObject({
      bandwidthBps: null,
      variantBitrate: null,
      width: null,
      videoCodec: null,
    });
  });
});

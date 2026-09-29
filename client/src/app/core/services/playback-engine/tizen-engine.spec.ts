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

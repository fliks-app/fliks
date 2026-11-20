import { describe, expect, it, vi } from 'vitest';
import { KeyframeGrid } from './keyframe-grid';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';

const engine = (seeksToKeyframe: boolean) => ({ seeksToKeyframe }) as unknown as PlaybackEngine;
const flush = () => new Promise((r) => setTimeout(r));

describe('KeyframeGrid', () => {
  it('loads a direct-played file once its engine lands seeks on keyframes', async () => {
    const fetch = vi.fn().mockResolvedValue([0, 4]);
    const grid = new KeyframeGrid(fetch);
    grid.use(7);
    expect(fetch).not.toHaveBeenCalled();
    grid.attach(engine(true));
    grid.use(7);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(grid.keyframes()).toEqual([0, 4]);
  });

  it('stays empty for exact engines and for a remux or transcode', async () => {
    const fetch = vi.fn().mockResolvedValue([0, 4]);
    const exact = new KeyframeGrid(fetch);
    exact.attach(engine(false));
    exact.use(7);
    const tv = new KeyframeGrid(fetch);
    tv.attach(engine(true));
    tv.use(null);
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(tv.keyframes()).toEqual([]);
  });

  it('drops the grid when the stream stops being the file itself', async () => {
    const grid = new KeyframeGrid(vi.fn().mockResolvedValue([0, 4]));
    grid.attach(engine(true));
    grid.use(7);
    await flush();
    grid.use(null);
    expect(grid.keyframes()).toEqual([]);
  });
});

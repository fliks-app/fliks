import { HostHardwareService } from './host-hardware.service';
import {
  setSelectedRenderNode,
  vaapiRenderNode,
} from '../media-tools/hw-device';

const ss = (gpuRenderNode = 'auto') =>
  ({ gpuRenderNode, ffmpegSlots: null, segmentDuration: 3 }) as never;
const caps = {
  hwAccel: 'vaapi',
  gpus: [{ renderNode: '/dev/dri/renderD129', name: 'Arc' }],
  tonemapAlgos: ['auto', 'opencl'],
  pauseCapability: 'signal',
  hostCaps: { libfdkAac: true },
};

function setup(enabled = true) {
  const engine = {
    enabled,
    pushStreaming: jest.fn().mockResolvedValue(undefined),
    capabilitiesFor: jest.fn().mockResolvedValue(caps),
  };
  return { engine, hw: new HostHardwareService({} as never, engine as never) };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('HostHardwareService', () => {
  afterEach(() => setSelectedRenderNode(null));

  it('is a CPU host with no engine, and still applies the GPU pin', async () => {
    const { hw, engine } = setup(false);
    await hw.apply(ss('/dev/dri/renderD129'), true);
    expect(engine.pushStreaming).not.toHaveBeenCalled();
    expect(vaapiRenderNode()).toBe('/dev/dri/renderD129');
    expect(hw.hwAccel).toBe('none');
    expect(hw.tonemapAlgos).toEqual(['auto']);
    expect(hw.gpus()).toEqual({ gpus: [], defaultNode: '/dev/dri/renderD129' });
  });

  it("serves the engine's detection once loaded", async () => {
    const { hw } = setup();
    await hw.apply(ss(), true);
    await flush();
    expect(hw.hwAccel).toBe('vaapi');
    expect(hw.libfdkAac).toBe(true);
    expect(hw.pauseCapability).toBe('signal');
    expect(hw.gpus().gpus).toEqual([
      { renderNode: '/dev/dri/renderD129', label: 'Arc', kind: 'unknown' },
    ]);
  });

  it('re-detects on a GPU re-pin only', async () => {
    const { hw, engine } = setup();
    await hw.apply(ss(), true);
    await hw.apply(ss());
    expect(engine.capabilitiesFor).toHaveBeenCalledTimes(1);
    await hw.apply(ss('/dev/dri/renderD129'));
    expect(engine.capabilitiesFor).toHaveBeenLastCalledWith(
      '/dev/dri/renderD129',
    );
    expect(engine.pushStreaming).toHaveBeenCalledTimes(3);
  });

  it('never throws when the push fails', async () => {
    const { hw, engine } = setup();
    engine.pushStreaming.mockRejectedValue(new Error('409'));
    await expect(hw.apply(ss())).resolves.toBeUndefined();
  });
});

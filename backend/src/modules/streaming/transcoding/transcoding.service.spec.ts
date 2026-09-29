jest.mock('./codec/decoder-probe', () => ({ runDecoderProbes: jest.fn() }));
jest.mock('./codec/encoder-probe', () => ({ runEncoderProbes: jest.fn() }));
jest.mock('./codec/vpp-qsv-probe', () => ({
  runVppQsvTonemapProbe: jest.fn(),
  isVppQsvTonemapEnabled: jest.fn(),
}));
jest.mock('./codec/tonemap-opencl-probe', () => ({
  runTonemapOpenclProbe: jest.fn(),
  isTonemapOpenclEnabled: jest.fn(),
}));
jest.mock('./codec/opencl-tonemap-probe', () => ({ runOpenclTonemapProbe: jest.fn() }));
jest.mock('./codec/cuda-tonemap-probe', () => ({ runCudaTonemapProbe: jest.fn() }));
jest.mock('./codec/qsv-opencl-probe', () => ({ runQsvOpenclTonemapProbe: jest.fn() }));
jest.mock('./codec/vulkan-tonemap-probe', () => ({ runVulkanTonemapProbe: jest.fn() }));
jest.mock('./codec/amf-opencl-probe', () => ({ runAmfOpenclProbe: jest.fn() }));
jest.mock('./audio-encoder-probe', () => ({ runAudioEncoderProbe: jest.fn() }));
jest.mock('./hw-detect', () => ({ detectHwAccel: jest.fn().mockResolvedValue('none') }));

import { TranscodingService } from './transcoding.service';
import { runDecoderProbes } from './codec/decoder-probe';
import { runEncoderProbes } from './codec/encoder-probe';
import { runCudaTonemapProbe } from './codec/cuda-tonemap-probe';
import type { StreamingSettings } from '../streaming-settings-cache.service';

function makeService(): any {
  const cacheService = { setLimits: jest.fn(), registerLiveDirProvider: jest.fn() };
  const liveSessions = {};
  const streamingSettings = { get: jest.fn() };
  const sourceScans = {};
  return new (TranscodingService as any)(
    cacheService,
    liveSessions,
    streamingSettings,
    sourceScans,
  );
}

const baseSettings = {
  ffmpegSlots: null,
  cacheTtlMs: 1,
  cacheMaxBytes: 1,
} as Partial<StreamingSettings>;

describe('TranscodingService.runBootProbeChain', () => {
  let order: string[];

  beforeEach(() => {
    order = [];
    jest.clearAllMocks();
    (runDecoderProbes as jest.Mock).mockImplementation(async () => {
      order.push('decoder');
    });
    (runEncoderProbes as jest.Mock).mockImplementation(async () => {
      order.push('encoder');
    });
    (runCudaTonemapProbe as jest.Mock).mockImplementation(async () => {
      order.push('tonemap');
    });
  });

  it('runs decoder probes, then encoder probes, then tone-map probes, strictly in order', async () => {
    const service = makeService();
    service.detectedHwAccel = 'nvenc'; // only the cuda tonemap probe fires for nvenc
    await service.runBootProbeChain();
    expect(order).toEqual(['decoder', 'encoder', 'tonemap']);
  });

  it('a decoder-probe failure never stops the encoder or tone-map stage', async () => {
    (runDecoderProbes as jest.Mock).mockImplementation(async () => {
      throw new Error('decoder boom');
    });
    const service = makeService();
    service.detectedHwAccel = 'nvenc';
    await expect(service.runBootProbeChain()).resolves.toBeUndefined();
    expect(runEncoderProbes).toHaveBeenCalled();
    expect(order).toEqual(['encoder', 'tonemap']);
  });

  it('an encoder-probe failure never stops the tone-map stage', async () => {
    (runEncoderProbes as jest.Mock).mockImplementation(async () => {
      order.push('encoder');
      throw new Error('encoder boom');
    });
    const service = makeService();
    service.detectedHwAccel = 'nvenc';
    await expect(service.runBootProbeChain()).resolves.toBeUndefined();
    expect(order).toEqual(['decoder', 'encoder', 'tonemap']);
  });

  it('probes nothing tone-map-related on a CPU-only host', async () => {
    const service = makeService();
    service.detectedHwAccel = 'none';
    await service.runBootProbeChain();
    expect(order).toEqual(['decoder', 'encoder']);
  });
});

describe('TranscodingService.applyStreamingSettings GPU re-pin', () => {
  // The re-probe is a fire-and-forget async IIFE (re-detect, then run the
  // chain); flushing microtasks lets both steps land before assertions.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('does not re-run the boot probe chain on the first call (the boot pin)', async () => {
    const service = makeService();
    const spy = jest.spyOn(service, 'runBootProbeChain').mockResolvedValue(undefined);
    service.applyStreamingSettings({ ...baseSettings, gpuRenderNode: '/dev/dri/renderD128' });
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-runs the boot probe chain when the render node actually changes', async () => {
    const service = makeService();
    const spy = jest.spyOn(service, 'runBootProbeChain').mockResolvedValue(undefined);
    service.applyStreamingSettings({ ...baseSettings, gpuRenderNode: '/dev/dri/renderD128' });
    service.applyStreamingSettings({ ...baseSettings, gpuRenderNode: '/dev/dri/renderD129' });
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never overlaps chains: re-pins during a run coalesce into one follow-up run', async () => {
    const service = makeService();
    let running = 0;
    let maxRunning = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = jest.spyOn(service, 'runBootProbeChain').mockImplementation(async () => {
      maxRunning = Math.max(maxRunning, ++running);
      if (spy.mock.calls.length === 1) await gate;
      running--;
    });
    const boot = service.scheduleProbeChain(false);
    service.applyStreamingSettings({ ...baseSettings, gpuRenderNode: '/dev/dri/renderD128' });
    service.applyStreamingSettings({ ...baseSettings, gpuRenderNode: '/dev/dri/renderD129' });
    service.applyStreamingSettings({ ...baseSettings, gpuRenderNode: '/dev/dri/renderD130' });
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    release();
    await boot;
    expect(spy).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
  });

  it('does not re-run when the same setting is re-applied (e.g. every playback-info)', async () => {
    const service = makeService();
    const spy = jest.spyOn(service, 'runBootProbeChain').mockResolvedValue(undefined);
    const ss = { ...baseSettings, gpuRenderNode: '/dev/dri/renderD128' };
    service.applyStreamingSettings(ss);
    service.applyStreamingSettings(ss);
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });
});

jest.mock('./hw-detect', () => ({ detectHwAccel: jest.fn() }));
jest.mock('./audio-encoder-probe', () => ({
  ...jest.requireActual('./audio-encoder-probe'),
  runAudioEncoderProbe: jest.fn(),
}));
jest.mock('./codec/decoder-probe', () => ({
  ...jest.requireActual('./codec/decoder-probe'),
  runDecoderProbes: jest.fn(),
}));
jest.mock('./codec/encoder-probe', () => ({
  ...jest.requireActual('./codec/encoder-probe'),
  runEncoderProbes: jest.fn(),
}));
jest.mock('./codec/vpp-qsv-probe', () => ({
  ...jest.requireActual('./codec/vpp-qsv-probe'),
  runVppQsvTonemapProbe: jest.fn(),
}));
jest.mock('./codec/tonemap-opencl-probe', () => ({
  ...jest.requireActual('./codec/tonemap-opencl-probe'),
  runTonemapOpenclProbe: jest.fn(),
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { TranscodingService } from './transcoding.service';
import { detectHwAccel } from './hw-detect';
import { runAudioEncoderProbe } from './audio-encoder-probe';
import { runDecoderProbes } from './codec/decoder-probe';
import { runEncoderProbes } from './codec/encoder-probe';
import { runVppQsvTonemapProbe } from './codec/vpp-qsv-probe';
import { getPauseCapability } from './ffmpeg-pause';
import { toEngineStreaming } from '../../engine/engine.service';
import type { StreamingSettings } from '../streaming-settings-cache.service';

const [qsv, nvenc] = JSON.parse(
  readFileSync(join(__dirname, 'engine-capabilities.fixtures.json'), 'utf8'),
)
  .filter((s: { name: string }) =>
    ['linux-qsv-intel-ihd', 'linux-nvenc'].includes(s.name),
  )
  .sort((a: { name: string }, b: { name: string }) =>
    b.name.localeCompare(a.name),
  );

const settings = (node: string) =>
  ({
    ffmpegSlots: null,
    cacheTtlMs: 1,
    cacheMaxBytes: 1,
    gpuRenderNode: node,
  }) as StreamingSettings;

function make(engine: object, ss: StreamingSettings = settings('auto')) {
  const cache = { setLimits: jest.fn(), registerLiveDirProvider: jest.fn() };
  const svc = new (TranscodingService as any)(
    cache,
    {},
    { get: jest.fn(async () => ss) },
    {},
    engine,
  );
  return svc as any;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('TranscodingService boot with the engine', () => {
  afterEach(() => jest.clearAllMocks());

  it('loads the engine detection and runs no local probe', async () => {
    const engine = {
      whenReady: jest.fn(async () => undefined),
      enabled: true,
      pushStreaming: jest.fn(async () => undefined),
      capabilitiesFor: jest.fn(async () => qsv.capabilities),
    };
    const svc = make(engine);
    await svc.onModuleInit();
    await flush();
    await svc.onModuleDestroy();

    expect(engine.pushStreaming).toHaveBeenCalledWith(
      toEngineStreaming(settings('auto')),
    );
    expect(engine.capabilitiesFor).toHaveBeenCalledWith('auto');
    expect(svc.getDetectedHwAccel()).toBe('qsv');
    expect(svc.getGpus().gpus).toEqual([
      expect.objectContaining({
        renderNode: '/dev/dri/renderD128',
        kind: 'unknown',
      }),
    ]);
    expect(svc.getAvailableTonemapAlgos()).toEqual(
      qsv.capabilities.tonemapAlgos,
    );
    expect(getPauseCapability()).toBe('stdin');
    for (const probe of [
      detectHwAccel,
      runAudioEncoderProbe,
      runDecoderProbes,
      runEncoderProbes,
      runVppQsvTonemapProbe,
    ]) {
      expect(probe).not.toHaveBeenCalled();
    }
  });

  it('runs the local detection when the engine is disabled', async () => {
    (detectHwAccel as jest.Mock).mockResolvedValue('none');
    const svc = make({
      whenReady: jest.fn(async () => undefined),
      enabled: false,
    });
    await svc.onModuleInit();
    await flush();
    await svc.onModuleDestroy();
    expect(detectHwAccel).toHaveBeenCalled();
    expect(runDecoderProbes).toHaveBeenCalled();
  });

  it('re-pinning pushes the config then reloads the capabilities', async () => {
    const engine = {
      whenReady: jest.fn(async () => undefined),
      enabled: true,
      pushStreaming: jest.fn(async () => undefined),
      capabilitiesFor: jest.fn(async (node: string) =>
        node === 'auto' ? qsv.capabilities : nvenc.capabilities,
      ),
    };
    const svc = make(engine);
    await svc.onModuleInit();
    await flush();
    expect(svc.getDetectedHwAccel()).toBe('qsv');

    svc.applyStreamingSettings(settings('/dev/dri/renderD129'));
    await flush();

    expect(engine.pushStreaming).toHaveBeenLastCalledWith(
      toEngineStreaming(settings('/dev/dri/renderD129')),
    );
    expect(engine.capabilitiesFor).toHaveBeenLastCalledWith(
      '/dev/dri/renderD129',
    );
    expect(svc.getDetectedHwAccel()).toBe('nvenc');
    expect(detectHwAccel).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });
});

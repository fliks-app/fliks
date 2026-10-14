/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return -- jest.mock factories need require() */
// Host capabilities are process-global boot probes: route every probe through host-caps.ts.
function mockProbes(path: string, map: Record<string, string>) {
  const hc = require('./host-caps') as typeof import('./host-caps');
  const actual = jest.requireActual<object>(path);
  return {
    ...actual,
    ...Object.fromEntries(
      Object.entries(map).map(([fn, name]) => [
        fn,
        () => hc.probeOn(name as never),
      ]),
    ),
  };
}
jest.mock(
  '../../src/modules/streaming/transcoding/codec/tonemap-opencl-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/tonemap-opencl-probe',
      {
        isTonemapOpenclEnabled: 'tonemapOpencl',
        isTonemapOpenclEnabledWithCrop: 'tonemapOpenclCrop',
        isTonemapOpenclHdr10Enabled: 'tonemapOpenclHdr10',
      },
    ),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/qsv-opencl-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/qsv-opencl-probe',
      {
        isQsvOpenclTonemapEnabled: 'qsvOpencl',
        isQsvOpenclTonemapHdr10Enabled: 'qsvOpenclHdr10',
      },
    ),
);
jest.mock('../../src/modules/streaming/transcoding/codec/vpp-qsv-probe', () =>
  mockProbes('../../src/modules/streaming/transcoding/codec/vpp-qsv-probe', {
    isVppQsvTonemapEnabled: 'vppQsv',
  }),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/vulkan-tonemap-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/vulkan-tonemap-probe',
      { isVulkanTonemapEnabled: 'vulkan' },
    ),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/cuda-tonemap-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/cuda-tonemap-probe',
      {
        isCudaTonemapEnabled: 'cuda',
        isCudaTonemapHdr10Enabled: 'cudaHdr10',
      },
    ),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/opencl-tonemap-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/opencl-tonemap-probe',
      {
        isOpenclTonemapEnabled: 'opencl',
        isOpenclTonemapHdr10Enabled: 'openclHdr10',
      },
    ),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/amf-opencl-probe',
  () =>
    mockProbes(
      '../../src/modules/streaming/transcoding/codec/amf-opencl-probe',
      { isAmfOpenclEnabled: 'amfOpencl' },
    ),
);
jest.mock(
  '../../src/modules/streaming/transcoding/audio-encoder-probe',
  () => ({
    ...jest.requireActual(
      '../../src/modules/streaming/transcoding/audio-encoder-probe',
    ),
    isLibfdkAacEnabled: () =>
      (require('./host-caps') as typeof import('./host-caps')).currentCaps()
        .libfdkAac,
  }),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/encoder-probe',
  () => ({
    ...jest.requireActual(
      '../../src/modules/streaming/transcoding/codec/encoder-probe',
    ),
    isEncoderEnabled: (id: string) =>
      !(require('./host-caps') as typeof import('./host-caps'))
        .currentCaps()
        .disabledEncoders.includes(id),
    vaapiWritesHdrMetadata: () =>
      (require('./host-caps') as typeof import('./host-caps')).currentCaps()
        .vaapiWritesHdrMetadata,
  }),
);
jest.mock(
  '../../src/modules/streaming/transcoding/codec/decoder-probe',
  () => ({
    ...jest.requireActual(
      '../../src/modules/streaming/transcoding/codec/decoder-probe',
    ),
    isDecoderEnabled: (id: string) =>
      !(require('./host-caps') as typeof import('./host-caps'))
        .currentCaps()
        .disabledDecoders.includes(id),
  }),
);

import type { HwAccelType } from '../../src/modules/streaming/transcoding/types';

/** Boot-probe results the decision reads, by short name. */
export type ProbeName =
  | 'tonemapOpencl'
  | 'tonemapOpenclCrop'
  | 'tonemapOpenclHdr10'
  | 'qsvOpencl'
  | 'qsvOpenclHdr10'
  | 'vppQsv'
  | 'vulkan'
  | 'cuda'
  | 'cudaHdr10'
  | 'opencl'
  | 'openclHdr10'
  | 'amfOpencl';

/** The host capabilities injected into evaluate(): what the engine's `HostCaps` serialises. */
export interface HostCaps {
  hwAccel: HwAccelType;
  platform: 'linux' | 'darwin' | 'win32';
  libfdkAac: boolean;
  vaapiWritesHdrMetadata: boolean;
  /** Probes that passed; every other probe reads false (fail-closed, as at boot). */
  probes: ProbeName[];
  /** Encoder / decoder descriptor ids the boot probe blacklisted. */
  disabledEncoders: string[];
  disabledDecoders: string[];
}

export const HOST_CAPS: Record<string, HostCaps> = {
  cpu: {
    hwAccel: 'none',
    platform: 'linux',
    libfdkAac: false,
    vaapiWritesHdrMetadata: false,
    probes: [],
    disabledEncoders: [],
    disabledDecoders: [],
  },
  vaapi: {
    hwAccel: 'vaapi',
    platform: 'linux',
    libfdkAac: false,
    vaapiWritesHdrMetadata: true,
    probes: [
      'tonemapOpencl',
      'tonemapOpenclCrop',
      'tonemapOpenclHdr10',
      'vulkan',
    ],
    disabledEncoders: [],
    disabledDecoders: [],
  },
  'vaapi-no-opencl': {
    hwAccel: 'vaapi',
    platform: 'linux',
    libfdkAac: true,
    vaapiWritesHdrMetadata: false,
    probes: [],
    disabledEncoders: [],
    disabledDecoders: [],
  },
  nvenc: {
    hwAccel: 'nvenc',
    platform: 'linux',
    libfdkAac: false,
    vaapiWritesHdrMetadata: false,
    probes: ['cuda', 'cudaHdr10'],
    disabledEncoders: [],
    disabledDecoders: [],
  },
  qsv: {
    hwAccel: 'qsv',
    platform: 'linux',
    libfdkAac: false,
    vaapiWritesHdrMetadata: false,
    probes: ['tonemapOpencl', 'tonemapOpenclHdr10'],
    disabledEncoders: [],
    disabledDecoders: [],
  },
  videotoolbox: {
    hwAccel: 'videotoolbox',
    platform: 'darwin',
    libfdkAac: false,
    vaapiWritesHdrMetadata: false,
    probes: [],
    disabledEncoders: [],
    disabledDecoders: [],
  },
};

type G = { __engineHostCaps?: HostCaps };
const g = globalThis as unknown as G;

/** Current injected caps (cpu-only until a run sets others). */
export function currentCaps(): HostCaps {
  return g.__engineHostCaps ?? HOST_CAPS.cpu;
}

export function probeOn(name: ProbeName): boolean {
  return currentCaps().probes.includes(name);
}

/** Runs `fn` with `caps` injected into the mocked probe modules and `process.platform`. */
export function withHostCaps<T>(caps: HostCaps, fn: () => T): T {
  const prev = g.__engineHostCaps;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  g.__engineHostCaps = caps;
  Object.defineProperty(process, 'platform', {
    ...platform,
    value: caps.platform,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    g.__engineHostCaps = prev;
  }
}

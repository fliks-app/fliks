jest.mock('./codec/tonemap-opencl-probe', () => ({
  isTonemapOpenclEnabled: jest.fn(() => false),
  isTonemapOpenclEnabledWithCrop: jest.fn(() => false),
  isTonemapOpenclHdr10Enabled: jest.fn(() => false),
}));
jest.mock('./codec/vpp-qsv-probe', () => ({
  isVppQsvTonemapEnabled: jest.fn(() => false),
}));
jest.mock('./codec/qsv-opencl-probe', () => ({
  isQsvOpenclTonemapEnabled: jest.fn(() => false),
  isQsvOpenclTonemapHdr10Enabled: jest.fn(() => false),
}));
jest.mock('./codec/vulkan-tonemap-probe', () => ({
  isVulkanTonemapEnabled: jest.fn(() => false),
}));
jest.mock('./codec/cuda-tonemap-probe', () => ({
  isCudaTonemapEnabled: jest.fn(() => false),
  isCudaTonemapHdr10Enabled: jest.fn(() => false),
}));
jest.mock('./codec/opencl-tonemap-probe', () => ({
  isOpenclTonemapEnabled: jest.fn(() => false),
  isOpenclTonemapHdr10Enabled: jest.fn(() => false),
}));

import { dvNoBaseHdr10PathSupported, resolveTonemapPath } from './tonemap-path';
import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
  isTonemapOpenclHdr10Enabled,
} from './codec/tonemap-opencl-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import {
  isQsvOpenclTonemapEnabled,
  isQsvOpenclTonemapHdr10Enabled,
} from './codec/qsv-opencl-probe';
import { isVulkanTonemapEnabled } from './codec/vulkan-tonemap-probe';
import { isCudaTonemapEnabled, isCudaTonemapHdr10Enabled } from './codec/cuda-tonemap-probe';
import {
  isOpenclTonemapEnabled,
  isOpenclTonemapHdr10Enabled,
} from './codec/opencl-tonemap-probe';

const openclNoCrop = isTonemapOpenclEnabled as jest.Mock;
const openclCrop = isTonemapOpenclEnabledWithCrop as jest.Mock;
const openclHdr10 = isTonemapOpenclHdr10Enabled as jest.Mock;
const vppQsv = isVppQsvTonemapEnabled as jest.Mock;
const qsvOpencl = isQsvOpenclTonemapEnabled as jest.Mock;
const qsvOpenclHdr10 = isQsvOpenclTonemapHdr10Enabled as jest.Mock;
const vulkanTonemap = isVulkanTonemapEnabled as jest.Mock;
const cudaTonemap = isCudaTonemapEnabled as jest.Mock;
const cudaTonemapHdr10 = isCudaTonemapHdr10Enabled as jest.Mock;
const standaloneOpencl = isOpenclTonemapEnabled as jest.Mock;
const standaloneOpenclHdr10 = isOpenclTonemapHdr10Enabled as jest.Mock;

beforeEach(() => {
  openclNoCrop.mockReturnValue(false);
  openclCrop.mockReturnValue(false);
  openclHdr10.mockReturnValue(false);
  vppQsv.mockReturnValue(false);
  qsvOpencl.mockReturnValue(false);
  qsvOpenclHdr10.mockReturnValue(false);
  vulkanTonemap.mockReturnValue(false);
  cudaTonemap.mockReturnValue(false);
  cudaTonemapHdr10.mockReturnValue(false);
  standaloneOpencl.mockReturnValue(false);
  standaloneOpenclHdr10.mockReturnValue(false);
});

describe('resolveTonemapPath', () => {
  it('passes explicit picks through unchanged, on any platform', () => {
    expect(resolveTonemapPath('qsv', { hasCrop: false }, 'win32')).toBe('qsv');
    expect(resolveTonemapPath('vaapi', { hasCrop: false }, 'linux')).toBe(
      'vaapi',
    );
    expect(resolveTonemapPath('opencl', { hasCrop: false }, 'win32')).toBe(
      'opencl',
    );
  });

  it('auto → opencl on Linux when the opencl probe passed', () => {
    openclNoCrop.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'linux')).toBe(
      'opencl',
    );
  });

  it('auto consults the crop-variant opencl probe when cropping (Linux)', () => {
    openclCrop.mockReturnValue(true);
    openclNoCrop.mockReturnValue(false);
    expect(resolveTonemapPath('auto', { hasCrop: true }, 'linux')).toBe(
      'opencl',
    );
    openclCrop.mockReturnValue(false);
    openclNoCrop.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: true }, 'linux')).toBe('vaapi');
  });

  it('auto → vaapi on Linux when opencl is unavailable', () => {
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'linux')).toBe(
      'vaapi',
    );
  });

  it('auto → opencl on Windows when the QSV OpenCL probe passed', () => {
    qsvOpencl.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'win32')).toBe(
      'opencl',
    );
  });

  it('auto → qsv (LUT) on Windows when OpenCL is unavailable but the vpp_qsv probe passed', () => {
    vppQsv.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'win32')).toBe('qsv');
  });

  it('prefers OpenCL over the qsv LUT on Windows when both probes passed', () => {
    qsvOpencl.mockReturnValue(true);
    vppQsv.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'win32')).toBe(
      'opencl',
    );
  });

  it('ignores the Linux VAAPI opencl probe on Windows (uses the QSV OpenCL one)', () => {
    openclNoCrop.mockReturnValue(true); // VAAPI probe — irrelevant on win32
    vppQsv.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'win32')).toBe('qsv');
  });

  it('dvNoBase overrides an explicit vaapi/qsv pick with opencl when the bridge passed', () => {
    openclNoCrop.mockReturnValue(true);
    expect(
      resolveTonemapPath('vaapi', { hasCrop: false, dvNoBase: true }, 'linux'),
    ).toBe('opencl');
    expect(
      resolveTonemapPath('qsv', { hasCrop: false, dvNoBase: true }, 'linux'),
    ).toBe('opencl');
  });

  it('dvNoBase falls through to the normal (RPU-blind) resolution when the bridge is down', () => {
    // resolveEncodePipeline compensates: it forces the whole pipeline off HW
    // whenever dvNoBase's tonemapPath isn't 'opencl'/'vulkan', see its own spec.
    expect(
      resolveTonemapPath('vaapi', { hasCrop: false, dvNoBase: true }, 'linux'),
    ).toBe('vaapi');
  });

  it('dvApplyRpu overrides an explicit vaapi pick with opencl when the bridge passed', () => {
    openclNoCrop.mockReturnValue(true);
    expect(
      resolveTonemapPath('vaapi', { hasCrop: false, dvApplyRpu: true }, 'linux'),
    ).toBe('opencl');
  });

  it('dvApplyRpu never forces vulkan: keeps the admin pick when the bridge is down', () => {
    vulkanTonemap.mockReturnValue(true);
    expect(
      resolveTonemapPath('vaapi', { hasCrop: false, dvApplyRpu: true }, 'linux'),
    ).toBe('vaapi');
  });

  it('dvNoBase prefers opencl over vulkan when both probes passed', () => {
    openclNoCrop.mockReturnValue(true);
    vulkanTonemap.mockReturnValue(true);
    expect(
      resolveTonemapPath('vaapi', { hasCrop: false, dvNoBase: true }, 'linux'),
    ).toBe('opencl');
  });
});

describe('dvNoBaseHdr10PathSupported', () => {
  const opts = { hasCrop: false, hasBurnIn: false };

  it('is never supported on VideoToolbox', () => {
    expect(dvNoBaseHdr10PathSupported('videotoolbox', 'auto', opts)).toBe(false);
  });

  it('NVENC: false until the cuda HDR10 recipe is probed, even though the SDR one passed', () => {
    cudaTonemap.mockReturnValue(true);
    expect(dvNoBaseHdr10PathSupported('nvenc', 'auto', opts, 'linux')).toBe(false);
    cudaTonemapHdr10.mockReturnValue(true);
    expect(dvNoBaseHdr10PathSupported('nvenc', 'auto', opts, 'linux')).toBe(true);
  });

  it('NVENC: falls back to the standalone opencl HDR10 flag when cuda tonemap is unavailable', () => {
    standaloneOpencl.mockReturnValue(true);
    expect(dvNoBaseHdr10PathSupported('nvenc', 'auto', opts, 'linux')).toBe(false);
    standaloneOpenclHdr10.mockReturnValue(true);
    expect(dvNoBaseHdr10PathSupported('nvenc', 'auto', opts, 'linux')).toBe(true);
  });

  it('NVENC: no GPU tonemap probed at all falls back to the always-verified CPU chain', () => {
    expect(dvNoBaseHdr10PathSupported('nvenc', 'auto', opts, 'linux')).toBe(true);
  });

  it('AMF: gated on the standalone opencl HDR10 flag, true when opencl tonemap is unavailable', () => {
    expect(dvNoBaseHdr10PathSupported('amf', 'auto', opts, 'win32')).toBe(true);
    standaloneOpencl.mockReturnValue(true);
    expect(dvNoBaseHdr10PathSupported('amf', 'auto', opts, 'win32')).toBe(false);
    standaloneOpenclHdr10.mockReturnValue(true);
    expect(dvNoBaseHdr10PathSupported('amf', 'auto', opts, 'win32')).toBe(true);
  });

  it('VAAPI/QSV opencl bridge (Linux): gated on the bridge-specific HDR10 flag', () => {
    openclNoCrop.mockReturnValue(true);
    expect(dvNoBaseHdr10PathSupported('vaapi', 'auto', opts, 'linux')).toBe(false);
    openclHdr10.mockReturnValue(true);
    expect(dvNoBaseHdr10PathSupported('vaapi', 'auto', opts, 'linux')).toBe(true);
  });

  it('Windows QSV opencl bridge: gated on its own HDR10 flag, independent of the Linux one', () => {
    qsvOpencl.mockReturnValue(true);
    openclHdr10.mockReturnValue(true); // Linux bridge flag, must be ignored on win32
    expect(dvNoBaseHdr10PathSupported('qsv', 'auto', opts, 'win32')).toBe(false);
    qsvOpenclHdr10.mockReturnValue(true);
    expect(dvNoBaseHdr10PathSupported('qsv', 'auto', opts, 'win32')).toBe(true);
  });

  it('a burn-in-free Vulkan session has no HDR10-target option at all', () => {
    vulkanTonemap.mockReturnValue(true);
    expect(dvNoBaseHdr10PathSupported('vaapi', 'auto', opts, 'linux')).toBe(false);
  });

  it('a Vulkan-eligible session WITH burn-in falls back to the verified CPU chain instead', () => {
    vulkanTonemap.mockReturnValue(true);
    expect(
      dvNoBaseHdr10PathSupported('vaapi', 'auto', { hasCrop: false, hasBurnIn: true }, 'linux'),
    ).toBe(true);
  });

  it('no GPU bridge probed at all: resolveTonemapPath falls to vaapi/CPU, needing no HW probe', () => {
    expect(dvNoBaseHdr10PathSupported('vaapi', 'auto', opts, 'linux')).toBe(true);
    expect(dvNoBaseHdr10PathSupported('qsv', 'auto', opts, 'win32')).toBe(true);
  });
});

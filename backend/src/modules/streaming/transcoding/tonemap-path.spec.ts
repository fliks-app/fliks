jest.mock('./codec/tonemap-opencl-probe', () => ({
  isTonemapOpenclEnabled: jest.fn(() => false),
  isTonemapOpenclEnabledWithCrop: jest.fn(() => false),
}));
jest.mock('./codec/vpp-qsv-probe', () => ({
  isVppQsvTonemapEnabled: jest.fn(() => false),
}));
jest.mock('./codec/qsv-opencl-probe', () => ({
  isQsvOpenclTonemapEnabled: jest.fn(() => false),
}));

import { resolveTonemapPath } from './tonemap-path';
import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
} from './codec/tonemap-opencl-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import { isQsvOpenclTonemapEnabled } from './codec/qsv-opencl-probe';

const openclNoCrop = isTonemapOpenclEnabled as jest.Mock;
const openclCrop = isTonemapOpenclEnabledWithCrop as jest.Mock;
const vppQsv = isVppQsvTonemapEnabled as jest.Mock;
const qsvOpencl = isQsvOpenclTonemapEnabled as jest.Mock;

describe('resolveTonemapPath', () => {
  const origEnv = process.env.TRANSCODE_TONEMAP_ALGO;
  beforeEach(() => {
    openclNoCrop.mockReturnValue(false);
    openclCrop.mockReturnValue(false);
    vppQsv.mockReturnValue(false);
    qsvOpencl.mockReturnValue(false);
    delete process.env.TRANSCODE_TONEMAP_ALGO;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.TRANSCODE_TONEMAP_ALGO;
    else process.env.TRANSCODE_TONEMAP_ALGO = origEnv;
  });

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

  describe('TRANSCODE_TONEMAP_ALGO override', () => {
    it('forces the algo over the probe-driven auto, on any platform', () => {
      openclNoCrop.mockReturnValue(true); // auto would pick opencl on Linux
      process.env.TRANSCODE_TONEMAP_ALGO = 'qsv';
      expect(resolveTonemapPath('auto', { hasCrop: false }, 'linux')).toBe(
        'qsv',
      );
    });

    it('overrides an explicit setting too', () => {
      process.env.TRANSCODE_TONEMAP_ALGO = 'opencl';
      expect(resolveTonemapPath('vaapi', { hasCrop: false }, 'win32')).toBe(
        'opencl',
      );
    });

    it('is case-insensitive and trims whitespace', () => {
      process.env.TRANSCODE_TONEMAP_ALGO = '  OpenCL  ';
      expect(resolveTonemapPath('auto', { hasCrop: false }, 'linux')).toBe(
        'opencl',
      );
    });

    it('ignores an invalid value (falls back to the normal resolution)', () => {
      process.env.TRANSCODE_TONEMAP_ALGO = 'nonsense';
      vppQsv.mockReturnValue(true);
      expect(resolveTonemapPath('auto', { hasCrop: false }, 'win32')).toBe(
        'qsv',
      );
    });
  });
});

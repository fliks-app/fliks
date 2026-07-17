jest.mock('./codec/tonemap-opencl-probe', () => ({
  isTonemapOpenclEnabled: jest.fn(() => false),
  isTonemapOpenclEnabledWithCrop: jest.fn(() => false),
}));
jest.mock('./codec/vpp-qsv-probe', () => ({
  isVppQsvTonemapEnabled: jest.fn(() => false),
}));

import { resolveTonemapPath } from './tonemap-path';
import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
} from './codec/tonemap-opencl-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';

const openclNoCrop = isTonemapOpenclEnabled as jest.Mock;
const openclCrop = isTonemapOpenclEnabledWithCrop as jest.Mock;
const vppQsv = isVppQsvTonemapEnabled as jest.Mock;

describe('resolveTonemapPath', () => {
  beforeEach(() => {
    openclNoCrop.mockReturnValue(false);
    openclCrop.mockReturnValue(false);
    vppQsv.mockReturnValue(false);
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

  it('auto → opencl when the opencl probe passed', () => {
    openclNoCrop.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'linux')).toBe(
      'opencl',
    );
  });

  it('auto consults the crop-variant opencl probe when cropping', () => {
    openclCrop.mockReturnValue(true);
    openclNoCrop.mockReturnValue(false);
    expect(resolveTonemapPath('auto', { hasCrop: true }, 'linux')).toBe(
      'opencl',
    );
    // The no-crop result must not leak into the cropped decision.
    openclCrop.mockReturnValue(false);
    openclNoCrop.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: true }, 'linux')).toBe('vaapi');
  });

  it('auto → vaapi on Linux when opencl is unavailable (VAAPI is a valid QSV path there)', () => {
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'linux')).toBe(
      'vaapi',
    );
  });

  it('auto → qsv on Windows when opencl is unavailable but the vpp_qsv LUT probe passed', () => {
    vppQsv.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'win32')).toBe('qsv');
  });

  it('auto → vaapi on Windows when neither opencl nor the vpp_qsv LUT is available', () => {
    vppQsv.mockReturnValue(false);
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'win32')).toBe(
      'vaapi',
    );
  });

  it('does not divert to the qsv LUT on Linux even when its probe passed', () => {
    vppQsv.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'linux')).toBe(
      'vaapi',
    );
  });

  it('prefers opencl over the qsv LUT on Windows when both are available', () => {
    openclNoCrop.mockReturnValue(true);
    vppQsv.mockReturnValue(true);
    expect(resolveTonemapPath('auto', { hasCrop: false }, 'win32')).toBe(
      'opencl',
    );
  });
});

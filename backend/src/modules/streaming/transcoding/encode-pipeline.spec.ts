import { resolveEncodePipeline } from './encode-pipeline';
import type { EncodePipelineContext } from './encode-pipeline';
import type { CodecVariant } from './codec/types';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';
import { isTonemapOpenclEnabled } from './codec/tonemap-opencl-probe';
import { isAmfOpenclEnabled } from './codec/amf-opencl-probe';

jest.mock('./codec/vpp-qsv-probe', () => ({
  isVppQsvTonemapEnabled: jest.fn(() => false),
}));
jest.mock('./codec/tonemap-opencl-probe', () => ({
  isTonemapOpenclEnabled: jest.fn(() => false),
  isTonemapOpenclEnabledWithCrop: jest.fn(() => false),
}));
jest.mock('./codec/amf-opencl-probe', () => ({
  isAmfOpenclEnabled: jest.fn(() => false),
}));

const mockVppQsvTonemap = isVppQsvTonemapEnabled as jest.Mock;
const mockTonemapOpencl = isTonemapOpenclEnabled as jest.Mock;
const mockAmfOpencl = isAmfOpenclEnabled as jest.Mock;

beforeEach(() => {
  mockVppQsvTonemap.mockReturnValue(false);
  mockTonemapOpencl.mockReturnValue(false);
  mockAmfOpencl.mockReturnValue(false);
});

const SDR_H264: CodecVariant = { codec: 'h264', bitDepth: 8, hdr: null };

function ctx(over: Partial<EncodePipelineContext>): EncodePipelineContext {
  return {
    hwAccel: 'qsv',
    crop: false,
    burnIn: false,
    tonemap: false,
    tonemapAlgo: 'auto',
    sourceVideoCodec: 'h264',
    dvNoBase: false,
    sourceBitDepth: 8,
    ...over,
  };
}

describe('resolveEncodePipeline — Windows QSV routing', () => {
  it('routes an SDR QSV session through the qsv-native pipeline on Windows', () => {
    const r = resolveEncodePipeline(SDR_H264, ctx({}), 'win32');
    expect(r.qsvNativeAvailable).toBe(true);
    expect(r.effectiveHwAccel).toBe('qsv');
  });

  it('keeps the Linux SDR no-crop QSV session on the VAAPI-output chain', () => {
    const r = resolveEncodePipeline(SDR_H264, ctx({}), 'linux');
    // Native is reserved for crop / GPU-tonemap on Linux; plain SDR stays on
    // the scale_vaapi -> hwmap chain.
    expect(r.qsvNativeAvailable).toBe(false);
    expect(r.effectiveHwAccel).toBe('qsv');
  });

  it('drops to CPU on Windows when QSV has no viable native tonemap path', () => {
    const r = resolveEncodePipeline(
      SDR_H264,
      ctx({ tonemap: true, tonemapAlgo: 'vaapi', sourceVideoCodec: 'hevc' }),
      'win32',
    );
    expect(r.qsvNativeAvailable).toBe(false);
    expect(r.requestedHwAccel).toBe('none');
    expect(r.effectiveHwAccel).toBe('none');
  });

  it('drops a no-base DV source to CPU when the OpenCL bridge is unavailable (Linux)', () => {
    const r = resolveEncodePipeline(
      SDR_H264,
      ctx({
        tonemap: true,
        tonemapAlgo: 'vaapi',
        sourceVideoCodec: 'hevc',
        dvNoBase: true,
      }),
      'linux',
    );
    // tonemapPath falls back to 'vaapi' (RPU-blind), so the whole pipeline
    // must come off HW rather than run tonemap_vaapi on a no-base source.
    expect(r.tonemapPath).toBe('vaapi');
    expect(r.qsvNativeAvailable).toBe(false);
    expect(r.useVaapiTonemap).toBe(false);
    expect(r.requestedHwAccel).toBe('none');
    expect(r.effectiveHwAccel).toBe('none');
  });

  it('keeps a Windows auto HDR tonemap on QSV via the vpp_qsv LUT (no CPU drop)', () => {
    mockVppQsvTonemap.mockReturnValue(true);
    const r = resolveEncodePipeline(
      SDR_H264,
      ctx({ tonemap: true, tonemapAlgo: 'auto', sourceVideoCodec: 'hevc' }),
      'win32',
    );
    expect(r.tonemapPath).toBe('qsv');
    expect(r.qsvNativeAvailable).toBe(true);
    expect(r.requestedHwAccel).toBe('qsv');
    expect(r.effectiveHwAccel).toBe('qsv');
  });
});

describe('resolveEncodePipeline — AMF tonemap', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  )!;
  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
  });

  it('forces the CPU tonemap (never VAAPI) for an AMF HDR->SDR encode', () => {
    // The AMF encoders gate supports() on win32; fake the platform so the
    // registry actually resolves one.
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    const r = resolveEncodePipeline(
      SDR_H264,
      ctx({
        hwAccel: 'amf',
        tonemap: true,
        tonemapAlgo: 'vaapi',
        sourceVideoCodec: 'hevc',
      }),
      'win32',
    );
    expect(r.effectiveHwAccel).toBe('amf');
    expect(r.useVaapiTonemap).toBe(false);
  });

  const winAmfCleanSdr = () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    return resolveEncodePipeline(
      SDR_H264,
      ctx({ hwAccel: 'amf', tonemap: false, sourceVideoCodec: 'h264' }),
      'win32',
    );
  };

  it('uses the zero-copy OpenCL path when its probe passed', () => {
    mockAmfOpencl.mockReturnValue(true);
    const r = winAmfCleanSdr();
    expect(r.effectiveHwAccel).toBe('amf');
    expect(r.amfOpenclAvailable).toBe(true);
  });

  it('degrades to the CPU scale when the OpenCL probe failed', () => {
    const r = winAmfCleanSdr();
    expect(r.effectiveHwAccel).toBe('amf');
    expect(r.amfOpenclAvailable).toBe(false);
  });

  it('gates the native decoder on source bit depth (H.264 Hi10P exceeds it)', () => {
    mockAmfOpencl.mockReturnValue(true);
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    const r = resolveEncodePipeline(
      SDR_H264,
      ctx({ hwAccel: 'amf', sourceVideoCodec: 'h264', sourceBitDepth: 10 }),
      'win32',
    );
    expect(r.amfOpenclAvailable).toBe(false);
  });
});

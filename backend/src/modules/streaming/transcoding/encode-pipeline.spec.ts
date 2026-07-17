import { resolveEncodePipeline } from './encode-pipeline';
import type { EncodePipelineContext } from './encode-pipeline';
import type { CodecVariant } from './codec/types';
import { isScaleD3d11Enabled } from './codec/scale-d3d11-probe';
import { isVppQsvTonemapEnabled } from './codec/vpp-qsv-probe';

jest.mock('./codec/scale-d3d11-probe', () => ({
  isScaleD3d11Enabled: jest.fn(() => false),
}));
jest.mock('./codec/vpp-qsv-probe', () => ({
  isVppQsvTonemapEnabled: jest.fn(() => false),
}));

const mockScaleD3d11 = isScaleD3d11Enabled as jest.Mock;
const mockVppQsvTonemap = isVppQsvTonemapEnabled as jest.Mock;

beforeEach(() => {
  mockVppQsvTonemap.mockReturnValue(false);
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
  beforeEach(() => {
    mockScaleD3d11.mockReturnValue(false);
  });
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

  it('uses the zero-copy scale_d3d11 path when its probe passed', () => {
    mockScaleD3d11.mockReturnValue(true);
    const r = winAmfCleanSdr();
    expect(r.effectiveHwAccel).toBe('amf');
    expect(r.amfFullGpuAvailable).toBe(true);
  });

  it('degrades to the CPU scale when the scale_d3d11 probe failed', () => {
    // The filter is absent (FFmpeg < 8.1) or the GPU rejected its output
    // texture — must NOT crash-cycle, just fall back.
    const r = winAmfCleanSdr();
    expect(r.effectiveHwAccel).toBe('amf');
    expect(r.amfFullGpuAvailable).toBe(false);
  });

  it('keeps the CPU-decode path when the AMF encode tonemaps', () => {
    mockScaleD3d11.mockReturnValue(true);
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    const r = resolveEncodePipeline(
      SDR_H264,
      ctx({ hwAccel: 'amf', tonemap: true, sourceVideoCodec: 'hevc' }),
      'win32',
    );
    expect(r.amfFullGpuAvailable).toBe(false);
  });
});

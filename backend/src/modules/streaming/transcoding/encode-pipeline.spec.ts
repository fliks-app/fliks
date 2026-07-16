import { resolveEncodePipeline } from './encode-pipeline';
import type { EncodePipelineContext } from './encode-pipeline';
import type { CodecVariant } from './codec/types';

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
});

describe('resolveEncodePipeline — AMF tonemap', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  )!;
  afterEach(() =>
    Object.defineProperty(process, 'platform', platformDescriptor),
  );

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

  it('uses the full-GPU pipeline for a clean SDR AMF encode (default)', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    const r = resolveEncodePipeline(
      SDR_H264,
      ctx({ hwAccel: 'amf', tonemap: false, sourceVideoCodec: 'h264' }),
      'win32',
    );
    expect(r.effectiveHwAccel).toBe('amf');
    expect(r.amfFullGpuAvailable).toBe(true);
  });

  it('keeps the CPU-decode path when the AMF encode tonemaps', () => {
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

import { Logger } from '@nestjs/common';

jest.mock('./codec/opencl-tonemap-probe', () => ({
  isOpenclTonemapEnabled: jest.fn(() => true),
}));
jest.mock('./codec/tonemap-opencl-probe', () => ({
  isTonemapOpenclEnabled: jest.fn(() => true),
  isTonemapOpenclEnabledWithCrop: jest.fn(() => true),
}));
jest.mock('./codec/cuda-tonemap-probe', () => ({
  isCudaTonemapEnabled: jest.fn(() => false),
}));
jest.mock('./codec/amf-opencl-probe', () => ({
  isAmfOpenclEnabled: jest.fn(() => false),
}));

import { buildFfmpegArgs } from './ffmpeg-args';
import type { BuildFfmpegArgsOptions } from './ffmpeg-args';
import { resolveEncodePipeline } from './encode-pipeline';
import type { CodecVariant } from './codec/types';
import { isCudaTonemapEnabled } from './codec/cuda-tonemap-probe';
import { isAmfOpenclEnabled } from './codec/amf-opencl-probe';

const mockCudaTonemap = isCudaTonemapEnabled as jest.Mock;
const mockAmfOpencl = isAmfOpenclEnabled as jest.Mock;

const silentLog = {
  debug: () => {},
  log: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const H264_SDR: CodecVariant = { codec: 'h264', bitDepth: 8, hdr: null };

const opts = (over: Partial<BuildFfmpegArgsOptions>): BuildFfmpegArgsOptions =>
  ({
    inputPath: '/media/in.mkv',
    outputDir: '/cache/out',
    hwAccel: 'none',
    profile: {
      name: '2160p',
      maxWidth: 3840,
      maxHeight: 2160,
      videoBitrate: '15M',
      audioBitrate: '192k',
    },
    videoVariant: H264_SDR,
    // 10-bit HEVC HDR source tone-mapped to 8-bit SDR — the openclTonemap case.
    sourceVideoCodec: 'hevc',
    sourceBitDepth: 10,
    sourceWidth: 3840,
    sourceHeight: 2160,
    sourceFps: 24,
    trustedStreamInfo: true,
    tonemap: true,
    ...over,
  }) as BuildFfmpegArgsOptions;

const vfOf = (args: string[]): string => args[args.indexOf('-vf') + 1];

// #729 Proposal 1: the OpenCL tone-map path decodes on the GPU (was forced to
// CPU). The boot probe is mocked enabled so buildFfmpegArgs takes that branch.
describe('buildFfmpegArgs — HW decode on the OpenCL tone-map path (#729)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  )!;
  afterEach(() =>
    Object.defineProperty(process, 'platform', platformDescriptor),
  );

  it('NVENC: NVDEC-decodes (not CPU) and hwdownloads into tonemap_opencl', () => {
    const args = buildFfmpegArgs(opts({ hwAccel: 'nvenc' }), silentLog);
    const cli = args.join(' ');
    // GPU decode — before Proposal 1 this path forced software decode.
    expect(cli).toContain('-hwaccel cuda -hwaccel_output_format cuda');
    // OpenCL filter device, inited exactly once (no duplicate `ocl` alias).
    expect(cli).toContain('-init_hw_device opencl=ocl -filter_hw_device ocl');
    expect(args.filter((a) => a === 'opencl=ocl')).toHaveLength(1);
    // cuda surface pulled to system memory, tone-mapped on OpenCL, back to CPU.
    const vf = vfOf(args);
    expect(vf.startsWith('hwdownload,format=p010le,')).toBe(true);
    expect(vf).toContain('tonemap_opencl=');
    expect(vf).toContain('hwdownload,format=nv12');
  });

  it('AMF: d3d11va-decodes (not CPU) feeding tonemap_opencl', () => {
    // AMF encoders are win32-gated.
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    const args = buildFfmpegArgs(opts({ hwAccel: 'amf' }), silentLog);
    const cli = args.join(' ');
    expect(cli).toContain('-hwaccel d3d11va');
    expect(cli).toContain('-init_hw_device opencl=ocl -filter_hw_device ocl');
    expect(args.filter((a) => a === 'opencl=ocl')).toHaveLength(1);
    expect(vfOf(args)).toContain('tonemap_opencl=');
  });
});

// AMF's zero-copy D3D11↔OpenCL chain (replacing scale_d3d11, and the CPU-bounce
// opencl tonemap) once its own boot probe passes.
describe('buildFfmpegArgs: AMF zero-copy D3D11↔OpenCL chain (win32)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  )!;
  beforeEach(() => {
    mockAmfOpencl.mockReturnValue(true);
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
  });
  afterEach(() => {
    mockAmfOpencl.mockReturnValue(false);
    Object.defineProperty(process, 'platform', platformDescriptor);
  });

  it('inits the named d3d11va/opencl devices once, decodes natively, no duplicate ocl', () => {
    const args = buildFfmpegArgs(opts({ hwAccel: 'amf' }), silentLog);
    const cli = args.join(' ');
    expect(cli).toContain('-init_hw_device d3d11va=dx:,vendor_id=0x1002');
    expect(cli).toContain('-init_hw_device opencl=ocl@dx');
    expect(cli).toContain('-filter_hw_device ocl');
    expect(cli).toContain('-hwaccel d3d11va -hwaccel_output_format d3d11');
    expect(cli).toContain('-hwaccel_device dx');
    // Single `ocl` device alias: the plain CPU-bounce opencl init must not
    // also fire alongside the zero-copy one.
    expect(args.filter((a) => a.startsWith('opencl=ocl'))).toHaveLength(1);
    const vf = vfOf(args);
    expect(vf).toContain('hwmap=derive_device=opencl:mode=read');
    expect(vf).toContain('scale_opencl=');
    expect(vf).toContain('tonemap_opencl=');
    expect(vf).toContain('hwmap=derive_device=d3d11va:mode=write:reverse=1,format=d3d11');
  });
});

// A no-base DV source (P5) must never decode on the qsv wrapper (drops the
// RPU) or tonemap through a RPU-blind vaapi/qsv filter.
describe('buildFfmpegArgs: no-base Dolby Vision keeps the RPU', () => {
  const dv5 = (over: Partial<BuildFfmpegArgsOptions> = {}) =>
    opts({ hwAccel: 'qsv', sourceDvProfile: 5, ...over });

  it('QSV: decodes on native VAAPI (never the qsv wrapper) and tonemaps via tonemap_opencl', () => {
    const args = buildFfmpegArgs(dv5(), silentLog);
    const cli = args.join(' ');
    expect(cli).toContain('-hwaccel vaapi');
    expect(cli).not.toContain('-hwaccel qsv');
    expect(cli).toContain('tonemap_opencl');
    expect(cli).toMatch(/-c:v (h264|hevc)_qsv\b/);
    expect(cli).not.toContain('libx264');
    expect(cli).not.toContain('libx265');
    // No-base DV source (P5): the RPU is trustworthy, so apply it.
    expect(cli).toContain('apply_dovi=1');
  });

  it('NVENC: tonemaps a no-base DV source via tonemap_opencl on an _nvenc encoder', () => {
    const args = buildFfmpegArgs(dv5({ hwAccel: 'nvenc' }), silentLog);
    const cli = args.join(' ');
    expect(cli).toContain('-hwaccel cuda');
    expect(cli).toContain('tonemap_opencl');
    expect(cli).toContain('apply_dovi=1');
    expect(cli).toMatch(/-c:v \w+_nvenc\b/);
  });

  it('NVENC: tonemaps a has-base DV source (P8.1) without applying its RPU', () => {
    const args = buildFfmpegArgs(
      opts({
        hwAccel: 'nvenc',
        sourceDvProfile: 8,
        sourceDvBlSignalCompatId: 1,
      }),
      silentLog,
    );
    const cli = args.join(' ');
    expect(cli).toContain('tonemap_opencl');
    // Has-base (P8): the base layer is tone-mapped, no P7-FEL RPU carried over.
    expect(cli).toContain('apply_dovi=0');
  });

  it('resolveEncodePipeline reports the same accel/encoder buildFfmpegArgs spawns', () => {
    const args = buildFfmpegArgs(dv5(), silentLog);
    const pipeline = resolveEncodePipeline(
      H264_SDR,
      {
        hwAccel: 'qsv',
        crop: false,
        burnIn: false,
        tonemap: true,
        tonemapAlgo: 'auto',
        sourceVideoCodec: 'hevc',
        dvNoBase: true,
      },
    );
    expect(pipeline.effectiveHwAccel).toBe('qsv');
    expect(args.join(' ')).toContain(`-c:v ${pipeline.encoder?.id}`);
  });
});

// NVENC prefers tonemap_cuda (zero-copy) over the opencl bounce once its own
// boot probe passes.
describe('buildFfmpegArgs: NVENC tonemap_cuda once its probe passes', () => {
  beforeEach(() => mockCudaTonemap.mockReturnValue(true));
  afterEach(() => mockCudaTonemap.mockReturnValue(false));

  it('P5 (no base): tonemap_cuda applies the RPU, no opencl device', () => {
    const args = buildFfmpegArgs(
      opts({ hwAccel: 'nvenc', sourceDvProfile: 5 }),
      silentLog,
    );
    const cli = args.join(' ');
    expect(cli).toContain('-hwaccel cuda -hwaccel_output_format cuda');
    expect(cli).toContain('tonemap_cuda=');
    expect(cli).toContain('apply_dovi=1');
    expect(cli).not.toContain('tonemap_opencl');
    expect(cli).not.toContain('opencl=ocl');
  });

  it('P8.1 (has base): tonemap_cuda without applying its RPU', () => {
    const args = buildFfmpegArgs(
      opts({
        hwAccel: 'nvenc',
        sourceDvProfile: 8,
        sourceDvBlSignalCompatId: 1,
      }),
      silentLog,
    );
    const cli = args.join(' ');
    expect(cli).toContain('tonemap_cuda=');
    expect(cli).toContain('apply_dovi=0');
    expect(cli).not.toContain('tonemap_opencl');
  });
});

// Subtitle burn-in must not silently drop the GPU pipeline (NVENC text) or
// break the PGS composite on a chain that already ends on CPU frames (AMF).
describe('buildFfmpegArgs: subtitle burn-in keeps the GPU pipeline', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  )!;
  beforeEach(() => mockCudaTonemap.mockReturnValue(false));
  afterEach(() =>
    Object.defineProperty(process, 'platform', platformDescriptor),
  );

  it('NVENC: text burn-in keeps NVDEC + the tone-map, libass runs on the CPU tail', () => {
    const args = buildFfmpegArgs(
      opts({
        hwAccel: 'nvenc',
        burnIn: { type: 'text', filter: "subtitles='/tmp/s.srt'" },
      }),
      silentLog,
    );
    const cli = args.join(' ');
    expect(cli).toContain('-hwaccel cuda -hwaccel_output_format cuda');
    expect(cli).toMatch(/-c:v \w+_nvenc\b/);
    const vf = vfOf(args);
    expect(vf).toContain('tonemap_opencl=');
    expect(vf.endsWith(",subtitles='/tmp/s.srt'")).toBe(true);
  });

  it('AMF: PGS burn-in composites on the CPU chain with no stray hwdownload', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    const args = buildFfmpegArgs(
      opts({
        hwAccel: 'amf',
        burnIn: { type: 'image', filter: null, streamIndex: 3 },
      }),
      silentLog,
    );
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc.match(/hwdownload/g)).toHaveLength(1);
    expect(fc).not.toContain('extra_hw_frames');
    expect(fc).toContain('[ov]format=yuv420p[vout]');
  });
});

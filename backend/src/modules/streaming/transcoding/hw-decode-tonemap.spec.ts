import { Logger } from '@nestjs/common';

jest.mock('./codec/opencl-tonemap-probe', () => ({
  isOpenclTonemapEnabled: jest.fn(() => true),
}));
jest.mock('./codec/tonemap-opencl-probe', () => ({
  isTonemapOpenclEnabled: jest.fn(() => true),
  isTonemapOpenclEnabledWithCrop: jest.fn(() => true),
}));

import { buildFfmpegArgs } from './ffmpeg-args';
import type { BuildFfmpegArgsOptions } from './ffmpeg-args';
import { resolveEncodePipeline } from './encode-pipeline';
import type { CodecVariant } from './codec/types';

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

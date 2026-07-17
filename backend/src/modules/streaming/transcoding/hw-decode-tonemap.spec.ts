import { Logger } from '@nestjs/common';

jest.mock('./codec/opencl-tonemap-probe', () => ({
  isOpenclTonemapEnabled: jest.fn(() => true),
}));

import { buildFfmpegArgs } from './ffmpeg-args';
import type { BuildFfmpegArgsOptions } from './ffmpeg-args';
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

jest.mock('./codec/libplacebo-dv-probe', () => ({
  isLibplaceboDvEnabled: () => true,
  runLibplaceboDvProbe: async () => {},
}));

import { Logger } from '@nestjs/common';
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
    hwAccel: 'qsv',
    profile: {
      name: '1080p',
      maxWidth: 1920,
      maxHeight: 1080,
      videoBitrate: '8M',
      audioBitrate: '192k',
    },
    videoVariant: H264_SDR,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceFps: 24,
    trustedStreamInfo: true,
    tonemap: true,
    sourceBitDepth: 10,
    ...over,
  }) as BuildFfmpegArgsOptions;

describe('buildFfmpegArgs — Dolby Vision Profile 5', () => {
  it('routes P5 through the vulkan/libplacebo tonemap on CPU encode', () => {
    const args = buildFfmpegArgs(
      opts({ sourceDvProfile: 5, sourceDvBlSignalCompatId: 0 }),
      silentLog,
    );
    const vk = args.indexOf('vulkan=vk:0');
    expect(vk).toBeGreaterThan(-1);
    expect(vk).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('-filter_hw_device');
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toContain('libplacebo=apply_dolbyvision=1');
    expect(vf).not.toContain('tonemap=mobius');
    // useDoviTonemap forces CPU encode even on a qsv host.
    expect(args).toContain('libx264');
    expect(args).not.toContain('h264_qsv');
  });

  it('leaves DV 8.1 (compat id 1) on the standard path — no libplacebo', () => {
    const args = buildFfmpegArgs(
      opts({ sourceDvProfile: 8, sourceDvBlSignalCompatId: 1 }),
      silentLog,
    );
    expect(args).not.toContain('vulkan=vk:0');
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).not.toContain('libplacebo');
  });
});

import { Logger } from '@nestjs/common';
import { buildFfmpegArgs } from './ffmpeg-args';

const silentLog = { debug() {}, log() {}, warn() {}, error() {} } as unknown as Logger;

// #1486 regression: subtitle-overlay-filter.ts used to append `hwdownload`
// unconditionally, which aborted the graph once NVENC's own chain already
// ended on CPU frames (no probed GPU tone-map here; cuda and opencl both
// fail-closed by default).
describe('buildFfmpegArgs: NVENC + PGS burn-in with no probed GPU tone-map', () => {
  it('composites on the CPU chain with no second hwdownload', () => {
    const args = buildFfmpegArgs(
      {
        inputPath: '/media/in.mkv',
        outputDir: '/cache/out',
        hwAccel: 'nvenc',
        profile: { name: '1080p', maxWidth: 1920, maxHeight: 1080, videoBitrate: '8M', audioBitrate: '192k' },
        videoVariant: { codec: 'h264', bitDepth: 8, hdr: null },
        sourceVideoCodec: 'hevc',
        sourceBitDepth: 10,
        sourceWidth: 3840,
        sourceHeight: 2160,
        sourceFps: 24,
        trustedStreamInfo: true,
        tonemap: true,
        burnIn: { type: 'image', filter: null, streamIndex: 3 },
      } as never,
      silentLog,
    );
    const fc = args[args.indexOf('-filter_complex') + 1];
    // Only the decode-bridge hwdownload (the CPU zscale tone-map already ends
    // on CPU frames); a second one on top would abort with "Impossible to
    // convert between the formats".
    expect(fc.match(/hwdownload/g)).toHaveLength(1);
    expect(fc).not.toContain('hwupload_cuda');
    expect(fc).toContain('[ov]format=yuv420p[vout]');
  });
});

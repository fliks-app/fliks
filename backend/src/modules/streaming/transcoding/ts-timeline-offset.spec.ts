import { Logger } from '@nestjs/common';
import { buildFfmpegArgs } from './ffmpeg-args';
import type { BuildFfmpegArgsOptions } from './ffmpeg-args';
import { realSegmentSeconds } from './constants';
import type { CodecVariant } from './codec/types';

/**
 * The HLS muxer restarts its output timeline near zero on every run, so a
 * resumed run's segments contradict the playlist that places `seg-N` at
 * `N · realSeg`. fMP4 is re-anchored on serve (`rewriteSegmentTfdt`); MPEG-TS
 * carries no `tfdt`, so the offset has to be applied at encode time or the
 * segment's own PTS stay run-relative. Tizen takes the TS path on
 * single-audio sources (`useTsOnSingleAudio`), which is where the video froze
 * for one segment on resume while audio played.
 */
describe('MPEG-TS resume timeline offset', () => {
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
        name: '1080p',
        maxWidth: 1920,
        maxHeight: 1080,
        videoBitrate: '8M',
        audioBitrate: '192k',
      },
      videoVariant: H264_SDR,
      sourceWidth: 1920,
      sourceHeight: 1080,
      trustedStreamInfo: true,
      ...over,
    }) as BuildFfmpegArgsOptions;

  const offsetOf = (args: string[]): string | undefined => {
    const i = args.indexOf('-output_ts_offset');
    return i === -1 ? undefined : args[i + 1];
  };

  it('anchors a resumed TS run on the playlist grid', () => {
    const fps = 24000 / 1001; // 23.976
    const args = buildFfmpegArgs(
      opts({ useTs: true, startSegment: 20, sourceFps: fps }),
      silentLog,
    );
    // The content time the playlist gives seg-0020, on the fps-aware grid
    // (20 × 3.003 at the default 3s setting), not the integer 20 × 3.
    expect(offsetOf(args)).toBe(String(20 * realSegmentSeconds(3, fps)));
    expect(offsetOf(args)).not.toBe(String(20 * 3));
    // Applied to the muxer, so it must precede the output format.
    expect(args.indexOf('-output_ts_offset')).toBeLessThan(
      args.indexOf('-f'),
    );
  });

  it('leaves a TS run that starts at zero alone', () => {
    const args = buildFfmpegArgs(
      opts({ useTs: true, startSegment: 0, sourceFps: 24 }),
      silentLog,
    );
    expect(offsetOf(args)).toBeUndefined();
  });

  it('never offsets fMP4 — the tfdt rewrite owns that timeline', () => {
    const args = buildFfmpegArgs(
      opts({ useTs: false, startSegment: 20, sourceFps: 24000 / 1001 }),
      silentLog,
    );
    // Both would double-shift: the rewrite adds the run start on serve.
    expect(offsetOf(args)).toBeUndefined();
  });
});

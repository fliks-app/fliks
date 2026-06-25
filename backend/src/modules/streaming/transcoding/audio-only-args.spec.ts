import { Logger } from '@nestjs/common';
import { buildAudioOnlyFfmpegArgs } from './ffmpeg-args';
import { segmentIndexToSeconds } from './constants';

describe('buildAudioOnlyFfmpegArgs', () => {
  const log = new Logger('test');

  it('applies a single input-side -ss on resume (no double seek)', () => {
    const args = buildAudioOnlyFfmpegArgs(
      {
        inputPath: '/in.mkv',
        outputDir: '/out',
        audioStreamIndex: 0,
        startSegment: 5,
        trustedStreamInfo: true,
      },
      log,
    );
    // Exactly one -ss: a second (output-side, after -copyts) would re-discard
    // the resume offset and start the audio at 2×T.
    expect(args.filter((a) => a === '-ss')).toHaveLength(1);
    // It precedes -i (demuxer seek), so -copyts threads the source PTS cleanly.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
  });

  it('seeks on the fps-aware grid so audio stays aligned with video on fractional fps', () => {
    const fps = 24000 / 1001; // 23.976
    const args = buildAudioOnlyFfmpegArgs(
      {
        inputPath: '/in.mkv',
        outputDir: '/out',
        audioStreamIndex: 0,
        startSegment: 5,
        trustedStreamInfo: true,
        sourceFps: fps,
      },
      log,
    );
    const seek = args[args.indexOf('-ss') + 1];
    // Must match the video path's fps-aware seek, not the integer-grid value.
    expect(seek).toBe(String(segmentIndexToSeconds(5, fps)));
    expect(seek).not.toBe(String(segmentIndexToSeconds(5)));
  });

  it('emits no -ss for a fresh start', () => {
    const args = buildAudioOnlyFfmpegArgs(
      {
        inputPath: '/in.mkv',
        outputDir: '/out',
        audioStreamIndex: 0,
        trustedStreamInfo: true,
      },
      log,
    );
    expect(args).not.toContain('-ss');
  });
});

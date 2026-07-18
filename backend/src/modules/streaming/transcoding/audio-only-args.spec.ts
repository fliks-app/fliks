import { Logger } from '@nestjs/common';
import { buildAudioOnlyFfmpegArgs } from './ffmpeg-args';
import { realSegmentSeconds, segmentIndexToSeconds } from './constants';

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
    expect(seek).toBe(String(segmentIndexToSeconds(5, 3, fps)));
    expect(seek).not.toBe(String(segmentIndexToSeconds(5, 3)));
  });

  it('cuts on the fps-aware grid so audio renditions stay aligned with the video IDRs', () => {
    const fps = 24000 / 1001; // 23.976
    const args = buildAudioOnlyFfmpegArgs(
      {
        inputPath: '/in.mkv',
        outputDir: '/out',
        audioStreamIndex: 0,
        trustedStreamInfo: true,
        sourceFps: fps,
      },
      log,
    );
    const hlsTime = args[args.indexOf('-hls_time') + 1];
    // Must match the video IDR / EXTINF grid (3.003s), not the integer 3.0s
    // setting — otherwise the audio tfdt drifts a whole segment mid-film.
    expect(hlsTime).toBe(String(realSegmentSeconds(3, fps)));
    expect(hlsTime).not.toBe('3');
  });

  it('cuts on the integer grid when fps is unknown (no regression)', () => {
    const args = buildAudioOnlyFfmpegArgs(
      { inputPath: '/in.mkv', outputDir: '/out', audioStreamIndex: 0 },
      log,
    );
    expect(args[args.indexOf('-hls_time') + 1]).toBe('3');
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

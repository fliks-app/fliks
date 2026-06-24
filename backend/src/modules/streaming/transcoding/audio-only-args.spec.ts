import { Logger } from '@nestjs/common';
import { buildAudioOnlyFfmpegArgs } from './ffmpeg-args';

describe('buildAudioOnlyFfmpegArgs', () => {
  const log = new Logger('test');

  it('applies a single input-side -ss on resume (no double seek)', () => {
    const args = buildAudioOnlyFfmpegArgs(
      '/in.mkv',
      '/out',
      0,
      '192k',
      5, // startSegment
      true,
      log,
      false,
    );
    // Exactly one -ss: a second (output-side, after -copyts) would re-discard
    // the resume offset and start the audio at 2×T.
    expect(args.filter((a) => a === '-ss')).toHaveLength(1);
    // It precedes -i (demuxer seek), so -copyts threads the source PTS cleanly.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
  });

  it('emits no -ss for a fresh start', () => {
    const args = buildAudioOnlyFfmpegArgs(
      '/in.mkv',
      '/out',
      0,
      '192k',
      0,
      true,
      log,
      false,
    );
    expect(args).not.toContain('-ss');
  });
});

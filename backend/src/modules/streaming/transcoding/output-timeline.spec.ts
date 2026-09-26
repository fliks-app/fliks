import { Logger } from '@nestjs/common';
import { audioStartAlignFilter, buildFfmpegArgs, buildRemuxArgs } from './ffmpeg-args';
import type { BuildFfmpegArgsOptions, BuildRemuxArgsOptions } from './ffmpeg-args';
import { realSegmentSeconds } from './constants';

/**
 * Every fMP4 run starts its output at 0 with the audio padded to the run's
 * first video frame: a track starting later lands in an empty edit, which MSE
 * ignores. Serving adds the source origin back (timeline.ts).
 */
const silentLog = {
  debug: () => {},
  log: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

const tx = (over: Partial<BuildFfmpegArgsOptions>): string[] =>
  buildFfmpegArgs(
    {
      inputPath: '/media/in.ts',
      outputDir: '/cache/out',
      hwAccel: 'none',
      profile: {
        name: '1080p',
        maxWidth: 1920,
        maxHeight: 1080,
        videoBitrate: '8M',
        audioBitrate: '192k',
      },
      videoVariant: { codec: 'h264', bitDepth: 8, hdr: null },
      sourceWidth: 1920,
      sourceHeight: 1080,
      trustedStreamInfo: true,
      sourceFps: 25,
      ...over,
    } as BuildFfmpegArgsOptions,
    silentLog,
  );

const remux = (over: Partial<BuildRemuxArgsOptions>): string[] =>
  buildRemuxArgs({
    inputPath: '/media/in.ts',
    outputDir: '/cache/out',
    copyAudio: false,
    trustedStreamInfo: true,
    sourceVideoCodec: 'h264',
    sourceHasBFrames: false,
    ...over,
  });

const after = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const last = (args: string[], flag: string): string | undefined => {
  const i = args.lastIndexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe('fMP4 output origin', () => {
  it('starts every transcode run at 0, whatever the resume segment', () => {
    expect(after(tx({ sourceStartPts: 2.8 }), '-output_ts_offset')).toBe('-2.8');
    // A seeked run is rebased by its own output -ss, which ffmpeg subtracts.
    const seeked = tx({ sourceStartPts: 2.8, startSegment: 20 });
    expect(seeked).not.toContain('-output_ts_offset');
    expect(last(seeked, '-ss')).toBe(String(20 * realSegmentSeconds(3, 25) + 2.8));
  });

  it('keeps a negative video start in the output, where it becomes an edit', () => {
    expect(after(tx({ sourceStartPts: -0.042 }), '-output_ts_offset')).toBeUndefined();
  });

  it('leaves the absolute MPEG-TS timeline alone', () => {
    expect(
      after(tx({ sourceStartPts: 2.8, useTs: true }), '-output_ts_offset'),
    ).toBeUndefined();
    // A seeked TS run gets back what its output -ss took away.
    const seeked = tx({ sourceStartPts: 2.8, useTs: true, startSegment: 20 });
    expect(after(seeked, '-output_ts_offset')).toBe(last(seeked, '-ss'));
  });

  it('starts every remux run at 0 as well', () => {
    expect(after(remux({ sourceStartPts: 2.8 }), '-output_ts_offset')).toBe('-2.8');
  });
});

describe('transcode resume seek', () => {
  const seek = 20 * realSegmentSeconds(3, 25);

  it('seeks the input from the container start, the output in source time', () => {
    const args = tx({ sourceStartPts: 4.2, sourceFormatStart: 3.18, startSegment: 20 });
    expect(after(args, '-ss')).toBe(String(Number((seek + 4.2 - 3.18).toFixed(6))));
    expect(last(args, '-ss')).toBe(String(Number((seek + 4.2).toFixed(6))));
  });

  it('keeps the seek when the container starts with the video', () => {
    const args = tx({ sourceStartPts: 2.8, startSegment: 20 });
    expect(after(args, '-ss')).toBe(String(seek));
  });
});

describe('transcoded audio alignment', () => {
  const plan = { mode: 'transcode' as const, codec: 'aac' as const, bitrateBps: 192_000 };

  it('pads the run from 0 to the video start', () => {
    expect(after(tx({ sourceStartPts: 2.8, audioPlan: plan }), '-filter:a')).toBe(
      audioStartAlignFilter(2.8),
    );
  });

  it('pads a seeked run to its own first frame, in source time', () => {
    const seek = 20 * realSegmentSeconds(3, 25);
    expect(
      after(tx({ sourceStartPts: 2.8, startSegment: 20, audioPlan: plan }), '-filter:a'),
    ).toBe(audioStartAlignFilter(seek + 2.8));
  });

  it('never filters a copied track', () => {
    const args = tx({ sourceStartPts: 2.8, audioPlan: { mode: 'copy', codec: 'aac' } });
    expect(args).not.toContain('-filter:a');
  });

  it('keeps the planned channels on the inline output', () => {
    const args = tx({ audioPlan: { ...plan, codec: 'eac3', channels: 2 } });
    expect(after(args, '-c:a')).toBe('eac3');
    expect(after(args, '-ac')).toBe('2');
  });
});

describe('remux resume', () => {
  const bounds = [2.8, 5.8, 8.8, 11.8];

  it('seeks to the absolute keyframe boundary', () => {
    const args = remux({ startSegment: 3, segmentBoundaries: bounds, sourceStartPts: 2.8 });
    expect(after(args, '-seek_timestamp')).toBe('1');
    expect(after(args, '-ss')).toBe('11.800');
    expect(args).toContain('-noaccurate_seek');
    expect(after(args, '-filter:a')).toBe(audioStartAlignFilter(11.8));
  });

  it('adds the origin to the uniform-grid fallback', () => {
    const args = remux({ startSegment: 3, segmentDuration: 3, sourceStartPts: 2.8 });
    expect(after(args, '-ss')).toBe('11.800');
  });

  it('pads the run from 0 to the video start', () => {
    expect(after(remux({ sourceStartPts: 2.8 }), '-filter:a')).toBe(
      audioStartAlignFilter(2.8),
    );
    expect(remux({})).not.toContain('-seek_timestamp');
  });

  it('re-encodes to the planned codec and channels, or copies untouched', () => {
    const planned = remux({
      audioPlan: { mode: 'transcode', codec: 'eac3', bitrateBps: 640_000, channels: 6 },
    });
    expect(after(planned, '-c:a')).toBe('eac3');
    expect(after(planned, '-ac')).toBe('6');
    const copied = remux({ copyAudio: true });
    expect(after(copied, '-c:a')).toBe('copy');
    expect(copied).not.toContain('-filter:a');
  });

  it('applies the default-track plan only to the default track', () => {
    const args = remux({
      audioStreamIndex: 1,
      audioStreams: [{ streamIndex: 1 }, { streamIndex: 2 }],
      audioPlan: { mode: 'transcode', codec: 'eac3', bitrateBps: 640_000, channels: 6 },
    });
    expect(after(args, '-c:a')).toBe('aac');
    expect(after(args, '-ac')).toBe('2');
  });

  it('falls back to AAC stereo when the copy decision and the plan disagree', () => {
    const args = remux({ audioPlan: { mode: 'copy', codec: 'eac3' } });
    expect(after(args, '-c:a')).toBe('aac');
    expect(after(args, '-ac')).toBe('2');
  });
});

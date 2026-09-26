import {
  displaySize,
  FfprobeService,
  parseFirstFrameSeconds,
  selectProgrammeVideoStreams,
  streamRotation,
} from './ffprobe.service';

describe('FfprobeService.parseFrameRate', () => {
  const svc = new FfprobeService();
  const parse = (r?: string, avg?: string): string | undefined =>
    (svc as unknown as {
      parseFrameRate(r?: string, avg?: string): string | undefined;
    }).parseFrameRate(r, avg);

  it('normalises a rational to a trimmed decimal', () => {
    expect(parse('24000/1001')).toBe('23.976');
    expect(parse('25/1')).toBe('25');
    expect(parse('30000/1001')).toBe('29.97');
  });

  it('falls back to avg_frame_rate when r_frame_rate is unusable', () => {
    // VFR / some remuxed sources report r_frame_rate 0/0 — without the fallback
    // frameRate is dropped and the segment grid collapses to the integer rate,
    // drifting audio off the video IDR cadence on a fractional-fps source.
    expect(parse('0/0', '24000/1001')).toBe('23.976');
    expect(parse(undefined, '25/1')).toBe('25');
  });

  it('returns undefined only when neither rate is usable', () => {
    expect(parse('0/0', '0/0')).toBeUndefined();
    expect(parse(undefined, undefined)).toBeUndefined();
  });

  it('passes a non-rational string through unchanged', () => {
    expect(parse('23.976')).toBe('23.976');
  });
});

/**
 * A container's frame rate is a header field, not an observation. A remuxer
 * that writes Matroska's `DefaultDuration` in whole milliseconds turns
 * 1/23.976 (41.708 ms) into 42 ms — 500/21 = 23.81 — and reports it as BOTH
 * `r_frame_rate` and `avg_frame_rate`, so no choice between those two fields
 * can catch it.
 *
 * The segment grid counts frames (`buildSegmentGrid`), so a rate 0.7% off puts
 * 95 frames labelled 3.99s but really lasting 3.962s seconds away from the grid
 * the player is told to expect — dragging the picture off subtitles authored in
 * source time while audio, riding the same anchor, stays in sync.
 */
describe('FfprobeService.reconcileFrameRate', () => {
  const svc = new FfprobeService();
  const reconcile = (declared?: string, measured?: number): string | undefined =>
    (
      svc as unknown as {
        reconcileFrameRate(
          d: string | undefined,
          m: number | undefined,
          label: string,
        ): string | undefined;
      }
    ).reconcileFrameRate(declared, measured, 'file.mkv');

  it('takes the packets over a header that disagrees', () => {
    // The real case: declared 500/21, packets run at 24000/1001.
    expect(reconcile('23.81', 24000 / 1001)).toBe('23.976');
  });

  it('keeps the declared rate when the two agree', () => {
    // Measured rates wobble by a few thousandths on any real file; that is
    // rounding, not a lie, and rewriting the grid for it would be churn.
    expect(reconcile('23.976', 23.9749)).toBe('23.976');
    expect(reconcile('25', 24.998)).toBe('25');
  });

  it('keeps the declared rate when nothing could be measured', () => {
    expect(reconcile('23.976', undefined)).toBe('23.976');
  });

  it('has nothing to reconcile without a declared rate', () => {
    expect(reconcile(undefined, 24000 / 1001)).toBeUndefined();
  });

  it('ignores a declared rate that is not a number', () => {
    expect(reconcile('0', 24)).toBe('0');
    expect(reconcile('abc', 24)).toBe('abc');
  });
});

describe('selectProgrammeVideoStreams', () => {
  const v = (index: number, codec: string, attached = 0) => ({
    index,
    codec_type: 'video',
    codec_name: codec,
    disposition: { attached_pic: attached },
  });

  it('drops cover art listed before the programme', () => {
    const picked = selectProgrammeVideoStreams([
      v(0, 'mjpeg', 1),
      v(1, 'h264'),
      { index: 2, codec_type: 'audio', codec_name: 'aac' },
    ]);
    expect(picked.map((s) => s.index)).toEqual([1]);
  });

  it('drops a still-image thumbnail track beside a moving one', () => {
    const picked = selectProgrammeVideoStreams([v(0, 'mjpeg'), v(1, 'hevc'), v(2, 'png')]);
    expect(picked.map((s) => s.index)).toEqual([1]);
  });

  it('keeps motion JPEG when it is the only video', () => {
    expect(selectProgrammeVideoStreams([v(0, 'mjpeg')]).map((s) => s.index)).toEqual([0]);
  });

  it('has no programme when the only picture is a cover', () => {
    expect(selectProgrammeVideoStreams([v(0, 'png', 1)])).toEqual([]);
  });
});

describe('rotation', () => {
  it('reads the display matrix, else the legacy tag', () => {
    expect(
      streamRotation({
        index: 0,
        side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
      }),
    ).toBe(-90);
    expect(streamRotation({ index: 0, tags: { rotate: '270' } })).toBe(270);
    expect(streamRotation({ index: 0 })).toBe(0);
  });

  it('swaps the axes on a quarter turn only', () => {
    expect(displaySize(1920, 1080, 90)).toEqual({ width: 1080, height: 1920 });
    expect(displaySize(1920, 1080, -270)).toEqual({ width: 1080, height: 1920 });
    expect(displaySize(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('parseFirstFrameSeconds', () => {
  it('reads the integer pts against the filter time base', () => {
    const log = [
      '[Parsed_showinfo_0 @ 0x1] config in time_base: 1/90000, frame_rate: 25/1',
      '[Parsed_showinfo_0 @ 0x1] n:   0 pts:8550003600 pts_time:95000 duration:3600',
      '[Parsed_showinfo_0 @ 0x1] n:   1 pts:8550007200 pts_time:95000.1 duration:3600',
    ].join('\n');
    expect(parseFirstFrameSeconds(log)).toBe(95000.04);
  });

  it('keeps a negative first frame', () => {
    const log = 'config in time_base: 1/1000, frame_rate: 25/1\nn:   0 pts:    -40 pts_time:-0.04';
    expect(parseFirstFrameSeconds(log)).toBe(-0.04);
  });

  it('is undefined when nothing decoded', () => {
    expect(parseFirstFrameSeconds('config in time_base: 1/90000')).toBeUndefined();
  });
});

import {
  displaySize,
  FfprobeService,
  audioStreamRoles,
  firstFrameOf,
  ticksToSeconds,
  selectProgrammeVideoStreams,
  streamEndSeconds,
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
  it('reads the display matrix, else the rotate tag', () => {
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

describe('firstFrameOf', () => {
  const head = '{\n    "frames": [\n        { "pts": 8550003600,\n            "side_data_list": [\n                { "side_data_type": "x{y}" }\n';

  it('waits for the first frame to be written whole', () => {
    expect(firstFrameOf(head)).toBeUndefined();
    expect(firstFrameOf('{\n')).toBeUndefined();
  });

  it('reads the first frame with its side data', () => {
    const frame = firstFrameOf(head + '            ] },\n        { "pts": 8550007200');
    expect(frame).toEqual({ pts: 8550003600, side_data_list: [{ side_data_type: 'x{y}' }] });
  });
});

describe('ticksToSeconds', () => {
  it('reads integer ticks against the stream time base, negatives included', () => {
    expect(ticksToSeconds(8550003600, '1/90000')).toBe(95000.04);
    expect(ticksToSeconds(-40, '1/1000')).toBe(-0.04);
    expect(ticksToSeconds(undefined, '1/1000')).toBeUndefined();
    expect(ticksToSeconds(40, undefined)).toBeUndefined();
  });
});

describe('streamEndSeconds', () => {
  it('reads the Matroska DURATION tag as the end timestamp', () => {
    expect(
      streamEndSeconds({
        index: 2,
        start_time: '2.000000',
        tags: { DURATION: '00:00:22.021000000' },
      }),
    ).toBeCloseTo(22.021, 6);
    expect(
      streamEndSeconds({ index: 1, tags: { DURATION: '01:02:03.5' } }),
    ).toBe(3723.5);
  });

  it('adds a stream duration to its start elsewhere', () => {
    expect(
      streamEndSeconds({ index: 1, start_time: '1.4', duration: '31.446667' }),
    ).toBeCloseTo(32.846667, 6);
  });

  it('is undefined when the container declares no end', () => {
    expect(streamEndSeconds({ index: 1, duration: 'N/A' })).toBeUndefined();
    expect(streamEndSeconds({ index: 1 })).toBeUndefined();
  });
});

describe('audioStreamRoles', () => {
  it('maps the commentary and accessibility dispositions', () => {
    expect(audioStreamRoles({ index: 1, disposition: { comment: 1 } })).toEqual(
      { commentary: true },
    );
    expect(
      audioStreamRoles({ index: 1, disposition: { descriptions: 1 } }),
    ).toEqual({ audioDescription: true });
    expect(
      audioStreamRoles({
        index: 1,
        disposition: { visual_impaired: 1, hearing_impaired: 1 },
      }),
    ).toEqual({ audioDescription: true });
    expect(audioStreamRoles({ index: 1 })).toEqual({});
  });
});

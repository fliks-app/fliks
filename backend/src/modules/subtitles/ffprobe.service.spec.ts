import { FfprobeService } from './ffprobe.service';

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

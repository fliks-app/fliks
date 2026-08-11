import {
  countStalledStrikes,
  isNoProgress,
  STALL_PROGRESS_TOLERANCE_BYTES,
} from './stalled-progress.util';

const TOLERANCE = Number(STALL_PROGRESS_TOLERANCE_BYTES);

const samples = (...bytesNewestFirst: number[]) =>
  bytesNewestFirst.map((b) => ({ downloadedBytes: String(b) }));

describe('isNoProgress', () => {
  it('treats equal byte counts as no progress', () => {
    expect(isNoProgress('1000', '1000')).toBe(true);
  });

  it('treats a sub-tolerance trickle as no progress', () => {
    expect(isNoProgress('1000', String(1000 + TOLERANCE - 1))).toBe(true);
  });

  it('treats exactly one tolerance worth of bytes as progress', () => {
    expect(isNoProgress('1000', String(1000 + TOLERANCE))).toBe(false);
  });

  it('treats a counter reset (negative delta) as progress', () => {
    expect(isNoProgress(String(5 * TOLERANCE), '0')).toBe(false);
  });

  it('handles byte counts beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 2n ** 60n;
    expect(isNoProgress(String(big), String(big + 5n))).toBe(true);
    expect(
      isNoProgress(String(big), String(big + STALL_PROGRESS_TOLERANCE_BYTES)),
    ).toBe(false);
  });
});

describe('countStalledStrikes', () => {
  it('returns 0 with no snapshots', () => {
    expect(countStalledStrikes([])).toBe(0);
  });

  it('counts a lone snapshot as 1 strike', () => {
    expect(countStalledStrikes(samples(1000))).toBe(1);
  });

  it('counts N flat snapshots as N strikes', () => {
    expect(countStalledStrikes(samples(1000, 1000, 1000, 1000))).toBe(4);
  });

  it('stops the run at the first progressing step', () => {
    // Newest-first: flat, flat, then a 2 MiB jump older in the series.
    expect(
      countStalledStrikes(samples(5 * TOLERANCE, 5 * TOLERANCE, 5 * TOLERANCE, 3 * TOLERANCE)),
    ).toBe(3);
  });

  it('returns 1 when the newest step shows progress', () => {
    expect(countStalledStrikes(samples(5 * TOLERANCE, 3 * TOLERANCE, 3 * TOLERANCE))).toBe(1);
  });

  it('breaks the run on a counter reset', () => {
    // Newest-first: 0 after a recheck reset from 5 MiB.
    expect(countStalledStrikes(samples(0, 5 * TOLERANCE, 5 * TOLERANCE))).toBe(1);
  });

  it('tolerates a trickle inside the run', () => {
    expect(
      countStalledStrikes(samples(1000 + 2 * (TOLERANCE - 1), 1000 + (TOLERANCE - 1), 1000)),
    ).toBe(3);
  });
});

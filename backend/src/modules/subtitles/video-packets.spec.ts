import { VideoPacketReader } from './video-packets';

type Packet = [pts: number, dts: number, dur: number, key?: boolean];
const read = (packets: Packet[], lead = 0, detectBreak = true) => {
  const r = new VideoPacketReader(lead, detectBreak);
  for (const [pts, dts, dur, key] of packets) if (!r.add(pts, dts, dur, !!key)) break;
  return r.result();
};

describe('VideoPacketReader', () => {
  it('keeps key packets and derives the decode times Matroska leaves unknown as ffmpeg does', () => {
    // Two frames reordered at 25 fps: ffmpeg starts the unknown ones 80 ms under.
    const { keyframes, end } = read(
      [
        [0, NaN, 0.04, true],
        [0.12, NaN, 0.04],
        [0.04, 0, 0.04],
        [2, 1.92, 0.04, true],
        [1.96, 1.96, 0.04],
      ],
      0.08,
    );
    expect(keyframes).toEqual([
      { pts: 0, dts: -0.08 },
      { pts: 2, dts: 1.92 },
    ]);
    expect(end).toBeCloseTo(2.04, 6);
  });

  it('stops at a restarted clock, forward or backward', () => {
    const before: Packet[] = [
      [32.68, 32.6, 0.04, true],
      [32.72, 32.68, 0.04],
      [32.76, 32.72, 0.04],
    ];
    for (const jump of [1000, 3]) {
      const { keyframes, end, breakSeconds } = read([...before, [jump, jump - 0.08, 0.04, true]]);
      expect(keyframes.map((k) => k.pts)).toEqual([32.68]);
      expect(end).toBeCloseTo(32.8, 6);
      expect(breakSeconds).toBeCloseTo(32.8, 6);
    }
  });

  it('plays through a reception dropout, whose clock kept running', () => {
    const { keyframes, breakSeconds } = read([
      [41.2, 41.12, 0.04, true],
      [56.4, 56.32, 0.04, true],
    ]);
    expect(breakSeconds).toBeUndefined();
    expect(keyframes.map((k) => k.pts)).toEqual([41.2, 56.4]);
  });

  it('looks for no break outside MPEG-TS', () => {
    expect(read([[2.8, 2.72, 0.04, true], [1000, 999.9, 0.04, true]], 0, false).breakSeconds).toBeUndefined();
  });

  it('keeps pre-roll keyframes flagged discard', () => {
    const { keyframes } = read([
      [-1.52, -1.6, 0.04, true],
      [0.48, 0.4, 0.04, true],
    ]);
    expect(keyframes.map((k) => k.pts)).toEqual([-1.52, 0.48]);
  });
});

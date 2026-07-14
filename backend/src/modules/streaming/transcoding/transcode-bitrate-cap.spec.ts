import {
  cappedTranscodeVideoBitrateBps,
  resolveSourceVideoBitrateBps,
} from './profiles';

describe('resolveSourceVideoBitrateBps', () => {
  it('uses the probed per-stream bitrate when present', () => {
    expect(resolveSourceVideoBitrateBps(5_000_000, 6_000_000, 200_000)).toBe(
      5_000_000,
    );
  });

  it('estimates from container minus audio when the stream omits it (MKV)', () => {
    // 2.9 Mbps container - 768 kbps audio = ~2.13 Mbps video.
    expect(resolveSourceVideoBitrateBps(null, 2_900_000, 768_000)).toBe(
      2_132_000,
    );
  });

  it('falls back to the container bitrate when audio bitrate is also absent', () => {
    // MKV with no per-stream video *or* audio bitrate: the container total is
    // the video estimate, so the cap tracks the source instead of the rung.
    expect(resolveSourceVideoBitrateBps(null, 12_500_000, 0)).toBe(12_500_000);
  });

  it('returns undefined when neither source is usable', () => {
    expect(resolveSourceVideoBitrateBps(null, null, 0)).toBeUndefined();
    expect(resolveSourceVideoBitrateBps(0, 0, 0)).toBeUndefined();
    // Estimate at/under the 10 kbps floor is treated as unknown.
    expect(resolveSourceVideoBitrateBps(null, 205_000, 200_000)).toBeUndefined();
  });
});

describe('cappedTranscodeVideoBitrateBps', () => {
  const RUNG_1080P = 8_000_000;

  it('never inflates above the source for a same-codec transcode', () => {
    // HEVC 2.1 Mbps source, HEVC 1080p rung (8M) → capped to the source.
    expect(
      cappedTranscodeVideoBitrateBps(RUNG_1080P, 2_100_000, 'hevc', 'hevc'),
    ).toBe(2_100_000);
  });

  it('allows codec headroom for a less-efficient target', () => {
    // HEVC source → H.264 target needs ~1.67x the bits to hold quality.
    expect(
      cappedTranscodeVideoBitrateBps(RUNG_1080P, 2_100_000, 'hevc', 'h264'),
    ).toBe(Math.round(2_100_000 * (1 / 0.6)));
  });

  it('never raises the cap below the source for a more-efficient target', () => {
    // H.264 source → HEVC target: headroom clamped to 1, so the cap is the
    // source bitrate (the rung still wins when lower).
    expect(
      cappedTranscodeVideoBitrateBps(RUNG_1080P, 5_000_000, 'h264', 'hevc'),
    ).toBe(5_000_000);
  });

  it('keeps the rung when it is already below the cap', () => {
    expect(
      cappedTranscodeVideoBitrateBps(200_000, 5_000_000, 'hevc', 'hevc'),
    ).toBe(200_000);
  });

  it('leaves the rung unchanged when the source bitrate is unknown', () => {
    expect(
      cappedTranscodeVideoBitrateBps(RUNG_1080P, undefined, 'hevc', 'hevc'),
    ).toBe(RUNG_1080P);
    expect(cappedTranscodeVideoBitrateBps(RUNG_1080P, 0, 'hevc', 'hevc')).toBe(
      RUNG_1080P,
    );
  });

  it('treats unknown codecs as the H.264 baseline (factor 1)', () => {
    expect(
      cappedTranscodeVideoBitrateBps(RUNG_1080P, 3_000_000, 'xyz', 'xyz'),
    ).toBe(3_000_000);
  });
});

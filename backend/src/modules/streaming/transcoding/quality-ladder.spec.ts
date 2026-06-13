import { cappedRungVideoBitrateBps, type RungBitrateContext } from './quality-ladder';
import type { TranscodeProfile } from './types';

const rung = (videoBitrate: string): TranscodeProfile => ({
  name: '2160p',
  maxWidth: 3840,
  maxHeight: 2160,
  videoBitrate,
  audioBitrate: '192k',
});

const ctx = (over: Partial<RungBitrateContext> = {}): RungBitrateContext => ({
  outputCodec: 'hevc',
  sourceWidth: 3840,
  sourceHeight: 2160,
  sourceFrameRate: 24,
  sourceVideoBitrateBps: undefined,
  sourceVideoCodec: 'hevc',
  ...over,
});

describe('cappedRungVideoBitrateBps', () => {
  it('clamps a HEVC 4K@24 rung to the L5.0 Main-tier ceiling (#474)', () => {
    expect(cappedRungVideoBitrateBps(rung('28M'), ctx())).toBe(25_000_000);
  });

  it('leaves AV1 and H.264 unclamped (no Main-tier gate at this ladder)', () => {
    expect(cappedRungVideoBitrateBps(rung('28M'), ctx({ outputCodec: 'av1' }))).toBe(
      28_000_000,
    );
    expect(
      cappedRungVideoBitrateBps(rung('28M'), ctx({ outputCodec: 'h264' })),
    ).toBe(28_000_000);
  });

  it('does not clamp HEVC 4K@60 (L5.1 ceiling is 40 Mbps)', () => {
    expect(
      cappedRungVideoBitrateBps(rung('28M'), ctx({ sourceFrameRate: 60 })),
    ).toBe(28_000_000);
  });

  it('caps to the source bitrate before the tier clamp', () => {
    // HEVC source 10M → capped to 10M (below the 25M L5.0 ceiling).
    expect(
      cappedRungVideoBitrateBps(
        rung('28M'),
        ctx({ sourceVideoBitrateBps: 10_000_000 }),
      ),
    ).toBe(10_000_000);
  });

  it('keeps a rung already below both caps', () => {
    expect(cappedRungVideoBitrateBps(rung('5500k'), ctx())).toBe(5_500_000);
  });
});

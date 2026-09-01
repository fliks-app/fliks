import {
  audioCodecString,
  audioRenditionChannels,
  copySourceCodecString,
  h264CodecString,
  hevcMain10CodecString,
  hevcMainTierCapBps,
} from './codec-strings';
import type { EncoderTarget } from './types';

const target = (
  width: number,
  height: number,
  frameRate: number,
): EncoderTarget => ({
  width,
  height,
  frameRate,
  videoBitrateBps: 0,
  gopSize: 0,
});

describe('audioCodecString', () => {
  it('maps the fMP4-compatible codecs to their RFC 6381 strings', () => {
    expect(audioCodecString('aac')).toBe('mp4a.40.2');
    expect(audioCodecString('ac3')).toBe('ac-3');
    expect(audioCodecString('eac3')).toBe('ec-3');
    expect(audioCodecString('opus')).toBe('Opus');
    expect(audioCodecString('flac')).toBe('fLaC');
  });

  it('is case-insensitive', () => {
    expect(audioCodecString('OPUS')).toBe('Opus');
    expect(audioCodecString('FLAC')).toBe('fLaC');
  });

  it('returns null for an unknown codec so the caller omits it (never mislabels as AAC)', () => {
    expect(audioCodecString('truehd')).toBeNull();
    expect(audioCodecString('dts')).toBeNull();
    expect(audioCodecString('')).toBeNull();
  });
});

describe('audioRenditionChannels', () => {
  it('downmixes AAC output to stereo regardless of the source layout', () => {
    expect(audioRenditionChannels('aac', 6)).toBe(2);
    expect(audioRenditionChannels('aac', 1)).toBe(2);
    expect(audioRenditionChannels('AAC', undefined)).toBe(2);
  });

  it('keeps the source channel count for copy / AC-3 / E-AC-3 (no -ac)', () => {
    expect(audioRenditionChannels('eac3', 6)).toBe(6);
    expect(audioRenditionChannels('ac3', 6)).toBe(6);
    expect(audioRenditionChannels('opus', 8)).toBe(8);
    expect(audioRenditionChannels('flac', 2)).toBe(2);
  });

  it('falls back to 2 when the source channel count is unknown or invalid', () => {
    expect(audioRenditionChannels('eac3', undefined)).toBe(2);
    expect(audioRenditionChannels('eac3', 0)).toBe(2);
  });
});

describe('hevcMainTierCapBps', () => {
  // Cap maps to the level the existing luma-rate buckets pick (the buckets are
  // ~half the HEVC Annex A MaxLumaSr — preserved verbatim from hevcLevel).
  it('returns the Main-tier MaxBR for the level the luma rate selects', () => {
    // 720p24 = 22.1M → L3.1 (cap 10 Mbps)
    expect(hevcMainTierCapBps(target(1280, 720, 24))).toBe(10_000_000);
    // 1080p24 = 49.8M → L4.0 (cap 12 Mbps)
    expect(hevcMainTierCapBps(target(1920, 1080, 24))).toBe(12_000_000);
    // cropped 4K @24 = 150.4M → L5.0 (cap 25 Mbps) — the #474 repro case
    expect(hevcMainTierCapBps(target(3840, 1632, 24))).toBe(25_000_000);
    // full 4K @24 = 199.1M → L5.0 (cap 25 Mbps)
    expect(hevcMainTierCapBps(target(3840, 2160, 24))).toBe(25_000_000);
    // 4K @60 = 497.7M → L5.1 (cap 40 Mbps): the same 28 Mbps rung stays Main
    expect(hevcMainTierCapBps(target(3840, 2160, 60))).toBe(40_000_000);
  });

  it('caps the #474 cropped-4K-HDR rung (28 Mbps @24fps) to the L5.0 ceiling', () => {
    const cap = hevcMainTierCapBps(target(3840, 1632, 24));
    expect(Math.min(28_000_000, cap)).toBe(25_000_000);
  });
});

describe('hevcMain10CodecString', () => {
  it('declares the Main-tier level (L) — the encode is clamped to keep it Main', () => {
    // Regression lock: the cropped-4K @24fps case stays hvc1.2.4.L150.B0
    // (Main tier). hevcMainTierCapBps keeps the encode within L5.0's 25 Mbps
    // Main ceiling so the declared level matches the bitstream tier.
    expect(hevcMain10CodecString(target(3840, 1632, 24))).toBe('hvc1.2.4.L150.B0');
    expect(hevcMain10CodecString(target(3840, 2160, 24))).toBe('hvc1.2.4.L150.B0');
    expect(hevcMain10CodecString(target(1920, 1080, 24))).toBe('hvc1.2.4.L120.B0');
  });
});

describe('copySourceCodecString — copied streams describe the bitstream', () => {
  it('uses the probed H.264 level, not the one the rung arithmetic would pick', () => {
    // 1920x800 High L4.1: h264CodecString() resolves L4.0 (28) from macroblock
    // rate, which under-declares this source and trips Safari / Cast.
    expect(
      copySourceCodecString({ codec: 'h264', profile: 'High', level: 41 }),
    ).toBe('avc1.640029');
    expect(h264CodecString({ width: 1920, height: 800, frameRate: 23.976 } as any))
      .toBe('avc1.640028');
  });

  it('maps the H.264 profiles ffprobe reports', () => {
    expect(copySourceCodecString({ codec: 'h264', profile: 'Main', level: 30 }))
      .toBe('avc1.4d001e');
    expect(
      copySourceCodecString({ codec: 'h264', profile: 'Constrained Baseline', level: 31 }),
    ).toBe('avc1.42001f');
    expect(copySourceCodecString({ codec: 'h264', profile: 'High 10', level: 50 }))
      .toBe('avc1.6e0032');
  });

  it('builds HEVC Main and Main 10 from the pre-multiplied level', () => {
    expect(copySourceCodecString({ codec: 'hevc', profile: 'Main', level: 120 }))
      .toBe('hvc1.1.6.L120.B0');
    expect(copySourceCodecString({ codec: 'hevc', profile: 'Main 10', level: 153 }))
      .toBe('hvc1.2.4.L153.B0');
  });

  it('returns null rather than guessing, so CODECS is omitted', () => {
    // Unknown profile, a level in the wrong unit, another codec, missing data.
    expect(copySourceCodecString({ codec: 'h264', profile: 'Weird', level: 41 })).toBeNull();
    expect(copySourceCodecString({ codec: 'hevc', profile: 'Main', level: 4 })).toBeNull();
    expect(copySourceCodecString({ codec: 'av1', profile: 'Main', level: 8 })).toBeNull();
    expect(copySourceCodecString({ codec: 'h264', profile: 'High' })).toBeNull();
    expect(copySourceCodecString({})).toBeNull();
  });
});

import { computeProfileHash, type PlaybackProfile } from './profile-hash';

const BASE: PlaybackProfile = {
  videoCodec: 'h264',
  videoBitDepth: 8,
  hdr: null,
  audioCodec: 'aac',
  audioChannels: 2,
  audioMode: 'transcode',
  muxFlavour: 'fmp4',
  audioLayout: 'inline',
  segmentDurationMs: 3000,
  tvPlatform: 'browser',
};

describe('computeProfileHash', () => {
  it('returns a 10-char hex string', () => {
    const hash = computeProfileHash(BASE);
    expect(hash).toMatch(/^[0-9a-f]{10}$/);
  });

  it('is deterministic for the same input', () => {
    expect(computeProfileHash(BASE)).toBe(computeProfileHash({ ...BASE }));
  });

  it('changes when any single field changes', () => {
    const baseline = computeProfileHash(BASE);
    const variations: Array<Partial<PlaybackProfile>> = [
      { videoCodec: 'hevc' },
      { videoBitDepth: 10 },
      { hdr: 'HDR10' },
      { audioCodec: 'eac3' },
      { audioChannels: 6 },
      { audioMode: 'copy' },
      { muxFlavour: 'ts' },
      { audioLayout: 'var-stream-map' },
      { segmentDurationMs: 6000 },
      { tvPlatform: 'tizen' },
    ];
    for (const v of variations) {
      expect(computeProfileHash({ ...BASE, ...v })).not.toBe(baseline);
    }
  });

  it('separates HDR variants from SDR even when codec is identical', () => {
    const sdr = computeProfileHash({
      ...BASE,
      videoCodec: 'hevc',
      videoBitDepth: 10,
    });
    const hdr10 = computeProfileHash({
      ...BASE,
      videoCodec: 'hevc',
      videoBitDepth: 10,
      hdr: 'HDR10',
    });
    const hlg = computeProfileHash({
      ...BASE,
      videoCodec: 'hevc',
      videoBitDepth: 10,
      hdr: 'HLG',
    });
    expect(new Set([sdr, hdr10, hlg]).size).toBe(3);
  });

  it('separates tvPlatform classes even with otherwise-equal profiles', () => {
    const platforms: PlaybackProfile['tvPlatform'][] = [
      'browser',
      'androidtv',
      'tizen',
      'webos',
      'ios',
      'android',
      'cast',
    ];
    const hashes = platforms.map((tv) =>
      computeProfileHash({ ...BASE, tvPlatform: tv }),
    );
    expect(new Set(hashes).size).toBe(platforms.length);
  });
});

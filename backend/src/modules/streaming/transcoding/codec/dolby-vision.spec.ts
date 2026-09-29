import {
  deriveDvInfo,
  dvAppliesRpu,
  dvHasHlgBase,
  dvSupplementalCodecs,
  dvStandaloneCodecs,
} from './dolby-vision';

describe('deriveDvInfo', () => {
  it('classifies P5 as single-layer', () => {
    const info = deriveDvInfo({ dvProfile: 5, dvBlSignalCompatId: 0 });
    expect(info.singleLayer).toBe(true);
  });

  it('classifies P8.1 (HDR10 base) as single-layer', () => {
    const info = deriveDvInfo({ dvProfile: 8, dvBlSignalCompatId: 1 });
    expect(info.singleLayer).toBe(true);
  });

  it('classifies P8.4 (HLG base) as single-layer', () => {
    const info = deriveDvInfo({ dvProfile: 8, dvBlSignalCompatId: 4 });
    expect(info.singleLayer).toBe(true);
  });

  it('treats a dual-layer profile (enhancement layer present) as not single-layer', () => {
    const info = deriveDvInfo({
      dvProfile: 7,
      dvBlSignalCompatId: 6,
      dvElPresent: true,
    });
    expect(info.singleLayer).toBe(false);
  });

  it('treats a P8 that declares an enhancement layer as not single-layer', () => {
    const info = deriveDvInfo({
      dvProfile: 8,
      dvBlSignalCompatId: 1,
      dvElPresent: true,
    });
    expect(info.singleLayer).toBe(false);
  });

  it('returns no DV classification for a non-DV stream', () => {
    const info = deriveDvInfo({});
    expect(info.profile).toBeUndefined();
    expect(info.singleLayer).toBe(false);
  });
});

describe('dvSupplementalCodecs', () => {
  // Real sources always come limited-range BT.2020nc 4:2:0 10-bit; only the
  // "fails the muxer gate" rows below diverge, to prove each check is enforced.
  const muxerOk = { colorRange: 'tv', colorSpace: 'bt2020nc', pixelFormat: 'yuv420p10le' };
  it.each([
    ['P8.1 (PQ base) with a level', { dvProfile: 8, dvBlSignalCompatId: 1, dvLevel: 6, hdrFormat: 'HDR10', ...muxerOk }, 'dvh1.08.06/db1p'],
    ['P8.4 (HLG base) with a level', { dvProfile: 8, dvBlSignalCompatId: 4, dvLevel: 6, hdrFormat: 'HLG', ...muxerOk }, 'dvh1.08.06/db4h'],
    ['P8.4 with a two-digit level', { dvProfile: 8, dvBlSignalCompatId: 4, dvLevel: 13, hdrFormat: 'HLG', ...muxerOk }, 'dvh1.08.13/db4h'],
    ['P10.1 (PQ base, AV1)', { dvProfile: 10, dvBlSignalCompatId: 1, dvLevel: 8, hdrFormat: 'HDR10', ...muxerOk }, 'dav1.10.08/db1p'],
    ['P10.4 (HLG base, AV1)', { dvProfile: 10, dvBlSignalCompatId: 4, dvLevel: 8, hdrFormat: 'HLG', ...muxerOk }, 'dav1.10.08/db4h'],
    ['P10.0 (no compatible base)', { dvProfile: 10, dvBlSignalCompatId: 0, dvLevel: 8, hdrFormat: 'HDR10', ...muxerOk }, null],
    ['P5 (no HDR10 base)', { dvProfile: 5, dvBlSignalCompatId: 0, dvLevel: 6, hdrFormat: 'HDR10', ...muxerOk }, null],
    ['P8.2 (SDR-compatible compat)', { dvProfile: 8, dvBlSignalCompatId: 2, dvLevel: 6, ...muxerOk }, null],
    ['compat/transfer mismatch (compat 1 tagged HLG)', { dvProfile: 8, dvBlSignalCompatId: 1, dvLevel: 6, hdrFormat: 'HLG', ...muxerOk }, null],
    ['P8.1 with no level probed', { dvProfile: 8, dvBlSignalCompatId: 1, hdrFormat: 'HDR10', ...muxerOk }, null],
    ['full-range P8.1 (fails the muxer\'s own dvcC gate)', { dvProfile: 8, dvBlSignalCompatId: 1, dvLevel: 6, hdrFormat: 'HDR10', ...muxerOk, colorRange: 'pc' }, null],
    ['4:2:2 P8.1 (wrong chroma, fails the exact pixel-format check)', { dvProfile: 8, dvBlSignalCompatId: 1, dvLevel: 6, hdrFormat: 'HDR10', ...muxerOk, pixelFormat: 'yuv422p10le' }, null],
  ])('%s', (_label, input, expected) => {
    expect(dvSupplementalCodecs(input)).toBe(expected);
  });
});

describe('dvStandaloneCodecs', () => {
  it('builds dvh1.05.LL for a Profile 5 remux', () => {
    expect(dvStandaloneCodecs({ dvProfile: 5, dvBlSignalCompatId: 0, dvLevel: 6 })).toBe('dvh1.05.06');
  });

  it('builds dav1.10.LL for a P10.0 remux (no compatible base)', () => {
    expect(dvStandaloneCodecs({ dvProfile: 10, dvBlSignalCompatId: 0, dvLevel: 8 })).toBe('dav1.10.08');
    expect(dvStandaloneCodecs({ dvProfile: 10, dvLevel: 8 })).toBe('dav1.10.08');
  });

  it('returns null without a probed level, for P8, or for a P10 with a compatible base', () => {
    expect(dvStandaloneCodecs({ dvProfile: 5, dvBlSignalCompatId: 0 })).toBeNull();
    expect(dvStandaloneCodecs({ dvProfile: 8, dvBlSignalCompatId: 1, dvLevel: 6 })).toBeNull();
    expect(dvStandaloneCodecs({ dvProfile: 10, dvBlSignalCompatId: 1, dvLevel: 8 })).toBeNull();
  });
});

describe('dvHasHlgBase', () => {
  it('is true for P8.4 and P10.4', () => {
    expect(dvHasHlgBase(8, 4)).toBe(true);
    expect(dvHasHlgBase(10, 4)).toBe(true);
  });

  it('is false for P8.1 and P5', () => {
    expect(dvHasHlgBase(8, 1)).toBe(false);
    expect(dvHasHlgBase(5, 0)).toBe(false);
  });
});

describe('dvAppliesRpu', () => {
  it('is true for no-base (P5) and HLG-base (P8.4) sources', () => {
    expect(dvAppliesRpu(5, 0)).toBe(true);
    expect(dvAppliesRpu(8, 4)).toBe(true);
  });

  it('is false for a PQ base (P8.1)', () => {
    expect(dvAppliesRpu(8, 1)).toBe(false);
  });
});

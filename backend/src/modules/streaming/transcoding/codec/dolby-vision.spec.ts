import { deriveDvInfo, isDvProfile5, dvSupplementalCodecs } from './dolby-vision';

describe('deriveDvInfo', () => {
  it('classifies P5 as single-layer', () => {
    const info = deriveDvInfo({ dvProfile: 5, dvBlSignalCompatId: 0 });
    expect(info.singleLayer).toBe(true);
    expect(isDvProfile5(info)).toBe(true);
  });

  it('classifies P8.1 (HDR10 base) as single-layer', () => {
    const info = deriveDvInfo({ dvProfile: 8, dvBlSignalCompatId: 1 });
    expect(info.singleLayer).toBe(true);
    expect(isDvProfile5(info)).toBe(false);
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
    expect(isDvProfile5(info)).toBe(false);
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
    expect(isDvProfile5(info)).toBe(false);
  });
});

describe('dvSupplementalCodecs', () => {
  it.each([
    ['P8.1 (PQ base) with a level', { dvProfile: 8, dvBlSignalCompatId: 1, dvLevel: 6, hdrFormat: 'HDR10' }, 'dvh1.08.06/db1p'],
    ['P8.4 (HLG base) with a level', { dvProfile: 8, dvBlSignalCompatId: 4, dvLevel: 6, hdrFormat: 'HLG' }, 'dvh1.08.06/db4h'],
    ['P8.4 with a two-digit level', { dvProfile: 8, dvBlSignalCompatId: 4, dvLevel: 13, hdrFormat: 'HLG' }, 'dvh1.08.13/db4h'],
    ['P5 (no HDR10 base)', { dvProfile: 5, dvBlSignalCompatId: 0, dvLevel: 6, hdrFormat: 'HDR10' }, null],
    ['P8.2 (SDR-compatible compat)', { dvProfile: 8, dvBlSignalCompatId: 2, dvLevel: 6 }, null],
    ['compat/transfer mismatch (compat 1 tagged HLG)', { dvProfile: 8, dvBlSignalCompatId: 1, dvLevel: 6, hdrFormat: 'HLG' }, null],
    ['P8.1 with no level probed', { dvProfile: 8, dvBlSignalCompatId: 1, hdrFormat: 'HDR10' }, null],
  ])('%s', (_label, input, expected) => {
    expect(dvSupplementalCodecs(input)).toBe(expected);
  });
});

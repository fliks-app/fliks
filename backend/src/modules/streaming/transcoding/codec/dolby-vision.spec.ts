import { deriveDvInfo, isDvProfile5 } from './dolby-vision';

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

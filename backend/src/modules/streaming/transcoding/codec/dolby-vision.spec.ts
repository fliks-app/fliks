import { deriveDvInfo, isDvProfile5 } from './dolby-vision';

describe('deriveDvInfo', () => {
  it('classifies P5 as single-layer', () => {
    const info = deriveDvInfo({ dvProfile: 5, dvBlSignalCompatId: 0 });
    expect(info.singleLayer).toBe(true);
    expect(isDvProfile5(info)).toBe(true);
    expect(info.supplementalTag).toBeNull();
  });

  it('classifies P8.1 as single-layer with the db1p brand', () => {
    const info = deriveDvInfo({ dvProfile: 8, dvBlSignalCompatId: 1 });
    expect(info.singleLayer).toBe(true);
    expect(isDvProfile5(info)).toBe(false);
    expect(info.supplementalTag).toBe('db1p');
  });

  it('classifies P8.4 with the db4h brand', () => {
    const info = deriveDvInfo({ dvProfile: 8, dvBlSignalCompatId: 4 });
    expect(info.singleLayer).toBe(true);
    expect(info.supplementalTag).toBe('db4h');
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
    expect(info.supplementalTag).toBeNull();
  });
});

import {
  VARIANT_EARLY,
  VARIANT_MAIN,
  VARIANT_REMUX,
  baseProfileHash,
  variantHash,
  variantSuffix,
} from './variant';

describe('variantSuffix', () => {
  it('emits the canonical suffix for each kind', () => {
    expect(variantSuffix(VARIANT_MAIN)).toBe('');
    expect(variantSuffix(VARIANT_EARLY)).toBe('-early');
    expect(variantSuffix(VARIANT_REMUX)).toBe('-remux');
    expect(variantSuffix({ kind: 'audio', audioIndex: 0 })).toBe('-a0');
    expect(variantSuffix({ kind: 'audio', audioIndex: 3 })).toBe('-a3');
  });
});

describe('variantHash', () => {
  const base = 'a1b2c3d4e5';
  it('returns the base hash unchanged for main', () => {
    expect(variantHash(base, VARIANT_MAIN)).toBe(base);
  });
  it('appends the variant suffix', () => {
    expect(variantHash(base, VARIANT_EARLY)).toBe(`${base}-early`);
    expect(variantHash(base, VARIANT_REMUX)).toBe(`${base}-remux`);
    expect(variantHash(base, { kind: 'audio', audioIndex: 2 })).toBe(
      `${base}-a2`,
    );
  });
});

describe('baseProfileHash', () => {
  const base = 'deadbeef01';
  it('returns the input unchanged when no suffix is present', () => {
    expect(baseProfileHash(base)).toBe(base);
  });
  it('strips every known variant suffix', () => {
    expect(baseProfileHash(`${base}-early`)).toBe(base);
    expect(baseProfileHash(`${base}-remux`)).toBe(base);
    expect(baseProfileHash(`${base}-a0`)).toBe(base);
    expect(baseProfileHash(`${base}-a12`)).toBe(base);
  });
  it('leaves non-variant trailing dashes alone', () => {
    expect(baseProfileHash(`${base}-foo`)).toBe(`${base}-foo`);
    expect(baseProfileHash(`${base}-aX`)).toBe(`${base}-aX`);
  });
});

describe('round-trip variantHash + baseProfileHash', () => {
  const base = '0123456789';
  it('returns the base for every variant', () => {
    const variants = [
      VARIANT_MAIN,
      VARIANT_EARLY,
      VARIANT_REMUX,
      { kind: 'audio', audioIndex: 0 } as const,
      { kind: 'audio', audioIndex: 7 } as const,
    ];
    for (const v of variants) {
      expect(baseProfileHash(variantHash(base, v))).toBe(base);
    }
  });
});

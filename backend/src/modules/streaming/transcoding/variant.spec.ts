import {
  VARIANT_EARLY,
  VARIANT_MAIN,
  baseProfileHash,
  remuxVariant,
  variantHash,
  variantSuffix,
} from './variant';

describe('variantSuffix', () => {
  it('emits the canonical suffix for each kind', () => {
    expect(variantSuffix(VARIANT_MAIN)).toBe('');
    expect(variantSuffix(VARIANT_EARLY)).toBe('-early');
    expect(variantSuffix(remuxVariant({ audioIndex: undefined, keyframeGrid: true }))).toBe(
      '-remux-a0',
    );
  });

  it('keys the copy variant on the muxed track and the grid it is cut on', () => {
    expect(variantSuffix(remuxVariant({ audioIndex: 2, keyframeGrid: true }))).toBe('-remux-a2');
    expect(variantSuffix(remuxVariant({ audioIndex: 2, keyframeGrid: false }))).toBe('-remux-a2-u');
  });

  it('drops the track index for a multi-audio remux, keeping the grid', () => {
    expect(
      variantSuffix(remuxVariant({ audioIndex: 2, keyframeGrid: true, multiAudio: true })),
    ).toBe('-remux');
    expect(
      variantSuffix(remuxVariant({ audioIndex: 2, keyframeGrid: false, multiAudio: true })),
    ).toBe('-remux-u');
  });
});

describe('variantHash', () => {
  const base = 'a1b2c3d4e5';
  it('returns the base hash unchanged for main', () => {
    expect(variantHash(base, VARIANT_MAIN)).toBe(base);
  });
  it('appends the variant suffix', () => {
    expect(variantHash(base, VARIANT_EARLY)).toBe(`${base}-early`);
    expect(variantHash(base, remuxVariant({ audioIndex: 1, keyframeGrid: true }))).toBe(
      `${base}-remux-a1`,
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
    expect(baseProfileHash(`${base}-remux-a3`)).toBe(base);
    expect(baseProfileHash(`${base}-remux-a3-u`)).toBe(base);
    expect(baseProfileHash(`${base}-remux`)).toBe(base);
    expect(baseProfileHash(`${base}-remux-u`)).toBe(base);
  });
  it('leaves non-variant trailing dashes alone', () => {
    expect(baseProfileHash(`${base}-foo`)).toBe(`${base}-foo`);
    expect(baseProfileHash(`${base}-a0`)).toBe(`${base}-a0`);
  });
});

describe('round-trip variantHash + baseProfileHash', () => {
  const base = '0123456789';
  it('returns the base for every variant', () => {
    const variants = [
      VARIANT_MAIN,
      VARIANT_EARLY,
      remuxVariant({ audioIndex: 0, keyframeGrid: true }),
      remuxVariant({ audioIndex: 4, keyframeGrid: false }),
      remuxVariant({ audioIndex: 0, keyframeGrid: true, multiAudio: true }),
      remuxVariant({ audioIndex: 4, keyframeGrid: false, multiAudio: true }),
    ];
    for (const v of variants) {
      expect(baseProfileHash(variantHash(base, v))).toBe(base);
    }
  });
});

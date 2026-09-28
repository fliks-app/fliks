import {
  masterDisplayString,
  maxCllString,
  svtMasterDisplayString,
} from './hdr-metadata';

const GENERIC_DISPLAY =
  'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)';
const SOURCE = {
  masteringDisplay:
    'G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(40000000,50)',
  maxCll: 4000,
  maxFall: 600,
};

describe('masterDisplayString', () => {
  it('returns the source mastering display when present', () => {
    expect(masterDisplayString(SOURCE)).toBe(SOURCE.masteringDisplay);
  });
  it('falls back to the generic 1000-nit reference when absent', () => {
    expect(masterDisplayString(undefined)).toBe(GENERIC_DISPLAY);
  });
});

describe('svtMasterDisplayString', () => {
  it('converts the source mastering display to SVT-AV1 decimal units', () => {
    expect(svtMasterDisplayString(SOURCE)).toBe(
      'G(0.17,0.797)B(0.131,0.046)R(0.708,0.292)WP(0.3127,0.329)L(4000,0.005)',
    );
  });
  it('converts the generic reference when absent', () => {
    expect(svtMasterDisplayString(undefined)).toBe(
      'G(0.265,0.69)B(0.15,0.06)R(0.68,0.32)WP(0.3127,0.329)L(1000,0.0001)',
    );
  });
});

describe('maxCllString', () => {
  it('formats the source content-light level as "maxCLL,maxFALL"', () => {
    expect(maxCllString(SOURCE)).toBe('4000,600');
  });
  it('emits the valid "0,0" unknown signal when the source had no CLL', () => {
    expect(
      maxCllString({
        masteringDisplay: SOURCE.masteringDisplay,
        maxCll: 0,
        maxFall: 0,
      }),
    ).toBe('0,0');
  });
  it('falls back to the generic reference when absent', () => {
    expect(maxCllString(undefined)).toBe('1000,400');
  });
});

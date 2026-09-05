import {
  getHdrLadderForDevice,
  getLadderForDevice,
  resolveLadderRung,
} from './profiles';

const sdr = getLadderForDevice('desktop');
const hdr = getHdrLadderForDevice('desktop');

describe('resolveLadderRung', () => {
  it('matches an exact name', () => {
    expect(resolveLadderRung('eco-1080p', sdr)?.name).toBe('eco-1080p');
  });

  it('keeps the low-consumption tier across ladders', () => {
    expect(resolveLadderRung('eco-1080p', hdr)?.name).toBe('eco-1080p-hdr');
    expect(resolveLadderRung('eco-1080p-hdr', sdr)?.name).toBe('eco-1080p');
  });

  it('never promotes an eco rung to its full-quality sibling', () => {
    // The HDR eco tier stops at 1080p, so a 720p eco request lands on the
    // smallest eco rung there — still low-consumption, never the full rung.
    expect(resolveLadderRung('eco-720p', hdr)?.name).toBe('eco-1080p-hdr');
  });

  it('steps down, never up, when the tier is missing', () => {
    expect(resolveLadderRung('1440p', sdr)?.name).toBe('1080p');
  });

  it('maps a full rung onto the same tier of the other ladder', () => {
    expect(resolveLadderRung('1080p', hdr)?.name).toBe('1080p-hdr');
  });

  it('falls to the smallest rung of its class below the whole ladder', () => {
    expect(resolveLadderRung('144p', hdr)?.name).toBe('480p-hdr');
  });

  it('returns undefined for a name carrying no tier', () => {
    expect(resolveLadderRung('nonsense', sdr)).toBeUndefined();
  });
});

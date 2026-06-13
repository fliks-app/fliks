import { probeableAccels } from './encoder-probe';

describe('probeableAccels', () => {
  it('always includes the CPU fallback so resolve() can degrade', () => {
    for (const a of ['qsv', 'vaapi', 'nvenc', 'videotoolbox', 'none'] as const) {
      expect(probeableAccels(a).has('none')).toBe(true);
    }
  });

  it('includes VAAPI on a QSV host (cropped QSV encodes fall back to vaapi)', () => {
    // requestedHwAccelFor maps qsv + crop -> vaapi, so vaapi encoders MUST stay
    // probeable on a QSV host or cropped transcodes lose their encoder.
    const qsv = probeableAccels('qsv');
    expect(qsv.has('qsv')).toBe(true);
    expect(qsv.has('vaapi')).toBe(true);
    expect(qsv.has('nvenc')).toBe(false);
    expect(qsv.has('videotoolbox')).toBe(false);
  });

  it('probes only its own accel + CPU for non-QSV hosts', () => {
    expect([...probeableAccels('vaapi')].sort()).toEqual(['none', 'vaapi']);
    expect([...probeableAccels('nvenc')].sort()).toEqual(['none', 'nvenc']);
    expect([...probeableAccels('videotoolbox')].sort()).toEqual([
      'none',
      'videotoolbox',
    ]);
    expect([...probeableAccels('none')]).toEqual(['none']);
  });
});

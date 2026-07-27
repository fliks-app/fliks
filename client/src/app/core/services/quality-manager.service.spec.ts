import { highestRungId, type QualityOption } from './quality-manager.service';

const opt = (id: string, height: number): QualityOption => ({ id, label: id, height });

describe('highestRungId', () => {
  it('picks the max-height rung, excluding auto', () => {
    const opts = [opt('auto', 0), opt('480p', 480), opt('1080p', 1080), opt('2160p', 2160)];
    expect(highestRungId(opts)).toBe('2160p');
  });

  it('is order-independent', () => {
    const opts = [opt('1080p', 1080), opt('2160p', 2160), opt('auto', 0), opt('480p', 480)];
    expect(highestRungId(opts)).toBe('2160p');
  });

  it('returns undefined for an empty list', () => {
    expect(highestRungId([])).toBeUndefined();
  });

  it('returns undefined when only auto is present', () => {
    expect(highestRungId([opt('auto', 0)])).toBeUndefined();
  });
});

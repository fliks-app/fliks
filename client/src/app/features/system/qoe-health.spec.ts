import { describe, expect, it } from 'vitest';
import { formatMbps, qoeDotClass } from './qoe-health';

const f = { t: (k: string, p?: Record<string, string>) => `${k}:${p?.['value']}`, n: (v: number, d = 1) => v.toFixed(d).replace('.', ',') };

describe('qoeDotClass', () => {
  it('follows the verdict alone, stalls or confidence never tint it', () => {
    const v = (verdict: any) => qoeDotClass({ verdict });
    expect(v('ok')).toBe('bg-success');
    expect(v('network')).toBe('bg-warning');
    expect(v('server')).toBe('bg-error');
  });
});

describe('formatMbps', () => {
  it('formats in the admin locale and is empty when unknown', () => {
    expect(formatMbps(5_500_000, f)).toBe('qoe.mbps:5,5');
    expect(formatMbps(null, f)).toBe('');
  });
});

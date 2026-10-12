import { describe, expect, it } from 'vitest';
import { qoeHealth } from './qoe-health';

const q = (verdict: any, confidence: any = 'high', stallCount = 0) => ({ verdict, confidence, reasons: [], stallCount });

describe('qoeHealth', () => {
  it('maps verdict and confidence to a dot colour', () => {
    expect(qoeHealth(q('unknown'))).toBe('unknown');
    expect(qoeHealth(q('ok'))).toBe('ok');
    expect(qoeHealth(q('ok', 'low'))).toBe('warn');
    expect(qoeHealth(q('ok', 'high', 2))).toBe('warn');
    expect(qoeHealth(q('network'))).toBe('bad');
    expect(qoeHealth(q('device', 'low'))).toBe('warn');
  });
});

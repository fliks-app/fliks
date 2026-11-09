import { describe, expect, it } from 'vitest';
import { deviceIconFor } from './device-icon';

describe('deviceIconFor', () => {
  it('maps the form factors', () => {
    expect(deviceIconFor('tv')).toBe('tv');
    expect(deviceIconFor('tablet')).toBe('tablet');
    expect(deviceIconFor('phone')).toBe('phone');
  });

  it('reads anything else as a computer', () => {
    expect(deviceIconFor('desktop')).toBe('monitor');
    expect(deviceIconFor(null)).toBe('monitor');
    expect(deviceIconFor(undefined)).toBe('monitor');
  });
});

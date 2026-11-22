import { afterEach, describe, expect, it } from 'vitest';
import { formatBitrate, formatBytes } from './format-bytes';

describe('format-bytes', () => {
  afterEach(() => document.documentElement.removeAttribute('lang'));

  it('formats binary sizes', () => {
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('formats decimal bitrates', () => {
    expect(formatBitrate(2_500_000)).toBe('2.5 Mbps');
    expect(formatBitrate(640_000)).toBe('640 kbps');
  });

  it('follows the UI language for the decimal separator', () => {
    document.documentElement.lang = 'fr';
    expect(formatBytes(1536)).toBe('1,5 KB');
  });
});

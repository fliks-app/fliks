import { describe, expect, it } from 'vitest';
import { tintOf } from './cover-tint';

const image = (...rgb: [number, number, number][]) => new Uint8ClampedArray(rgb.flatMap(([r, g, b]) => [r, g, b, 255]));

describe('tintOf', () => {
  it('keeps the dominant hue, darkened', () => {
    expect(tintOf(image([0, 128, 128], [0, 120, 130], [200, 0, 0]))).toMatch(/^hsl\(18\d 60% 26%\)$/);
  });

  it('gives no tint for a grey image', () => {
    expect(tintOf(image([40, 40, 40], [200, 200, 200]))).toBeNull();
  });
});

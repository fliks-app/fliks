import { resolutionFitsCap } from './resolution.util';

describe('resolutionFitsCap', () => {
  it('passes when the frame fits the cap', () => {
    expect(resolutionFitsCap(1920, 1080, 2048, 2048)).toBe(true);
  });

  it('rejects a frame whose long edge exceeds the cap', () => {
    expect(resolutionFitsCap(3840, 2076, 2048, 2048)).toBe(false);
  });

  it('is orientation-agnostic — a rotated cap still fits a landscape frame', () => {
    // 4K decoder advertising its maxima rotated (2160×3840) vs a 3840×2160 frame.
    expect(resolutionFitsCap(3840, 2160, 2160, 3840)).toBe(true);
  });

  it('is orientation-agnostic — a portrait frame is rejected on the long edge', () => {
    expect(resolutionFitsCap(2076, 3840, 2048, 2048)).toBe(false);
  });

  it('treats an undefined/zero cap axis as no limit', () => {
    expect(resolutionFitsCap(3840, 2160, undefined, undefined)).toBe(true);
    expect(resolutionFitsCap(3840, 2160, 0, 0)).toBe(true);
  });
});

import type { KaraokeModel } from '../../../core/services/api/karaoke.models';
import { QUALITY_MODEL_ID, qualityModelReady, reportedProviders } from './karaoke-settings';

describe('reportedProviders', () => {
  it('keeps only the verifiable providers the engine reports, in display order', () => {
    expect(reportedProviders(['cpu', 'openvino', 'cuda', 'unknown'])).toEqual(['cuda', 'openvino']);
  });

  it('is empty when the engine reports the CPU only', () => {
    expect(reportedProviders(['cpu'])).toEqual([]);
  });
});

describe('qualityModelReady', () => {
  it('is true only once the engine reports the quality model installed', () => {
    expect(qualityModelReady({ id: QUALITY_MODEL_ID, state: 'installed' } as KaraokeModel)).toBe(true);
    expect(qualityModelReady({ id: QUALITY_MODEL_ID, state: 'absent' } as KaraokeModel)).toBe(false);
    expect(qualityModelReady(undefined)).toBe(false);
  });
});

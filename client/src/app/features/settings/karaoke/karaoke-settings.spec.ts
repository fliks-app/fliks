import type { KaraokeModel, KaraokeStatus } from '../../../core/services/api/karaoke.models';
import { QUALITY_MODEL_ID, backgroundState, qualityModelReady, reportedProviders } from './karaoke-settings';

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

describe('backgroundState', () => {
  const status = (s: Partial<KaraokeStatus>) => ({ enabled: true, separate: true, gpu: false, background: false, ...s }) as KaraokeStatus;

  it('names why the pass runs or not', () => {
    expect(backgroundState(null)).toBeNull();
    expect(backgroundState(status({ enabled: false }))).toBeNull();
    expect(backgroundState(status({ background: true, gpu: true }))).toBe('active');
    expect(backgroundState(status({ background: true }))).toBe('active_cpu');
    expect(backgroundState(status({ separate: false }))).toBe('no_model');
    expect(backgroundState(status({}))).toBe('no_gpu');
    expect(backgroundState(status({ gpu: true }))).toBe('stopped');
  });
});

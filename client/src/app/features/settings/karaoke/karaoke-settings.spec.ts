import { reportedProviders } from './karaoke-settings';

describe('reportedProviders', () => {
  it('keeps only the verifiable providers the engine reports, in display order', () => {
    expect(reportedProviders(['cpu', 'openvino', 'cuda', 'unknown'])).toEqual(['cuda', 'openvino']);
  });

  it('is empty when the engine reports the CPU only', () => {
    expect(reportedProviders(['cpu'])).toEqual([]);
  });
});

import { hwDownloadFilterFor } from './decoder-probe';
import type { DecoderDescriptor } from './decoders/types';

function descriptor(
  outputSurface: DecoderDescriptor['outputSurface'],
  maxBitDepth: DecoderDescriptor['maxBitDepth'],
): DecoderDescriptor {
  return {
    id: 'test_decode',
    hwAccel: 'qsv',
    sourceCodec: 'hevc',
    maxBitDepth,
    outputSurface,
    supports: () => true,
    buildInputArgs: () => [],
  };
}

describe('hwDownloadFilterFor', () => {
  it('skips CPU decoders, they have no hw surface to download', () => {
    expect(hwDownloadFilterFor(descriptor('cpu', 10))).toBeNull();
  });

  it('downloads the 8-bit probe sample as nv12, even on a 10-bit decoder', () => {
    expect(hwDownloadFilterFor(descriptor('qsv', 10))).toBe('hwdownload,format=nv12');
  });
});

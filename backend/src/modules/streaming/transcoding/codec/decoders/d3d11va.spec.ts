import { h264D3d11vaDecoder, h264D3d11vaNativeDecoder } from './d3d11va';

describe('D3D11VA (AMF) decoders', () => {
  it('the full-GPU decoder keeps frames on d3d11 and enlarges the pool', () => {
    const joined = h264D3d11vaNativeDecoder.buildInputArgs().join(' ');
    expect(h264D3d11vaNativeDecoder.outputSurface).toBe('d3d11');
    expect(joined).toContain('-hwaccel_output_format d3d11');
    expect(joined).toContain('-extra_hw_frames 32');
  });

  it('the CPU-output decoder downloads immediately and stays lean', () => {
    const joined = h264D3d11vaDecoder.buildInputArgs().join(' ');
    expect(h264D3d11vaDecoder.outputSurface).toBe('cpu');
    expect(joined).not.toContain('-hwaccel_output_format');
    expect(joined).not.toContain('-extra_hw_frames');
  });
});

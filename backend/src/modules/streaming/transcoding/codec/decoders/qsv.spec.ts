import {
  h264QsvDecoder,
  hevcQsvDecoder,
  av1QsvDecoder,
  h264QsvD3d11Decoder,
} from './qsv';
import { findQsvNativeDecoder } from './index';

describe('QSV encode-path decoders', () => {
  it('findQsvNativeDecoder picks the D3D11VA→QSV decoder on Windows', () => {
    const d = findQsvNativeDecoder('av1', 'win32');
    expect(d?.id).toBe('av1_qsv_d3d11_decode');
    expect(d?.outputSurface).toBe('d3d11');
    expect(d?.hwAccel).toBe('qsv');
  });

  // Off Windows, findQsvNativeDecoder returns the same descriptor the
  // registry resolves generally: native-vs-default was a routing label
  // (qsvNative on the resolved pipeline now), never a decode-argv difference.
  it('findQsvNativeDecoder picks the same VAAPI-backed decoder off Windows', () => {
    const d = findQsvNativeDecoder('av1', 'linux');
    expect(d?.id).toBe('av1_qsv_decode');
    expect(d?.outputSurface).toBe('vaapi');
    expect(d).toBe(av1QsvDecoder);
  });

  it('the Windows decoder decodes on D3D11VA and derives QSV from the same device', () => {
    const args = h264QsvD3d11Decoder.buildInputArgs();
    const joined = args.join(' ');
    expect(args).toContain('d3d11va=dx');
    expect(args).toContain('qsv=qs@dx');
    expect(joined).toContain('-hwaccel d3d11va');
    expect(joined).toContain('-hwaccel_output_format d3d11');
    // Never the native -hwaccel qsv decode (its AV1 path is broken on Windows).
    expect(joined).not.toContain('-hwaccel qsv');
  });

  it('the Linux decoder is off-Windows-only, the d3d11 one Windows-only', () => {
    // supports() reads the real process.platform (linux under CI).
    expect(h264QsvDecoder.supports()).toBe(process.platform !== 'win32');
    expect(h264QsvD3d11Decoder.supports()).toBe(process.platform === 'win32');
  });

  it('av1/hevc qsv decode is available off-Windows (native VAAPI, not the broken wrapper)', () => {
    expect(av1QsvDecoder.supports()).toBe(process.platform !== 'win32');
    expect(hevcQsvDecoder.supports()).toBe(process.platform !== 'win32');
    expect(h264QsvDecoder.supports()).toBe(process.platform !== 'win32');
  });
});

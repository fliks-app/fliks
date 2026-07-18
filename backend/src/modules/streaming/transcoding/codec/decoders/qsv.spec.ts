import {
  h264QsvNativeDecoder,
  hevcQsvNativeDecoder,
  av1QsvNativeDecoder,
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

  it('findQsvNativeDecoder picks the qsv-native decoder off Windows', () => {
    const d = findQsvNativeDecoder('av1', 'linux');
    expect(d?.id).toBe('av1_qsv_native_decode');
    expect(d?.outputSurface).toBe('qsv');
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

  it('the qsv-native decoder is off-Windows-only, the d3d11 one Windows-only', () => {
    // supports() reads the real process.platform (linux under CI).
    expect(h264QsvNativeDecoder.supports()).toBe(process.platform !== 'win32');
    expect(h264QsvD3d11Decoder.supports()).toBe(process.platform === 'win32');
  });

  it('force-disables av1 qsv-native decode (broken on ffmpeg 8.x) but keeps h264/hevc', () => {
    // AV1_QSV_DECODE_BROKEN: av1_qsv decode regresses on jellyfin-ffmpeg 8.x
    // (oneVPL dynamic frame pool -17), so AV1 falls back to VAAPI decode. The
    // boot decoder-probe honours supports() and disables it accordingly.
    expect(av1QsvNativeDecoder.supports()).toBe(false);
    // Only AV1 is disabled — h264/hevc qsv-native decode stays available.
    expect(hevcQsvNativeDecoder.supports()).toBe(process.platform !== 'win32');
    expect(h264QsvNativeDecoder.supports()).toBe(process.platform !== 'win32');
  });
});

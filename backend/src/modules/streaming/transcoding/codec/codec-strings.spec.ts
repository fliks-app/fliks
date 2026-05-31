import { audioCodecString } from './codec-strings';

describe('audioCodecString', () => {
  it('maps the fMP4-compatible codecs to their RFC 6381 strings', () => {
    expect(audioCodecString('aac')).toBe('mp4a.40.2');
    expect(audioCodecString('ac3')).toBe('ac-3');
    expect(audioCodecString('eac3')).toBe('ec-3');
    expect(audioCodecString('opus')).toBe('Opus');
    expect(audioCodecString('flac')).toBe('fLaC');
  });

  it('is case-insensitive', () => {
    expect(audioCodecString('OPUS')).toBe('Opus');
    expect(audioCodecString('FLAC')).toBe('fLaC');
  });

  it('returns null for an unknown codec so the caller omits it (never mislabels as AAC)', () => {
    expect(audioCodecString('truehd')).toBeNull();
    expect(audioCodecString('dts')).toBeNull();
    expect(audioCodecString('')).toBeNull();
  });
});

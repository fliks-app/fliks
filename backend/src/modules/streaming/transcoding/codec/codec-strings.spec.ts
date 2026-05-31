import { audioCodecString, audioRenditionChannels } from './codec-strings';

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

describe('audioRenditionChannels', () => {
  it('downmixes AAC output to stereo regardless of the source layout', () => {
    expect(audioRenditionChannels('aac', 6)).toBe(2);
    expect(audioRenditionChannels('aac', 1)).toBe(2);
    expect(audioRenditionChannels('AAC', undefined)).toBe(2);
  });

  it('keeps the source channel count for copy / AC-3 / E-AC-3 (no -ac)', () => {
    expect(audioRenditionChannels('eac3', 6)).toBe(6);
    expect(audioRenditionChannels('ac3', 6)).toBe(6);
    expect(audioRenditionChannels('opus', 8)).toBe(8);
    expect(audioRenditionChannels('flac', 2)).toBe(2);
  });

  it('falls back to 2 when the source channel count is unknown or invalid', () => {
    expect(audioRenditionChannels('eac3', undefined)).toBe(2);
    expect(audioRenditionChannels('eac3', 0)).toBe(2);
  });
});

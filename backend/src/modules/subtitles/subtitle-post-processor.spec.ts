import { assToSrt, commonFixes, fixUppercase } from './subtitle-post-processor';

// The `.ass` → `.srt` rename in applyPostProcessing keys on assToSrt returning
// something different from its input, so the no-op paths have to stay exact.
describe('assToSrt', () => {
  it('converts dialogue lines and timings', () => {
    const ass = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:01:23.45,0:01:26.78,Default,,0,0,0,,First line\\NSecond line',
    ].join('\n');

    expect(assToSrt(ass)).toBe(
      '1\n00:01:23,450 --> 00:01:26,780\nFirst line\nSecond line\n',
    );
  });

  it('returns SRT input unchanged', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
    expect(assToSrt(srt)).toBe(srt);
  });

  it('returns the original when no dialogue line is usable', () => {
    const ass = '[Events]\nDialogue: 0,0:01:23.45,0:01:26.78,Default,,0,0,0,,';
    expect(assToSrt(ass)).toBe(ass);
  });
});

describe('commonFixes', () => {
  it('keeps the blank line between cues', () => {
    const srt =
      '\n1\n00:00:01,000 --> 00:00:02,000\nHello  there .\n \n\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n';
    expect(commonFixes(srt)).toBe(
      '1\n00:00:01,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n',
    );
  });

  it('keeps CRLF separators', () => {
    const srt =
      '1\r\n00:00:01,000 --> 00:00:02,000\r\nA\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nB\r\n';
    expect(commonFixes(srt)).toBe(srt);
  });

  it('keeps the space before ? ! ; : in French', () => {
    const line = 'Tu rentres quand ? Vite , là !';
    expect(commonFixes(line, 'fr')).toBe('Tu rentres quand ? Vite, là !');
    expect(commonFixes(line, 'en')).toBe('Tu rentres quand? Vite, là!');
  });
});

describe('fixUppercase', () => {
  it('capitalises only lines that start a sentence', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:02,000\nSAVES THE CITY\nFROM THE BLAST. AND\nTHEN LEAVES';
    expect(fixUppercase(srt)).toBe(
      '1\n00:00:01,000 --> 00:00:02,000\nSaves the city\nfrom the blast. and\nthen leaves',
    );
  });
});

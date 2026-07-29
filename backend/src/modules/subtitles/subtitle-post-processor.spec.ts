import { assToSrt } from './subtitle-post-processor';

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

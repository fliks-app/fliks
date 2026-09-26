import { resolveMuxFlavour, varStreamMapLayout } from './audio-layout';

describe('varStreamMapLayout', () => {
  it('is in effect only for a video-only session with audio to map', () => {
    expect(varStreamMapLayout(true, 2)).toBe(true);
    expect(varStreamMapLayout(true, 1)).toBe(true);
    expect(varStreamMapLayout(true, 0)).toBe(false); // nothing to map
    expect(varStreamMapLayout(false, 3)).toBe(false); // muxed output
    expect(varStreamMapLayout(false, 0)).toBe(false);
  });
});

describe('resolveMuxFlavour', () => {
  it('uses MPEG-TS when forced, or on single-audio sources when asked', () => {
    expect(resolveMuxFlavour({ useTs: true }, 3)).toBe('ts');
    expect(resolveMuxFlavour({ useTsOnSingleAudio: true }, 1)).toBe('ts');
    expect(resolveMuxFlavour({ useTsOnSingleAudio: true }, 0)).toBe('ts');
    expect(resolveMuxFlavour({ useTsOnSingleAudio: true }, 2)).toBe('fmp4');
    expect(resolveMuxFlavour({}, 1)).toBe('fmp4');
  });
});

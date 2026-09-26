import {
  audioLayout,
  resolveMuxFlavour,
  varStreamMapLayout,
} from './audio-layout';

describe('audioLayout', () => {
  it('splits several tracks into renditions and muxes one or none', () => {
    expect(audioLayout(3)).toBe('var-stream-map');
    expect(audioLayout(2)).toBe('var-stream-map');
    expect(audioLayout(1)).toBe('inline');
    expect(audioLayout(0)).toBe('inline');
  });
});

describe('varStreamMapLayout', () => {
  it('is in effect only for a video-only session of a split source', () => {
    expect(varStreamMapLayout(true, 2)).toBe(true);
    expect(varStreamMapLayout(true, 1)).toBe(false);
    expect(varStreamMapLayout(true, 0)).toBe(false);
    expect(varStreamMapLayout(false, 3)).toBe(false);
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

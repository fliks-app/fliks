import { describe, expect, it } from 'vitest';
import {
  chapterAt,
  chaptersFromParts,
  locate,
  nextChapterStart,
  previousChapterStart,
} from './audio-timeline';

const parts = [
  { offset: 0, duration: 10 },
  { offset: 10, duration: 20 },
];
const chapters = chaptersFromParts(parts);

describe('audio timeline', () => {
  it('locates a position in its part, a boundary in the part that starts there', () => {
    expect(locate(parts, 4)).toEqual({ index: 0, local: 4 });
    expect(locate(parts, 10)).toEqual({ index: 1, local: 0 });
    expect(locate(parts, 25)).toEqual({ index: 1, local: 15 });
  });

  it('clamps a position past the end to the end of the last part', () => {
    expect(locate(parts, 99)).toEqual({ index: 1, local: 20 });
    expect(locate(parts, -5)).toEqual({ index: 0, local: 0 });
    expect(locate([], 3)).toEqual({ index: 0, local: 0 });
  });

  it('finds the chapter of a position', () => {
    expect(chapterAt(chapters, 0)).toBe(0);
    expect(chapterAt(chapters, 10)).toBe(1);
    expect(chapterAt([{ title: null, start: 5, end: 9 }], 1)).toBe(-1);
  });

  it('goes back to the chapter start, then to the previous chapter', () => {
    expect(previousChapterStart(chapters, 20)).toBe(10);
    expect(previousChapterStart(chapters, 11)).toBe(0);
    expect(previousChapterStart(chapters, 1)).toBe(0);
  });

  it('has no next chapter on the last', () => {
    expect(nextChapterStart(chapters, 3)).toBe(10);
    expect(nextChapterStart(chapters, 12)).toBeNull();
  });
});

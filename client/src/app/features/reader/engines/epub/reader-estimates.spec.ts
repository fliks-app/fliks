import { Locator } from '@readium/shared';
import { bookMinutesLeft, chapterAt, chapterBefore, chapterMarks, chapterMinutesLeft } from './reader-estimates';

const at = (href: string, position: number, total: number, progression = 0): Locator =>
  new Locator({
    href,
    type: 'application/xhtml+xml',
    locations: { position, totalProgression: total, progression },
  } as never);

const positions = [
  at('a.xhtml', 1, 0),
  at('a.xhtml', 2, 0.1),
  at('b.xhtml', 3, 0.5),
  at('b.xhtml', 4, 0.75),
];

describe('reader estimates', () => {
  it('counts the minutes left in the file from the progression inside it', () => {
    expect(chapterMinutesLeft(at('b.xhtml#x', 3, 0.5, 0.5), positions)).toBe(1);
    expect(chapterMinutesLeft(at('a.xhtml', 1, 0, 0), positions)).toBe(1);
    expect(chapterMinutesLeft(at('gone.xhtml', 1, 0), positions)).toBe(0);
  });

  it('counts the minutes left in the book', () => {
    expect(bookMinutesLeft(0.5, positions)).toBe(1);
    expect(bookMinutesLeft(1, positions)).toBe(0);
  });

  it('marks each file once, in book order, and finds the chapter of a progression', () => {
    const marks = chapterMarks(
      [
        { href: 'b.xhtml', title: 'Two' },
        { href: 'a.xhtml', title: 'One' },
        { href: 'a.xhtml#s', title: 'Section' },
        { href: 'nope.xhtml', title: 'Lost' },
      ],
      positions,
    );
    expect(marks.map((m) => m.title)).toEqual(['One', 'Two']);
    expect(chapterAt(marks, 0.3)?.title).toBe('One');
    expect(chapterAt(marks, 0.6)?.title).toBe('Two');
    expect(chapterBefore(marks, 0.8)?.title).toBe('Two');
    expect(chapterBefore(chapterMarks([{ href: 'b.xhtml', title: 'Two' }], positions), 0.1)).toBeUndefined();
  });
});

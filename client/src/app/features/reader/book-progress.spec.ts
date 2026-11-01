import type { Locator } from '@readium/shared';
import { bookProgression } from './book-progress';

const at = (href: string, progression: number, totalProgression?: number) =>
  ({ href, locations: { progression, totalProgression } }) as unknown as Locator;

// Two chapters: ch1 holds positions 0 and 0.2 (so it spans 0..0.5), ch2 spans 0.5..1.
const positions = [at('a.xhtml', 0, 0), at('a.xhtml', 0.5, 0.25), at('b.xhtml', 0, 0.5), at('b.xhtml', 0.5, 0.75)];

describe('bookProgression', () => {
  it('starts a chapter at its first position', () => {
    expect(bookProgression(at('b.xhtml', 0), positions)).toBe(0.5);
  });

  it('moves smoothly between two positions of a chapter', () => {
    expect(bookProgression(at('a.xhtml', 0.1), positions)).toBeCloseTo(0.05);
    expect(bookProgression(at('a.xhtml', 0.3), positions)).toBeCloseTo(0.15);
  });

  it('runs the last chapter up to the end of the book', () => {
    expect(bookProgression(at('b.xhtml', 1), positions)).toBe(1);
  });

  it('ignores a fragment on the locator href', () => {
    expect(bookProgression(at('b.xhtml#note', 0.5), positions)).toBe(0.75);
  });

  it('falls back to the toolkit value for a resource with no position', () => {
    expect(bookProgression(at('c.xhtml', 0.4, 0.33), positions)).toBe(0.33);
    expect(bookProgression(at('c.xhtml', 0.4), [])).toBe(0);
  });
});

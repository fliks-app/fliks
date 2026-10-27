import { describe, expect, it } from 'vitest';
import { nearestInDirection, sharesBand } from './tv-spatial-nav.service';

/** A 3x2 grid of 40px cells, 10px apart. */
function grid(): HTMLElement[] {
  return [0, 1].flatMap((row) =>
    [0, 1, 2].map((col) => {
      const el = document.createElement('button');
      const x = col * 50;
      const y = row * 50;
      el.getBoundingClientRect = () => ({ left: x, top: y, width: 40, height: 40, right: x + 40, bottom: y + 40, x, y, toJSON: () => ({}) });
      return el;
    }),
  );
}

describe('nearestInDirection', () => {
  it('steps by column on up/down and by row on left/right', () => {
    const cells = grid();
    expect(nearestInDirection(cells, cells[1], 'down')).toBe(cells[4]);
    expect(nearestInDirection(cells, cells[4], 'up')).toBe(cells[1]);
    expect(nearestInDirection(cells, cells[1], 'right')).toBe(cells[2]);
    expect(nearestInDirection(cells, cells[1], 'left')).toBe(cells[0]);
  });

  it('has nothing past the edge, so the step leaves the grid', () => {
    const cells = grid();
    expect(nearestInDirection(cells, cells[0], 'up')).toBeNull();
    expect(nearestInDirection(cells, cells[5], 'right')).toBeNull();
  });
});

describe('sharesBand', () => {
  it('keeps a vertical step off the buttons beside the active one', () => {
    const [a, b, , below] = grid().map((el) => el.getBoundingClientRect());
    expect(sharesBand(b, a, false)).toBe(true);
    expect(sharesBand(below, a, false)).toBe(false);
    expect(sharesBand(below, a, true)).toBe(true);
  });
});

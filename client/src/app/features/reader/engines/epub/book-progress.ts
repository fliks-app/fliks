import type { Locator } from '@readium/shared';

/** Whole-book progress, 0..1, interpolated inside the chapter: the toolkit only moves its own value
 *  from one position (about a screenful of text) to the next, so a slider on it would stall between them. */
export function bookProgression(locator: Locator, positions: Locator[]): number {
  const href = locator.href.split('#')[0];
  const first = positions.findIndex((p) => p.href === href);
  if (first < 0) return locator.locations.totalProgression ?? 0;
  const after = positions.findIndex((p, i) => i > first && p.href !== href);
  const start = positions[first].locations.totalProgression ?? 0;
  const end = after < 0 ? 1 : (positions[after].locations.totalProgression ?? 1);
  const inChapter = Math.min(1, Math.max(0, locator.locations.progression ?? 0));
  return start + inChapter * (end - start);
}

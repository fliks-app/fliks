import type { Locator } from '@readium/shared';

/** A position is 1024 bytes of markup, about 100 words of text at a calm 230 words a minute. */
export const MINUTES_PER_POSITION = 0.45;

const pathOf = (href: string): string => href.split('#')[0];

export interface ChapterMark {
  /** Index into the toc rows. */
  row: number;
  title: string;
  /** Where the chapter starts in the book, 0..1. */
  start: number;
}

/** Minutes left in the file on screen, from the positions that follow the current one. */
export function chapterMinutesLeft(locator: Locator, positions: Locator[]): number {
  const href = pathOf(locator.href);
  const inFile = positions.filter((p) => p.href === href);
  if (!inFile.length) return 0;
  const left = inFile.length * (1 - Math.min(1, Math.max(0, locator.locations.progression ?? 0)));
  return Math.ceil(left * MINUTES_PER_POSITION);
}

export function bookMinutesLeft(progression: number, positions: Locator[]): number {
  return Math.ceil(positions.length * (1 - progression) * MINUTES_PER_POSITION);
}

/** A toc row's start in the book; rows sharing a file keep the file's first position. */
export function chapterMarks(
  rows: { href: string; title: string }[],
  positions: Locator[],
): ChapterMark[] {
  const marks: ChapterMark[] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const path = pathOf(row.href);
    if (seen.has(path)) return;
    const first = positions.find((p) => p.href === path);
    if (!first) return;
    seen.add(path);
    marks.push({ row: i, title: row.title, start: first.locations.totalProgression ?? 0 });
  });
  return marks.sort((a, b) => a.start - b.start);
}

/** The chapter a book progression falls in, for the scrubber's bubble. */
export function chapterAt(marks: ChapterMark[], progression: number): ChapterMark | undefined {
  let hit: ChapterMark | undefined;
  for (const m of marks) if (m.start <= progression + 1e-9) hit = m;
  return hit ?? marks[0];
}

/** "1 h 05" or "12 min". */
export function formatMinutes(total: number): { h: number; m: number } {
  return { h: Math.floor(total / 60), m: total % 60 };
}

/** A file of an audio item on the item's virtual timeline (seconds). */
export interface TimelinePart {
  offset: number;
  duration: number;
}

export interface TimelineChapter {
  title: string | null;
  start: number;
  end: number;
}

/** The part holding `position` and the position inside it; a boundary belongs to the part that starts there, a position past the end is the end of the last part. */
export function locate(parts: readonly TimelinePart[], position: number): { index: number; local: number } {
  if (!parts.length) return { index: 0, local: 0 };
  const pos = Math.max(0, position);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (pos < p.offset + p.duration || i === parts.length - 1) {
      return { index: i, local: Math.min(Math.max(0, pos - p.offset), p.duration) };
    }
  }
  return { index: 0, local: 0 };
}

/** Index of the chapter holding `position`; -1 before the first. */
export function chapterAt(chapters: readonly TimelineChapter[], position: number): number {
  let found = -1;
  for (let i = 0; i < chapters.length && chapters[i].start <= position; i++) found = i;
  return found;
}

/** Where `previoustrack` goes: the start of the current chapter, or the one before it within the first 3 s of it. */
export function previousChapterStart(chapters: readonly TimelineChapter[], position: number): number {
  const i = chapterAt(chapters, position);
  if (i < 0) return 0;
  return position - chapters[i].start > 3 || i === 0 ? chapters[i].start : chapters[i - 1].start;
}

/** Start of the chapter after the one holding `position`, or null on the last. */
export function nextChapterStart(chapters: readonly TimelineChapter[], position: number): number | null {
  return chapters[chapterAt(chapters, position) + 1]?.start ?? null;
}

/** One chapter per part, for an item whose files carry none. */
export function chaptersFromParts(parts: readonly TimelinePart[]): TimelineChapter[] {
  return parts.map((p) => ({ title: null, start: p.offset, end: p.offset + p.duration }));
}

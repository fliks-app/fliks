/** Whole-book progression of a page: 0 on the first, 1 on the last, so the finish rule (0.99) closes the book. */
export function pdfProgression(page: number, pages: number): number {
  return pages > 1 ? Math.min(1, Math.max(0, (page - 1) / (pages - 1))) : 1;
}

/** The page a stored locator names, within the document; else the page the stored progression falls on, else the first. */
export function pdfPageOf(locator: unknown, pages: number, progression?: number | null): number {
  const n = (locator as { page?: unknown } | null)?.page;
  if (typeof n === 'number' && Number.isInteger(n)) return Math.min(pages, Math.max(1, n));
  return typeof progression === 'number' ? pageAtProgression(progression, pages) : 1;
}

/** The page at a whole-book progression, the inverse of `pdfProgression`. */
export function pageAtProgression(at: number, pages: number): number {
  return pages > 1 ? Math.round(Math.min(1, Math.max(0, at)) * (pages - 1)) + 1 : 1;
}

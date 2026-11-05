/** Whole-book progression of a page: 0 on the first, 1 on the last, so the finish rule (0.99) closes the book. */
export function pdfProgression(page: number, pages: number): number {
  return pages > 1 ? Math.min(1, Math.max(0, (page - 1) / (pages - 1))) : 1;
}

/** The page a stored locator names, within the document; the first page otherwise. */
export function pdfPageOf(locator: unknown, pages: number): number {
  const n = (locator as { page?: unknown } | null)?.page;
  return typeof n === 'number' && Number.isInteger(n) ? Math.min(pages, Math.max(1, n)) : 1;
}

/** The page at a whole-book progression, the inverse of `pdfProgression`. */
export function pageAtProgression(at: number, pages: number): number {
  return pages > 1 ? Math.round(Math.min(1, Math.max(0, at)) * (pages - 1)) + 1 : 1;
}

import type { TocEntry } from './reader-sidebar';
import { pdfProgression } from './pdf-position';

/** A row of a PDF's outline: where it points, in 1-based pages. */
export interface OutlineRow {
  title: string;
  depth: number;
  page: number;
}

interface OutlineNode {
  title: string;
  items?: OutlineNode[];
  dest: unknown;
}

/** The outline in reading order, one row per entry that points at a page of the document. */
export async function flattenOutline(
  nodes: OutlineNode[],
  pageOf: (dest: unknown) => Promise<number | null>,
  depth = 0,
): Promise<OutlineRow[]> {
  const rows: OutlineRow[] = [];
  for (const n of nodes) {
    const page = await pageOf(n.dest);
    if (page !== null && n.title.trim()) rows.push({ title: n.title.trim(), depth, page });
    rows.push(...(await flattenOutline(n.items ?? [], pageOf, depth + 1)));
  }
  return rows;
}

/** The contents panel's rows: an entry runs to the start of the next one, the last to the end of the book. */
export function outlineEntries(rows: OutlineRow[], pages: number): TocEntry[] {
  return rows.map((r, i) => {
    const start = pdfProgression(r.page, pages);
    const next = rows[i + 1];
    return { title: r.title, depth: r.depth, start, end: next ? Math.max(start, pdfProgression(next.page, pages)) : 1 };
  });
}

/** The row the page is in: the last one that starts on or before it. */
export function outlineRowAt(rows: OutlineRow[], page: number): number {
  let at = -1;
  rows.forEach((r, i) => {
    if (r.page <= page) at = i;
  });
  return at;
}

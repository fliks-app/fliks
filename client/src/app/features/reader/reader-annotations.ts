import type { Annotation, AnnotationColour } from './annotations-api.service';

export const COLOUR_HEX: Record<AnnotationColour, string> = {
  yellow: '#facc15',
  green: '#4ade80',
  blue: '#60a5fa',
  pink: '#f472b6',
};

export interface ChapterGroup {
  title: string;
  items: Annotation[];
}

const pathOf = (href: string): string => href.split('#')[0];
const hrefOf = (a: Annotation): string => pathOf(String(a.locator['href'] ?? ''));
const progressionOf = (a: Annotation): number => {
  const locations = a.locator['locations'] as { progression?: number } | undefined;
  return locations?.progression ?? 0;
};

/** Annotations in book order, grouped under the toc row of their file; a file the toc skips keeps the locator's title. */
export function groupByChapter(
  items: Annotation[],
  rows: { href: string; title: string }[],
): ChapterGroup[] {
  const order = (a: Annotation) => {
    const i = rows.findIndex((r) => pathOf(r.href) === hrefOf(a));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...items].sort(
    (a, b) => order(a) - order(b) || progressionOf(a) - progressionOf(b) || a.id - b.id,
  );
  const groups: ChapterGroup[] = [];
  for (const a of sorted) {
    const row = rows.find((r) => pathOf(r.href) === hrefOf(a));
    const title = row?.title ?? String(a.locator['title'] ?? '');
    const last = groups[groups.length - 1];
    if (last && last.title === title) last.items.push(a);
    else groups.push({ title, items: [a] });
  }
  return groups;
}

/** The highlights and notes of a book as Markdown, one block quote per highlight. */
export function annotationsMarkdown(
  title: string,
  groups: ChapterGroup[],
  labels: Record<AnnotationColour, string>,
): string {
  const lines = [`# ${title}`, ''];
  for (const g of groups) {
    const items = g.items.filter((a) => a.kind === 'highlight');
    if (!items.length) continue;
    if (g.title) lines.push(`## ${g.title}`, '');
    for (const a of items) {
      const quote = a.excerpt
        .split(/\r?\n+/)
        .filter(Boolean)
        .join(' ');
      lines.push(`> ${quote}`, '', `*${labels[a.colour ?? 'yellow']}*`, '');
      if (a.note) lines.push(a.note, '');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

const BLOCKS = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th, dd, dt, figcaption, div';

/** The block element holding a selection, whose selector tells a phrase from its twin elsewhere in the chapter. */
export function blockOf(range: Range): Element | null {
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest(BLOCKS) ?? null;
}

/** The text on either side of a selection, read across the whole document rather than from its end text nodes,
 * and where the selection starts in it, 0..1, measured like a search hit. */
export function rangeContext(
  range: Range,
  chars: number,
): { before: string; after: string; progression: number } {
  const body = range.startContainer.ownerDocument?.body ?? null;
  if (!body) return { before: '', after: '', progression: 0 };
  const head = range.cloneRange();
  head.selectNodeContents(body);
  head.setEnd(range.startContainer, range.startOffset);
  const tail = range.cloneRange();
  tail.selectNodeContents(body);
  tail.setStart(range.endContainer, range.endOffset);
  const [h, t] = [head.toString(), tail.toString()];
  const total = h.length + range.toString().length + t.length;
  return { before: h.slice(-chars), after: t.slice(0, chars), progression: total ? h.length / total : 0 };
}

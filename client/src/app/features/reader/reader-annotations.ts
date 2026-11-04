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

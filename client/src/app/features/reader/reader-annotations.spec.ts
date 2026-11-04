import type { Annotation } from './annotations-api.service';
import { annotationsMarkdown, groupByChapter } from './reader-annotations';

const note = (
  id: number,
  href: string,
  progression: number,
  over: Partial<Annotation> = {},
): Annotation => ({
  id,
  itemId: 1,
  kind: 'highlight',
  colour: 'yellow',
  note: '',
  excerpt: `line ${id}`,
  locator: { href, locations: { progression } },
  createdAt: '',
  updatedAt: '',
  ...over,
});

const rows = [
  { href: 'one.xhtml', title: 'One' },
  { href: 'two.xhtml', title: 'Two' },
];

describe('groupByChapter', () => {
  it('orders by chapter then by place in it, and groups under the toc title', () => {
    const groups = groupByChapter(
      [note(1, 'two.xhtml#a', 0.1), note(2, 'one.xhtml', 0.9), note(3, 'one.xhtml', 0.2)],
      rows,
    );
    expect(groups.map((g) => [g.title, g.items.map((a) => a.id)])).toEqual([
      ['One', [3, 2]],
      ['Two', [1]],
    ]);
  });

  it('keeps a file the toc skips after the others', () => {
    const groups = groupByChapter(
      [
        note(1, 'x.xhtml', 0, { locator: { href: 'x.xhtml', title: 'Extra' } }),
        note(2, 'one.xhtml', 0),
      ],
      rows,
    );
    expect(groups.map((g) => g.title)).toEqual(['One', 'Extra']);
  });
});

describe('annotationsMarkdown', () => {
  it('writes highlights with their colour and note, and leaves bookmarks out', () => {
    const groups = groupByChapter(
      [
        note(1, 'one.xhtml', 0, { note: 'mine' }),
        note(2, 'two.xhtml', 0, { kind: 'bookmark', colour: null }),
      ],
      rows,
    );
    const md = annotationsMarkdown('Book', groups, {
      yellow: 'Yellow',
      green: 'Green',
      blue: 'Blue',
      pink: 'Pink',
    });
    expect(md).toBe('# Book\n\n## One\n\n> line 1\n\n*Yellow*\n\nmine\n');
  });
});

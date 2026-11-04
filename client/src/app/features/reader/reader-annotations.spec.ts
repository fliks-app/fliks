import { Locator } from '@readium/shared';
import type { Annotation } from './annotations-api.service';
import { annotationsMarkdown, blockOf, groupByChapter, rangeContext } from './reader-annotations';

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

describe('selection context', () => {
  const select = (html: string, nth: number) => {
    document.body.innerHTML = html;
    const texts = [...document.querySelectorAll('b')].map((b) => b.firstChild as Text);
    const range = document.createRange();
    range.selectNodeContents(texts[nth]);
    return range;
  };

  it('reads before and after across the nodes around a repeated phrase', () => {
    const range = select('<p>Alpha <i>the</i> <b>cat</b> sat.</p><p>Beta <i>a</i> <b>cat</b> ran.</p>', 1);
    expect(rangeContext(range, 12)).toEqual({ before: ' sat.Beta a ', after: ' ran.', progression: 25 / 33 });
  });

  it('finds the block that holds the selection', () => {
    const range = select('<p id="one">x <b>cat</b></p><p id="two">y <b>cat</b></p>', 1);
    expect(blockOf(range)?.id).toBe('two');
  });
});

describe('a stored highlight locator', () => {
  it('keeps the selector of its block through the toolkit', () => {
    const raw = { href: 'a.xhtml', type: 'application/xhtml+xml', locations: { progression: 0.2, cssSelector: 'p:nth-child(3)' } };
    const again = Locator.deserialize(raw as never)!.serialize() as { locations: { cssSelector?: string } };
    expect(again.locations.cssSelector).toBe('p:nth-child(3)');
  });
});

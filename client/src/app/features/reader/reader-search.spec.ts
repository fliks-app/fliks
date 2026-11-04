import { hitsIn, textOfMarkup } from './reader-search';

describe('reader search', () => {
  it('reads the text of a chapter without running it', () => {
    expect(
      textOfMarkup('<html><body><p>Un  phare</p><script>x()</script><p>noir</p></body></html>'),
    ).toContain('Un phare');
  });

  it('finds a word ignoring case and accents, with its context and place', () => {
    const hits = hitsIn(
      'a.xhtml',
      'One',
      'Le brouillard était arrivé. Etait-il parti ?',
      'ETAIT',
      10,
    );
    expect(hits.map((h) => h.match)).toEqual(['était', 'Etait']);
    expect(hits[0].before).toBe('Le brouillard ');
    expect(hits[0].progression).toBeCloseTo(14 / 44, 2);
  });

  it('keeps offsets right after a character outside the BMP', () => {
    const [hit] = hitsIn('a', 'x', 'Un \u{1F4D6} \u00C9t\u00E9 chaud', 'ete', 5);
    expect(hit.match).toBe('\u00C9t\u00E9');
    expect(hit.before).toBe('Un \u{1F4D6} ');
  });

  it('stops at the limit and ignores a query that is too short', () => {
    expect(hitsIn('a', 'x', 'aa aa aa aa', 'aa', 2)).toHaveLength(2);
    expect(hitsIn('a', 'x', 'aa', 'a', 5)).toEqual([]);
  });
});

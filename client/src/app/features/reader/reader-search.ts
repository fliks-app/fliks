export interface SearchHit {
  href: string;
  chapter: string;
  before: string;
  match: string;
  after: string;
  /** Where the match sits in its file, 0..1. */
  progression: number;
}

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_HITS = 200;
const CONTEXT = 40;

/** The text of a chapter: markup parsed as HTML (never run), whitespace folded. */
export function textOfMarkup(markup: string): string {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  return (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** One code point in, one of the same UTF-16 length out, so offsets in the folded text are offsets in the original. */
const fold = (s: string): string =>
  Array.from(s.normalize('NFC'), (c) =>
    String.fromCodePoint(c.normalize('NFD').codePointAt(0)!).toLowerCase(),
  ).join('');

/** Case and accent insensitive matches of `query` in `text`, with the words around each. */
export function hitsIn(
  href: string,
  chapter: string,
  text: string,
  query: string,
  limit: number,
): SearchHit[] {
  const needle = fold(query.trim());
  if (needle.length < SEARCH_MIN_CHARS) return [];
  const source = text.normalize('NFC');
  const hay = fold(source);
  const hits: SearchHit[] = [];
  for (
    let i = hay.indexOf(needle);
    i >= 0 && hits.length < limit;
    i = hay.indexOf(needle, i + needle.length)
  ) {
    hits.push(hitAt(href, chapter, source, i, needle.length));
  }
  return hits;
}

function hitAt(href: string, chapter: string, text: string, at: number, length: number): SearchHit {
  return {
    href,
    chapter,
    before: text.slice(Math.max(0, at - CONTEXT), at),
    match: text.slice(at, at + length),
    after: text.slice(at + length, at + length + CONTEXT),
    progression: text.length ? at / text.length : 0,
  };
}

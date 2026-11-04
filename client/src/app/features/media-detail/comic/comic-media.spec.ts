import type { ComicIssue } from '../../../core/services/api/comics.models';
import type { Media } from '../../../core/services/api/media.service';
import { asComicMedia, nextIssue } from './comic-media';

const issue = (n: number, over: Partial<ComicIssue> = {}): ComicIssue => ({
  itemId: n,
  mediaFileId: n,
  format: 'cbz',
  number: String(n),
  sort: n,
  kind: 'issue',
  annual: false,
  title: null,
  overview: null,
  releaseDate: null,
  pageCount: 20,
  progression: null,
  finished: false,
  ...over,
});

describe('comic media', () => {
  it('only takes a comic that carries its issues', () => {
    expect(asComicMedia({ type: 'comic', comic: { issues: [] } } as unknown as Media)).not.toBeNull();
    expect(asComicMedia({ type: 'comic' } as unknown as Media)).toBeNull();
    expect(asComicMedia({ type: 'book', comic: { issues: [] } } as unknown as Media)).toBeNull();
  });

  it('continues the issue in progress, else starts the first unfinished', () => {
    const issues = [issue(1, { finished: true, progression: 1 }), issue(2), issue(3, { progression: 0.4 })];
    expect(nextIssue(issues)?.itemId).toBe(3);
    expect(nextIssue([issue(1, { finished: true }), issue(2)])?.itemId).toBe(2);
  });

  it('skips issues without a file and keeps annuals for last', () => {
    expect(nextIssue([issue(1, { mediaFileId: null }), issue(2), issue(9, { annual: true, kind: 'annual' })])?.itemId).toBe(2);
    expect(nextIssue([issue(9, { annual: true, kind: 'annual' })])?.itemId).toBe(9);
    expect(nextIssue([issue(1, { mediaFileId: null })])).toBeNull();
  });

  it('falls back to the first main issue when all are read', () => {
    expect(nextIssue([issue(1, { finished: true }), issue(2, { finished: true })])?.itemId).toBe(1);
  });
});

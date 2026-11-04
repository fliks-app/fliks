import type { ComicIssue } from '../../../core/services/api/comics.models';
import { issuePatch, volumePatch } from './comic-edit';

const form = (o: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

const issue: ComicIssue = {
  itemId: 1,
  mediaFileId: 1,
  format: 'cbz',
  number: '1',
  sort: 1,
  kind: 'issue',
  annual: false,
  title: null,
  releaseDate: null,
  pageCount: 20,
  progression: null,
  finished: false,
};

describe('comic edits', () => {
  const now = { title: 'Run', overview: null, comic: { publisher: 'Pub', startYear: 2016, volume: null } };

  it('sends only the volume fields that changed', () => {
    const f = form({ title: 'Run', overview: '', publisher: 'Pub', startYear: '2016', volume: '' });
    expect(volumePatch(f, now)).toEqual({});
    expect(volumePatch(form({ title: ' New ', overview: 'About', publisher: '', startYear: '2015', volume: '2' }), now)).toEqual({
      title: 'New',
      overview: 'About',
      publisher: null,
      startYear: 2015,
      volume: 2,
    });
  });

  it('drops a year that is not a whole number in range', () => {
    expect(volumePatch(form({ title: 'Run', publisher: 'Pub', startYear: '1.5', volume: '' }), now)).toEqual({});
    expect(volumePatch(form({ title: 'Run', publisher: 'Pub', startYear: '', volume: '' }), now)).toEqual({ startYear: null });
  });

  it('sends only the issue fields that changed and refuses a missing number', () => {
    const same = { number: '1', sort: '1', kind: 'issue', title: '', releaseDate: '' };
    expect(issuePatch(form(same), issue)).toEqual({});
    expect(issuePatch(form({ ...same, number: '1.5', sort: '1.5', kind: 'annual', title: 'T', releaseDate: '2020-01-02' }), issue)).toEqual({
      number: '1.5',
      sort: 1.5,
      kind: 'annual',
      title: 'T',
      releaseDate: '2020-01-02',
    });
    expect(issuePatch(form({ ...same, number: '' }), issue)).toBeNull();
    expect(issuePatch(form({ ...same, sort: '' }), issue)).toBeNull();
  });
});

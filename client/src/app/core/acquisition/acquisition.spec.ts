import { aimedWants, acquirable, acquisitionWhen, targetFor } from './acquisition';
import type { Want } from '../services/api/wants-api.service';

const want = (o: Partial<Want>): Want =>
  ({ id: 1, family: 'text', language: null, qualityProfileId: 1, folderId: null, satisfied: false, ...o }) as Want;

describe('acquisition context', () => {
  it('is acquirable when at least one want carries a quality profile, whatever the kind', () => {
    expect(acquirable([])).toBe(false);
    expect(acquirable([want({ qualityProfileId: null })])).toBe(false);
    expect(acquirable([want({ qualityProfileId: null }), want({ family: 'audio' })])).toBe(true);
  });

  it('aims a work at its unsatisfied profiled wants, else at every profiled one', () => {
    const text = want({ id: 1, satisfied: true });
    const audio = want({ id: 2, family: 'audio' });
    const bare = want({ id: 3, family: 'audio', language: 'fr', qualityProfileId: null });
    expect(aimedWants({ level: 'work', wants: [text, audio, bare] })).toEqual([audio]);
    expect(aimedWants({ level: 'work', wants: [text, bare] })).toEqual([text]);
  });

  it('never filters a group or an item on its work satisfaction', () => {
    const done = want({ satisfied: true });
    expect(aimedWants({ level: 'group', wants: [done] })).toEqual([done]);
    expect(aimedWants({ level: 'item', wants: [done] })).toEqual([done]);
  });

  it('feeds the when vocabulary: level, acquirable, and isEpisode only for a series item', () => {
    const base = { wants: [want({})], hasFiles: false, identified: true };
    expect(acquisitionWhen({ ...base, level: 'item' }, 'series')).toMatchObject({ level: 'item', hasQualityProfile: true, isEpisode: true });
    expect(acquisitionWhen({ ...base, level: 'item' }, 'comic').isEpisode).toBe(false);
    expect(acquisitionWhen({ ...base, level: 'work' }, 'series').isEpisode).toBe(false);
  });

  it('aims a base at one want by its family and language', () => {
    const base = { mediaId: 4, kind: 'book' as const, level: 'work' as const };
    expect(targetFor(base, want({ family: 'audio', language: 'fr' }))).toEqual({ ...base, family: 'audio', language: 'fr' });
  });
});

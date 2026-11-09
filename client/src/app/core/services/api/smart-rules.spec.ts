import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CRITERION_TYPES, cleanRules, createPreviewer, criterionValid, defaultRules, newCriterion, rulesValid,
  type Criterion, type PreviewState, type SmartRules,
} from './smart-rules';

const rules = (...criteria: Criterion[]): SmartRules => ({ ...defaultRules(), criteria });

describe('criterion model', () => {
  it('starts every type blank: only the boolean ones are valid', () => {
    const valid = CRITERION_TYPES.filter((t) => criterionValid(newCriterion(t)));
    expect(valid).toEqual(['compilation', 'favourite', 'lossless']);
  });

  it('checks text, bounds and lists', () => {
    expect(criterionValid({ type: 'artist', name: '  ' })).toBe(false);
    expect(criterionValid({ type: 'artist', name: 'x'.repeat(256) })).toBe(false);
    expect(criterionValid({ type: 'artist', name: 'Bowie' })).toBe(true);
    expect(criterionValid({ type: 'year', min: 1990, max: 1980 })).toBe(false);
    expect(criterionValid({ type: 'year', min: 1980 })).toBe(true);
    expect(criterionValid({ type: 'popularity', max: 0.5 })).toBe(true);
    expect(criterionValid({ type: 'popularity', min: -1 })).toBe(false);
    expect(criterionValid({ type: 'lastPlayed', olderThanDays: 30 })).toBe(true);
    expect(criterionValid({ type: 'addedAt' })).toBe(false);
    expect(criterionValid({ type: 'duration', minSeconds: 1.5 })).toBe(false);
    expect(criterionValid({ type: 'codec', codecs: [] })).toBe(false);
    expect(criterionValid({ type: 'library', ids: [2] })).toBe(true);
  });

  it('bounds the rule set', () => {
    expect(rulesValid(rules())).toBe(false);
    expect(rulesValid(rules({ type: 'favourite', value: true }))).toBe(true);
    expect(rulesValid({ ...rules({ type: 'favourite', value: true }), limit: 5001 })).toBe(false);
    expect(rulesValid({ ...rules({ type: 'favourite', value: true }), limit: 50 })).toBe(true);
    expect(rulesValid(rules(...Array.from({ length: 51 }, () => ({ type: 'favourite', value: true }) as Criterion)))).toBe(false);
  });

  it('trims text and drops blank bounds from the body', () => {
    const c = cleanRules(rules({ type: 'artist', name: ' Bowie ' }, { type: 'year', min: 1980, max: undefined })).criteria;
    expect(c).toEqual([{ type: 'artist', name: 'Bowie' }, { type: 'year', min: 1980 }]);
    expect('max' in c[1]).toBe(false);
  });
});

describe('previewer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const ok = rules({ type: 'favourite', value: true });

  it('debounces to one call with the last rules', async () => {
    const fetchCount = vi.fn(async () => 7);
    const states: PreviewState[] = [];
    const p = createPreviewer(fetchCount, (s) => states.push(s), 400);
    p.request(ok);
    p.request({ ...ok, limit: 10 });
    await vi.advanceTimersByTimeAsync(399);
    expect(fetchCount).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCount).toHaveBeenCalledTimes(1);
    expect(fetchCount).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
    expect(states.at(-1)).toEqual({ status: 'ready', count: 7 });
  });

  it('ignores a slow answer overtaken by a newer request', async () => {
    const resolvers: ((n: number) => void)[] = [];
    const fetchCount = vi.fn(() => new Promise<number>((r) => resolvers.push(r)));
    const states: PreviewState[] = [];
    const p = createPreviewer(fetchCount, (s) => states.push(s), 10);
    p.request(ok);
    await vi.advanceTimersByTimeAsync(10);
    p.request({ ...ok, limit: 5 });
    await vi.advanceTimersByTimeAsync(10);
    resolvers[1](2);
    resolvers[0](99);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toEqual({ status: 'ready', count: 2 });
    expect(states.some((s) => s.count === 99)).toBe(false);
  });

  it('goes idle without calling for invalid rules, and cancel silences a pending call', async () => {
    const fetchCount = vi.fn(async () => 1);
    const states: PreviewState[] = [];
    const p = createPreviewer(fetchCount, (s) => states.push(s), 10);
    p.request(rules());
    expect(states.at(-1)).toEqual({ status: 'idle', count: null });
    p.request(ok);
    p.cancel();
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchCount).not.toHaveBeenCalled();
  });
});

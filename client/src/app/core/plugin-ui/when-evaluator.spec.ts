import { evaluateWhen, type WhenContext } from './when-evaluator';

const ctx = (overrides: Partial<WhenContext> = {}): WhenContext => ({
  isAdmin: false,
  hasPermission: () => false,
  isTv: false,
  isTouch: false,
  ...overrides,
});

describe('evaluateWhen', () => {
  it('passes with no when array at all', () => {
    expect(evaluateWhen(undefined, ctx())).toBe(true);
  });

  it('passes with an empty when array', () => {
    expect(evaluateWhen([], ctx())).toBe(true);
  });

  it('requires every predicate to pass (.every semantics)', () => {
    expect(evaluateWhen(['isAdmin', 'isTv'], ctx({ isAdmin: true, isTv: false }))).toBe(false);
    expect(evaluateWhen(['isAdmin', 'isTv'], ctx({ isAdmin: true, isTv: true }))).toBe(true);
  });

  it('delegates hasPermission:<perm> to the context', () => {
    const c = ctx({ hasPermission: (p) => p === 'settings.access' });
    expect(evaluateWhen(['hasPermission:settings.access'], c)).toBe(true);
    expect(evaluateWhen(['hasPermission:users.manage'], c)).toBe(false);
  });

  it('checks mediaType against the context', () => {
    expect(evaluateWhen(['mediaType:movie'], ctx({ mediaType: 'movie' }))).toBe(true);
    expect(evaluateWhen(['mediaType:movie'], ctx({ mediaType: 'series' }))).toBe(false);
    expect(evaluateWhen(['mediaType:series'], ctx({}))).toBe(false);
  });

  it('treats every optional flag as false when the context omits it', () => {
    expect(evaluateWhen(['hasFiles'], ctx())).toBe(false);
    expect(evaluateWhen(['isMonitored'], ctx())).toBe(false);
    expect(evaluateWhen(['hasQualityProfile'], ctx())).toBe(false);
    expect(evaluateWhen(['isEpisode'], ctx())).toBe(false);
  });

  it('negates a known predicate with a leading "!"', () => {
    expect(evaluateWhen(['!isAdmin'], ctx({ isAdmin: false }))).toBe(true);
    expect(evaluateWhen(['!isAdmin'], ctx({ isAdmin: true }))).toBe(false);
  });

  it('reads isTv / isTouch straight off the context', () => {
    expect(evaluateWhen(['isTv'], ctx({ isTv: true }))).toBe(true);
    expect(evaluateWhen(['isTouch'], ctx({ isTouch: true }))).toBe(true);
  });

  // The whole safety property: a manifest naming a predicate this client
  // doesn't know must hide the item, never show it — in either polarity.
  it('VERDICT: an unknown predicate is always false', () => {
    expect(evaluateWhen(['somethingFromTheFuture'], ctx())).toBe(false);
  });

  it('VERDICT: a negated unknown predicate is ALSO false, not true', () => {
    expect(evaluateWhen(['!somethingFromTheFuture'], ctx())).toBe(false);
  });

  it('fails closed for the whole array when one predicate is unknown, even if the rest pass', () => {
    expect(evaluateWhen(['isAdmin', 'somethingFromTheFuture'], ctx({ isAdmin: true }))).toBe(false);
  });
});

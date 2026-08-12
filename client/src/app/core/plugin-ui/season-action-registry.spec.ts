import { resolveSeasonAction, type CoreSeasonActionId, type SeasonActionHandlers } from './season-action-registry';

const ALL_IDS: CoreSeasonActionId[] = ['season.search-releases', 'season.grab-best'];

function fakeHandlers(): SeasonActionHandlers {
  const handlers = {} as SeasonActionHandlers;
  for (const id of ALL_IDS) handlers[id] = () => {};
  return handlers;
}

describe('resolveSeasonAction', () => {
  it('resolves every declared core actionId to its own handler', () => {
    const handlers = fakeHandlers();
    for (const id of ALL_IDS) {
      expect(resolveSeasonAction(id, handlers)).toBe(handlers[id]);
    }
  });

  it('VERDICT: an unknown actionId resolves to null — fail closed, no row rather than a dead click', () => {
    const handlers = fakeHandlers();
    expect(resolveSeasonAction('season.something-a-plugin-made-up', handlers)).toBeNull();
    expect(resolveSeasonAction('', handlers)).toBeNull();
    expect(resolveSeasonAction('season.grab-best-typo', handlers)).toBeNull();
  });
});

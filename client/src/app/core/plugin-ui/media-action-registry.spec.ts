import { resolveMediaAction, type CoreMediaActionId, type MediaActionHandlers } from './media-action-registry';

const ALL_IDS: CoreMediaActionId[] = [
  'media.recommend',
  'media.toggle-series-watched',
  'media.open-tracking',
  'media.request',
  'media.grab-best',
  'media.search-releases',
  'media.edit-profiles',
  'media.edit-library',
  'media.edit-subtitles',
  'media.refresh-metadata',
  'media.identify',
  'media.analyze',
  'media.toggle-monitored',
  'media.delete',
  'media.request-deletion',
];

function fakeHandlers(): MediaActionHandlers {
  const handlers = {} as MediaActionHandlers;
  for (const id of ALL_IDS) handlers[id] = () => {};
  return handlers;
}

describe('resolveMediaAction', () => {
  it('resolves every declared core actionId to its own handler', () => {
    const handlers = fakeHandlers();
    for (const id of ALL_IDS) {
      expect(resolveMediaAction(id, handlers)).toBe(handlers[id]);
    }
  });

  it('VERDICT: an unknown actionId resolves to null — fail closed, no row rather than a dead click', () => {
    const handlers = fakeHandlers();
    expect(resolveMediaAction('media.something-a-plugin-made-up', handlers)).toBeNull();
    expect(resolveMediaAction('', handlers)).toBeNull();
    expect(resolveMediaAction('media.delete-typo', handlers)).toBeNull();
  });
});

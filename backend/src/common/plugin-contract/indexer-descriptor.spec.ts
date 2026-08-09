import { buildIndexerImplementationId, parseIndexerImplementationId } from './indexer-descriptor';

describe('indexer implementation namespacing', () => {
  it('round-trips a plugin id that itself contains the separator', () => {
    const id = buildIndexerImplementationId('fliks.test-plugin', 'mytracker');

    expect(id).toBe('fliks.test-plugin.mytracker');
    expect(parseIndexerImplementationId(id)).toEqual({ pluginId: 'fliks.test-plugin', key: 'mytracker' });
  });

  it('returns null for the legacy plain "torznab" value', () => {
    expect(parseIndexerImplementationId('torznab')).toBeNull();
  });

  it('returns null when there is nothing on one side of the separator', () => {
    expect(parseIndexerImplementationId('.mytracker')).toBeNull();
    expect(parseIndexerImplementationId('fliks.test-plugin.')).toBeNull();
  });
});

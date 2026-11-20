import { describe, expect, it } from 'vitest';
import { pluginUpdates } from './status';

describe('pluginUpdates', () => {
  it('lists each plugin an UpdatePlugins run installed', () => {
    const body = { updated: [{ pluginId: 'a', from: '0.3.1', to: '1.0.0' }, { pluginId: 'b', from: '1', to: '2' }], skipped: [] };
    expect(pluginUpdates({ name: 'UpdatePlugins', body })).toBe('a 0.3.1 → 1.0.0, b 1 → 2');
    expect(pluginUpdates({ name: 'UpdatePlugins', body: { updated: [], skipped: [] } })).toBe('');
  });
  it('ignores other rows and a run without an outcome', () => {
    expect(pluginUpdates({ name: 'RefreshPluginSources', body: { updated: [] } })).toBeNull();
    expect(pluginUpdates({ name: 'UpdatePlugins', body: undefined })).toBeNull();
  });
});

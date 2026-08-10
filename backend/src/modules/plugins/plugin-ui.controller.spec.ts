import { PluginUiController } from './plugin-ui.controller';
import type { RegisteredPlugin } from './plugin-registry.service';
import type { DataPluginManifest, ProcessPluginManifest } from '../../common/plugin-contract';

function dataPlugin(pluginId: string): RegisteredPlugin {
  return {
    pluginId,
    version: '1.0.0',
    kind: 'data',
    manifest: {
      id: pluginId,
      pluginApi: 0,
      name: pluginId,
      version: '1.0.0',
      fliks: '>=1.0.0',
      author: 'x',
      description: 'x',
      license: 'MIT',
      logo: 'logo.svg',
      kind: 'data',
      ui: { contributions: [], configPages: [] },
    } as DataPluginManifest,
    signature: 'unsigned',
    verifiedByKeyId: null,
    archive: Buffer.alloc(0),
  };
}

function processPlugin(pluginId: string): RegisteredPlugin {
  return {
    pluginId,
    version: '1.0.0',
    kind: 'process',
    manifest: {
      id: pluginId,
      pluginApi: 0,
      name: pluginId,
      version: '1.0.0',
      fliks: '>=1.0.0',
      author: 'x',
      description: 'x',
      license: 'MIT',
      logo: 'logo.png',
      kind: 'process',
      runtime: 'node',
      memoryMb: 256,
      files: {},
      database: { schema: false, coreRefs: [] },
      routes: [],
      scopes: [],
      ingestRoots: [],
      ui: {
        contributions: [{ id: 'nav', slot: 'nav.main', weight: 0, labelKey: 'x', action: { kind: 'route', path: '/x' } }],
        configPages: [],
      },
    } as ProcessPluginManifest,
    signature: 'unsigned',
    verifiedByKeyId: null,
    archive: Buffer.alloc(0),
  };
}

function makeController(plugins: RegisteredPlugin[], stateByPluginId: Record<string, string | null> = {}) {
  const registry = {
    list: jest.fn().mockReturnValue(plugins),
    processStateOf: jest.fn((pluginId: string) => stateByPluginId[pluginId] ?? null),
  };
  return { controller: new PluginUiController(registry as never), registry };
}

describe('PluginUiController', () => {
  it('never calls a plugin — only reads the registry\'s cached manifest', () => {
    const { controller, registry } = makeController([dataPlugin('fliks.a')]);

    controller.list();

    expect(Object.keys(registry)).toEqual(['list', 'processStateOf']);
    expect(registry.list).toHaveBeenCalledTimes(1);
  });

  it('includes a data plugin unconditionally — it has no process to be unhealthy', () => {
    const { controller } = makeController([dataPlugin('fliks.a')]);
    const result = controller.list();
    expect(result).toEqual([{ pluginId: 'fliks.a', name: expect.any(String), contributions: [], configPages: [], i18n: {} }]);
  });

  it('passes the manifest i18n dicts through so the client can merge them under core keys', () => {
    const plugin = dataPlugin('fliks.a');
    plugin.manifest.i18n = { en: { 'fliks.a.label': 'Label' }, fr: { 'fliks.a.label': 'Libellé' } };
    const { controller } = makeController([plugin]);

    expect(controller.list()[0].i18n).toEqual({
      en: { 'fliks.a.label': 'Label' },
      fr: { 'fliks.a.label': 'Libellé' },
    });
  });

  it('includes a process plugin whose process is ready, with its contributions', () => {
    const { controller } = makeController([processPlugin('fliks.b')], { 'fliks.b': 'ready' });
    const result = controller.list();
    expect(result).toHaveLength(1);
    expect(result[0].pluginId).toBe('fliks.b');
    expect(result[0].contributions).toHaveLength(1);
  });

  it.each(['crashed', 'degraded', null])('filters out a process plugin whose state is "%s"', (state) => {
    const { controller } = makeController([processPlugin('fliks.b')], { 'fliks.b': state });
    expect(controller.list()).toEqual([]);
  });

  it('mixes a healthy process plugin and a data plugin, filtering only the unhealthy one', () => {
    const { controller } = makeController(
      [dataPlugin('fliks.a'), processPlugin('fliks.b'), processPlugin('fliks.c')],
      { 'fliks.b': 'ready', 'fliks.c': 'crashed' },
    );
    const result = controller.list();
    expect(result.map((r) => r.pluginId)).toEqual(['fliks.a', 'fliks.b']);
  });
});

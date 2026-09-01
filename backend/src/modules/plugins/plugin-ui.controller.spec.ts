import { Logger } from '@nestjs/common';
import { PluginUiController } from './plugin-ui.controller';
import type { RegisteredPlugin } from './plugin-registry.service';
import type { TrustOutcome } from './archive';
import { PLUGIN_API_VERSION } from '../../common/plugin-contract';
import type { DataPluginManifest, ProcessPluginManifest } from '../../common/plugin-contract';

function dataPlugin(
  pluginId: string,
  opts: { i18n?: Record<string, Record<string, string>>; signature?: TrustOutcome } = {},
): RegisteredPlugin {
  return {
    pluginId,
    version: '1.0.0',
    kind: 'data',
    manifest: {
      id: pluginId,
      pluginApi: PLUGIN_API_VERSION,
      name: pluginId,
      version: '1.0.0',
      fliks: '>=1.0.0',
      author: 'x',
      description: 'x',
      license: 'MIT',
      logo: 'logo.svg',
      kind: 'data',
      ui: { contributions: [], configPages: [] },
      i18n: opts.i18n,
    } as DataPluginManifest,
    signature: opts.signature ?? 'unsigned',
    verifiedByKeyId: null,
    archive: Buffer.alloc(0),
  };
}

/** Real key names from the installed manifest, with placeholder values — only the key
 *  set (not the copy) matters to the collision check under test. */
function realKeyDict(keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, 'x']));
}

const REAL_WEBHOOKS_KEYS = [
  'webhooks.config.test',
  'webhooks.config.title',
  'webhooks.config.endpoint_url',
  'webhooks.config.endpoint_url_hint',
];

const REAL_DOWNLOAD_KEYS = [
  'download.jobs.rss_sync',
  'download.media.grab_best',
  'download.config.queue.title',
  'download.config.general.title',
  'download.config.history.title',
  'download.config.indexers.title',
  'download.config.indexers.stats.date',
  'download.config.indexers.stats.avg_response',
  'download.config.download_clients.title',
  'download.config.download_clients.fields.host',
  'download.grab.errors.no_eligible_release',
  'download.download_clients.test.ok',
];

function processPlugin(pluginId: string): RegisteredPlugin {
  return {
    pluginId,
    version: '1.0.0',
    kind: 'process',
    manifest: {
      id: pluginId,
      pluginApi: PLUGIN_API_VERSION,
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
    releasePickerFor: jest.fn().mockReturnValue(undefined),
  };
  return { controller: new PluginUiController(registry as never), registry };
}

describe('PluginUiController', () => {
  it('never calls a plugin — only reads the registry\'s cached manifest', () => {
    const { controller, registry } = makeController([dataPlugin('fliks.a')]);

    controller.list();

    expect(Object.keys(registry)).toEqual(['list', 'processStateOf', 'releasePickerFor']);
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

  it('includes the releasePicker the registry reports for a plugin', () => {
    const picker = {
      movie: { search: '/movie/search', grab: '/movie/grab' },
      season: { search: '/season/search', grab: '/season/grab' },
      episode: { search: '/episode/search', grab: '/episode/grab' },
    };
    const { controller, registry } = makeController([processPlugin('fliks.b')], { 'fliks.b': 'ready' });
    registry.releasePickerFor.mockReturnValue(picker);

    expect(controller.list()[0].releasePicker).toEqual(picker);
    expect(registry.releasePickerFor).toHaveBeenCalledWith('fliks.b');
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

  describe('i18n collisions', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('keeps both plugins when their i18n keys never collide', () => {
      const a = dataPlugin('fliks.a', { i18n: { en: { 'a.label': 'A' } } });
      const b = dataPlugin('fliks.b', { i18n: { en: { 'b.label': 'B' } } });
      const { controller } = makeController([a, b]);

      expect(controller.list().map((r) => r.pluginId)).toEqual(['fliks.a', 'fliks.b']);
    });

    it('drops the plugin that sorts later by id when two plugins declare the exact same key', () => {
      const a = dataPlugin('fliks.a', { i18n: { en: { 'shared.label': 'A' } } });
      const b = dataPlugin('fliks.b', { i18n: { en: { 'shared.label': 'B' } } });
      const { controller } = makeController([b, a]);

      const result = controller.list();
      expect(result.map((r) => r.pluginId)).toEqual(['fliks.a']);
    });

    it('drops the plugin whose key is a dotted-branch descendant of another plugin\'s key', () => {
      const branch = dataPlugin('fliks.a', { i18n: { en: { config: 'A leaf' } } });
      const leaf = dataPlugin('fliks.b', { i18n: { en: { 'config.title': 'B leaf' } } });
      const { controller } = makeController([branch, leaf]);

      expect(controller.list().map((r) => r.pluginId)).toEqual(['fliks.a']);
    });

    it('keeps the official-signed plugin over a colliding non-official one, even when the official id sorts later', () => {
      const attacker = dataPlugin('aaa.evil', { i18n: { en: { 'shared.label': 'evil' } }, signature: 'unverified' });
      const official = dataPlugin('fliks.official', { i18n: { en: { 'shared.label': 'real' } }, signature: 'official' });
      const { controller } = makeController([attacker, official]);

      const result = controller.list();
      expect(result.map((r) => r.pluginId)).toEqual(['fliks.official']);
    });

    it('names the offending key and the plugin it collides with when it refuses one', () => {
      const a = dataPlugin('fliks.a', { i18n: { en: { 'shared.label': 'A' } } });
      const b = dataPlugin('fliks.b', { i18n: { en: { 'shared.label': 'B' } } });
      const { controller } = makeController([a, b]);

      controller.list();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fliks.b'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('shared.label'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fliks.a'));
    });

    it('never refuses a plugin declaring only its own, disjoint namespace', () => {
      const a = dataPlugin('fliks.a', { i18n: { en: { 'a.deep.nested.key': 'value' } } });
      const { controller } = makeController([a]);

      expect(controller.list()).toHaveLength(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('passes the real, installed fliks.webhooks and fliks.download i18n key sets together unchanged', () => {
      const webhooks = dataPlugin('fliks.webhooks', { i18n: { en: realKeyDict(REAL_WEBHOOKS_KEYS) }, signature: 'official' });
      const download = dataPlugin('fliks.download', { i18n: { en: realKeyDict(REAL_DOWNLOAD_KEYS) } });
      const { controller } = makeController([webhooks, download]);

      const result = controller.list();
      expect(result.map((r) => r.pluginId).sort()).toEqual(['fliks.download', 'fliks.webhooks']);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

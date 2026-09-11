import { PluginRegistryService } from './plugin-registry.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { minimalProcessManifest } from './archive/test-manifests';
import { fakeRegistrationRepo, fakeProcessService, fakePluginJobsService, fakeScheduledJobRegistry, fakeCountsCache } from './plugin-registry.test-helpers';
import type { ConfigPage, PluginManifest, UiContribution } from '../../common/plugin-contract';

const COMPATIBLE_RANGE = '>=1.0.0';

const QUEUE_PAGE: ConfigPage = { id: 'queue', kind: 'table', labelKey: 'q', list: '/queue', columns: [] };

function makePackage(manifest: PluginManifest): PluginPackage {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    pluginId: manifest.id,
    version: manifest.version,
    archive: Buffer.alloc(0),
    origin: 'manual',
    signature: 'unsigned',
    verifiedByKeyId: null,
    manifest,
    status: 'active',
  } as PluginPackage;
}

function makeService(): PluginRegistryService {
  return new PluginRegistryService(
    { find: jest.fn().mockResolvedValue([]) } as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    fakeRegistrationRepo() as never,
    fakeProcessService() as never,
    fakePluginJobsService() as never,
    fakeScheduledJobRegistry() as never,
    fakeCountsCache() as never,
    { get: async () => null } as never,
  );
}

function navTo(path: string): UiContribution {
  return { id: 'nav.queue', slot: 'nav.acquisition', weight: 100, labelKey: 'q', action: { kind: 'route', path } };
}

function manifestWith(contributions: UiContribution[], configPages: ConfigPage[] = [QUEUE_PAGE]): PluginManifest {
  return minimalProcessManifest(
    { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) },
    {
      id: 'fliks.a',
      fliks: COMPATIBLE_RANGE,
      routes: [{ method: 'GET', path: '/queue', policy: 'read:Media' }],
      ui: { contributions, configPages },
    },
  ) as unknown as PluginManifest;
}

describe('PluginRegistryService — a contribution may only open a view this manifest declares', () => {
  it.each([
    ['the sidebar prefix', '/plugins/fliks.a/queue'],
    ['the admin settings prefix', '/admin/settings/plugins/fliks.a/queue'],
  ])('accepts a contribution routing to a declared page under %s', async (_label, path) => {
    const result = await makeService().register(makePackage(manifestWith([navTo(path)])));
    expect(result).toEqual({ ok: true, pluginId: 'fliks.a' });
  });

  it('leaves a core route alone — it is not a plugin view', async () => {
    const result = await makeService().register(makePackage(manifestWith([navTo('/requests')])));
    expect(result).toEqual({ ok: true, pluginId: 'fliks.a' });
  });

  it.each([
    ['a page id nothing declares', '/plugins/fliks.a/history'],
    ['another plugin id', '/plugins/fliks.b/queue'],
    ['a deeper path than <pluginId>/<pageId>', '/plugins/fliks.a/queue/1'],
  ])('refuses %s ("%s")', async (_label, path) => {
    const result = await makeService().register(makePackage(manifestWith([navTo(path)])));
    expect(result).toMatchObject({ ok: false, pluginId: 'fliks.a', reason: 'invalid-ui-contribution' });
  });

  it('walks a submenu\'s children, which carry routes of their own', async () => {
    const parent: UiContribution = {
      id: 'group',
      slot: 'media.actions',
      weight: 10,
      labelKey: 'g',
      action: { kind: 'submenu' },
      children: [navTo('/plugins/fliks.a/nosuchpage')],
    };
    const result = await makeService().register(makePackage(manifestWith([parent])));
    expect(result).toMatchObject({ ok: false, reason: 'invalid-ui-contribution' });
  });
});

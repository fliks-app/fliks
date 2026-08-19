import { PluginAutoUpdateService, PLUGIN_AUTO_UPDATE_SETTING } from './plugin-auto-update.service';
import type { PluginPackage } from './entities/plugin-package.entity';
import type { PluginSource } from './entities/plugin-source.entity';

type Report = Record<string, unknown>;

function catalogWith(pluginId: string, versions: string[]) {
  return {
    plugins: [{ id: pluginId, installable: versions.map((version) => ({ version })) }],
    denyList: [],
  };
}

function makeService(opts: {
  setting?: string | null;
  packages?: Partial<PluginPackage>[];
  sources?: Partial<PluginSource>[];
  report?: Report;
  confirmStatus?: 'active' | 'failed';
}) {
  const inspect = jest.fn().mockResolvedValue(
    opts.report ?? { installable: true, stagingId: 's1', sha256: 'abc', signature: 'official' },
  );
  const confirm = jest.fn().mockResolvedValue({
    pluginId: 'x',
    version: '2.0.0',
    status: opts.confirmStatus ?? 'active',
    reason: opts.confirmStatus === 'failed' ? 'spawn refused' : undefined,
  });
  const service = new PluginAutoUpdateService(
    { find: jest.fn().mockResolvedValue(opts.packages ?? []) } as never,
    { find: jest.fn().mockResolvedValue(opts.sources ?? []) } as never,
    { get: jest.fn().mockResolvedValue(opts.setting ?? null) } as never,
    { inspectFromCatalog: inspect, confirmImport: confirm } as never,
  );
  return { service, inspect, confirm };
}

const PKG = [{ pluginId: 'a.plugin', version: '1.0.0' }] as Partial<PluginPackage>[];
const SRC = [{ id: 1, cachedCatalog: catalogWith('a.plugin', ['1.0.0', '2.0.0']) }] as unknown as Partial<PluginSource>[];

describe('PluginAutoUpdateService', () => {
  it('does nothing at all while the setting is off', async () => {
    const { service, inspect } = makeService({ setting: null, packages: PKG, sources: SRC });
    expect(await service.run()).toEqual({ updated: [], skipped: [] });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('reads the opt-in from its own key', async () => {
    const { service } = makeService({ setting: 'true' });
    expect(await service.enabled()).toBe(true);
    expect(PLUGIN_AUTO_UPDATE_SETTING).toBe('plugins.auto_update');
  });

  it('installs the newest offered version when it is newer than the installed one', async () => {
    const { service, inspect, confirm } = makeService({ setting: 'true', packages: PKG, sources: SRC });
    const outcome = await service.run();
    expect(inspect).toHaveBeenCalledWith(SRC[0], 'a.plugin', '2.0.0');
    expect(confirm).toHaveBeenCalledWith({ stagingId: 's1', sha256: 'abc' });
    expect(outcome.updated).toEqual([{ pluginId: 'a.plugin', from: '1.0.0', to: '2.0.0' }]);
  });

  it('leaves an already-current plugin alone', async () => {
    const { service, inspect } = makeService({
      setting: 'true',
      packages: [{ pluginId: 'a.plugin', version: '2.0.0' }] as Partial<PluginPackage>[],
      sources: SRC,
    });
    expect((await service.run()).updated).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('VERDICT: never promotes an archive the catalogue key did not sign', async () => {
    for (const signature of ['unverified', 'unsigned', undefined]) {
      const { service, confirm } = makeService({
        setting: 'true',
        packages: PKG,
        sources: SRC,
        report: { installable: true, stagingId: 's1', sha256: 'abc', signature },
      });
      const outcome = await service.run();
      expect(confirm).not.toHaveBeenCalled();
      expect(outcome.updated).toEqual([]);
      expect(outcome.skipped[0]?.reason).toContain('acknowledgement');
    }
  });

  it('records a refusal instead of installing when the archive is not installable', async () => {
    const { service, confirm } = makeService({
      setting: 'true',
      packages: PKG,
      sources: SRC,
      report: { installable: false, refusalCode: 'PLUGIN_CHECKSUM_MISMATCH' },
    });
    const outcome = await service.run();
    expect(confirm).not.toHaveBeenCalled();
    expect(outcome.skipped[0]?.reason).toBe('PLUGIN_CHECKSUM_MISMATCH');
  });

  it('reports an install that did not activate as skipped, not as updated', async () => {
    const { service } = makeService({ setting: 'true', packages: PKG, sources: SRC, confirmStatus: 'failed' });
    const outcome = await service.run();
    expect(outcome.updated).toEqual([]);
    expect(outcome.skipped[0]?.reason).toBe('spawn refused');
  });

  it('VERDICT: one plugin throwing does not stop the others', async () => {
    const { service } = makeService({
      setting: 'true',
      packages: [
        { pluginId: 'a.plugin', version: '1.0.0' },
        { pluginId: 'b.plugin', version: '1.0.0' },
      ] as Partial<PluginPackage>[],
      sources: [
        {
          id: 1,
          cachedCatalog: {
            plugins: [
              { id: 'a.plugin', installable: [{ version: '2.0.0' }] },
              { id: 'b.plugin', installable: [{ version: '2.0.0' }] },
            ],
            denyList: [],
          },
        },
      ] as unknown as Partial<PluginSource>[],
    });
    const inspect = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ installable: true, stagingId: 's2', sha256: 'def', signature: 'official' });
    (service as unknown as { installService: { inspectFromCatalog: jest.Mock } }).installService.inspectFromCatalog =
      inspect;

    const outcome = await service.run();
    expect(outcome.skipped[0]?.reason).toBe('network down');
    expect(outcome.updated.map((u) => u.pluginId)).toEqual(['b.plugin']);
  });

  it('picks the highest version across sources, not the first source that offers one', async () => {
    const { service, inspect } = makeService({
      setting: 'true',
      packages: PKG,
      sources: [
        { id: 1, cachedCatalog: catalogWith('a.plugin', ['1.5.0']) },
        { id: 2, cachedCatalog: catalogWith('a.plugin', ['3.0.0']) },
      ] as unknown as Partial<PluginSource>[],
    });
    await service.run();
    expect(inspect.mock.calls[0][2]).toBe('3.0.0');
    expect((inspect.mock.calls[0][0] as { id: number }).id).toBe(2);
  });
});

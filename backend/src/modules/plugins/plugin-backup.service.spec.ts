import { PluginBackupService } from './plugin-backup.service';
import { PluginInstallException } from './plugin-install.exception';
import { minimalDataManifest, minimalProcessManifest } from './archive/test-manifests';

function fakePackageRepo(packages: Record<string, unknown>[]) {
  return {
    findOne: jest.fn(async ({ where: { pluginId } }: { where: { pluginId: string } }) => packages.find((p) => p.pluginId === pluginId) ?? null),
    find: jest.fn(async () => packages),
  };
}

function fakePluginDb(overrides: Record<string, jest.Mock> = {}) {
  return {
    exportSchemaRows: jest.fn(async () => ({})),
    schemaHasRows: jest.fn(async () => false),
    restoreSchemaRows: jest.fn(async () => undefined),
    ...overrides,
  };
}

function fakeSettings(all: Record<string, string | null> = {}) {
  return {
    getAll: jest.fn(async () => all),
    set: jest.fn(async () => undefined),
  };
}

function service(packageRepo: unknown, pluginDb: unknown, settings: unknown) {
  return new PluginBackupService(packageRepo as never, pluginDb as never, settings as never);
}

const PROCESS_PKG = {
  pluginId: 'acme.tool',
  version: '1.2.0',
  status: 'active',
  manifest: minimalProcessManifest({}, { id: 'acme.tool', version: '1.2.0', database: { schema: true, coreRefs: [] } }),
};

const DATA_PKG = {
  pluginId: 'acme.notify',
  version: '1.0.0',
  status: 'active',
  manifest: minimalDataManifest({ id: 'acme.notify', version: '1.0.0' }),
};

describe('PluginBackupService.exportPlugin', () => {
  it('404s a plugin id nothing is installed under', async () => {
    const svc = service(fakePackageRepo([]), fakePluginDb(), fakeSettings());
    await expect(svc.exportPlugin('acme.tool')).rejects.toThrow(PluginInstallException);
  });

  it('carries the plugin id, its installed version, its own settings and its schema rows', async () => {
    const pluginDb = fakePluginDb({ exportSchemaRows: jest.fn(async () => ({ notes: [{ id: 1 }] })) });
    const settings = fakeSettings({ 'plugin.acme.tool.apiKey': 'secret', 'other.setting': 'x' });
    const svc = service(fakePackageRepo([PROCESS_PKG]), pluginDb, settings);

    const doc = await svc.exportPlugin('acme.tool');

    expect(doc.pluginId).toBe('acme.tool');
    expect(doc.pluginVersion).toBe('1.2.0');
    expect(doc.settings).toEqual({ 'plugin.acme.tool.apiKey': 'secret' });
    expect(doc.tables).toEqual({ notes: [{ id: 1 }] });
    expect(pluginDb.exportSchemaRows).toHaveBeenCalledWith('acme.tool');
  });

  it('excludes a more specific installed id\'s settings from a shorter id\'s export', async () => {
    const settings = fakeSettings({ 'plugin.acme.toolbox.z': 'z', 'plugin.acme.toolbox.sub.z': 'stolen' });
    const shortPkg = { ...PROCESS_PKG, pluginId: 'acme.toolbox', version: '1.0.0', manifest: minimalDataManifest({ id: 'acme.toolbox' }) };
    const longPkg = { pluginId: 'acme.toolbox.sub', version: '1.0.0', status: 'active', manifest: minimalDataManifest({ id: 'acme.toolbox.sub' }) };
    const svc = service(fakePackageRepo([shortPkg, longPkg]), fakePluginDb(), settings);

    const doc = await svc.exportPlugin('acme.toolbox');

    expect(doc.settings).toEqual({ 'plugin.acme.toolbox.z': 'z' });
  });

  it('never touches the schema for a `data` plugin', async () => {
    const pluginDb = fakePluginDb();
    const svc = service(fakePackageRepo([DATA_PKG]), pluginDb, fakeSettings());

    const doc = await svc.exportPlugin('acme.notify');

    expect(doc.tables).toEqual({});
    expect(pluginDb.exportSchemaRows).not.toHaveBeenCalled();
  });
});

describe('PluginBackupService.importPlugin', () => {
  function exportOf(pkg: typeof PROCESS_PKG, overrides: Record<string, unknown> = {}) {
    return {
      formatVersion: 1,
      pluginId: pkg.pluginId,
      pluginVersion: pkg.version,
      exportedAt: new Date().toISOString(),
      settings: {},
      tables: {},
      ...overrides,
    };
  }

  it('rejects a malformed document before touching the database', async () => {
    const pluginDb = fakePluginDb();
    const svc = service(fakePackageRepo([PROCESS_PKG]), pluginDb, fakeSettings());

    await expect(svc.importPlugin('acme.tool', { not: 'an export' })).rejects.toThrow(PluginInstallException);
    expect(pluginDb.restoreSchemaRows).not.toHaveBeenCalled();
  });

  it('rejects a document exported for a different plugin id', async () => {
    const svc = service(fakePackageRepo([PROCESS_PKG]), fakePluginDb(), fakeSettings());
    const doc = exportOf(PROCESS_PKG, { pluginId: 'someone.else' });

    await expect(svc.importPlugin('acme.tool', doc)).rejects.toThrow(PluginInstallException);
  });

  it('refuses a version mismatch instead of restoring a possibly-incompatible schema', async () => {
    const pluginDb = fakePluginDb();
    const svc = service(fakePackageRepo([PROCESS_PKG]), pluginDb, fakeSettings());
    const doc = exportOf(PROCESS_PKG, { pluginVersion: '1.1.0' });

    await expect(svc.importPlugin('acme.tool', doc)).rejects.toMatchObject({ code: 'PLUGIN_EXPORT_VERSION_MISMATCH' });
    expect(pluginDb.restoreSchemaRows).not.toHaveBeenCalled();
  });

  it('refuses a plugin whose activation never completed, even at a matching version', async () => {
    const notReady = { ...PROCESS_PKG, status: 'failed' };
    const pluginDb = fakePluginDb();
    const svc = service(fakePackageRepo([notReady]), pluginDb, fakeSettings());

    await expect(svc.importPlugin('acme.tool', exportOf(PROCESS_PKG))).rejects.toMatchObject({ code: 'PLUGIN_NOT_READY' });
    expect(pluginDb.restoreSchemaRows).not.toHaveBeenCalled();
  });

  it('refuses to import into a schema that already has rows', async () => {
    const pluginDb = fakePluginDb({ schemaHasRows: jest.fn(async () => true) });
    const svc = service(fakePackageRepo([PROCESS_PKG]), pluginDb, fakeSettings());

    await expect(svc.importPlugin('acme.tool', exportOf(PROCESS_PKG))).rejects.toMatchObject({ code: 'PLUGIN_SCHEMA_NOT_EMPTY' });
    expect(pluginDb.restoreSchemaRows).not.toHaveBeenCalled();
  });

  it('restores rows and settings on a clean, matching-version target', async () => {
    const pluginDb = fakePluginDb();
    const settings = fakeSettings();
    const svc = service(fakePackageRepo([PROCESS_PKG]), pluginDb, settings);
    const doc = exportOf(PROCESS_PKG, {
      settings: { 'plugin.acme.tool.apiKey': 'secret' },
      tables: { notes: [{ id: 1 }] },
    });

    const result = await svc.importPlugin('acme.tool', doc);

    expect(pluginDb.restoreSchemaRows).toHaveBeenCalledWith('acme.tool', { notes: [{ id: 1 }] });
    expect(settings.set).toHaveBeenCalledWith('plugin.acme.tool.apiKey', 'secret', 'plugin-import:acme.tool');
    expect(result).toEqual({ pluginId: 'acme.tool', tablesRestored: { notes: 1 }, settingsRestored: 1 });
  });

  it('rejects a setting key outside the target plugin\'s own namespace', async () => {
    const settings = fakeSettings();
    const svc = service(fakePackageRepo([PROCESS_PKG]), fakePluginDb(), settings);
    const doc = exportOf(PROCESS_PKG, { settings: { 'plugin.someone.else.apiKey': 'x' } });

    await expect(svc.importPlugin('acme.tool', doc)).rejects.toMatchObject({ code: 'PLUGIN_EXPORT_SETTING_OUT_OF_SCOPE' });
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('never calls restoreSchemaRows for a `data` plugin, which has no schema', async () => {
    const pluginDb = fakePluginDb();
    const svc = service(fakePackageRepo([DATA_PKG]), pluginDb, fakeSettings());

    await svc.importPlugin('acme.notify', exportOf(DATA_PKG as never));

    expect(pluginDb.restoreSchemaRows).not.toHaveBeenCalled();
    expect(pluginDb.schemaHasRows).not.toHaveBeenCalled();
  });
});

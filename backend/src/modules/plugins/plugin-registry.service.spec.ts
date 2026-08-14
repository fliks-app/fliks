jest.mock('./supervisor/pid-file', () => ({ sweepOrphans: jest.fn() }));

import { PluginRegistryService } from './plugin-registry.service';
import { PLUGIN_UID_MIN } from './supervisor/spawn-plan';
import { PluginPackage } from './entities/plugin-package.entity';
import { buildZip, ZipEntrySpec } from './archive/zip-builder';
import { generateTestKeypair, signManifestBase64 } from './archive/ed25519-test-keys';
import { minimalDataManifest, minimalProcessManifest } from './archive/test-manifests';
import { svgLogo, pngLogo } from './archive/test-fixtures';
import { OFFICIAL_KEYS } from './archive/trust-store';
import { fakeRegistrationRepo, fakeProcessService, fakePluginJobsService, fakeScheduledJobRegistry, fakeCountsCache } from './plugin-registry.test-helpers';
import { FLIKS_PLUGINS_DISABLED_ENV } from '../../common/constants/plugin-flags';
import { sweepOrphans } from './supervisor/pid-file';
import { getPluginsSocketDir } from '../../common/constants/paths';
import type { PluginManifest, ProcessPluginManifest } from '../../common/plugin-contract';
import type { PluginProcessStartResult } from './plugin-process.service';

const sweepOrphansMock = jest.mocked(sweepOrphans);

/** A `fliks` range every test can rely on matching this repo's own `package.json` version. */
const COMPATIBLE_RANGE = '>=1.0.0 <3.0.0';

function archiveFor(manifest: PluginManifest, extraEntries: ZipEntrySpec[] = []): Buffer {
  const entries: ZipEntrySpec[] = [
    { name: 'plugin.json', content: Buffer.from(JSON.stringify(manifest), 'utf8') },
    ...extraEntries,
  ];
  if (!entries.some((e) => e.name.startsWith('logo.'))) {
    entries.push({ name: manifest.kind === 'process' ? 'logo.png' : 'logo.svg', content: manifest.kind === 'process' ? pngLogo() : svgLogo() });
  }
  return buildZip(entries);
}

function makePackage(manifest: PluginManifest, overrides: Partial<PluginPackage> = {}): PluginPackage {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    pluginId: manifest.id,
    version: manifest.version,
    archive: archiveFor(manifest),
    origin: 'manual',
    signature: 'unsigned',
    verifiedByKeyId: null,
    manifest,
    status: 'active',
    statusReason: null,
    enabled: true,
    ...overrides,
  } as PluginPackage;
}

function repoMock(rows: PluginPackage[] = []) {
  return { find: jest.fn().mockResolvedValue(rows), save: jest.fn(async (row: PluginPackage) => row) };
}

/** Every registry test but boot-load exercises `register()` directly, so the process side is always faked here. */
function makeService(rows: PluginPackage[] = [], processResult: PluginProcessStartResult = { ok: true }) {
  const repo = repoMock(rows);
  const registrationRepo = fakeRegistrationRepo();
  const processService = fakeProcessService(processResult);
  const pluginJobs = fakePluginJobsService();
  const service = new PluginRegistryService(
    repo as never,
    registrationRepo as never,
    processService as never,
    pluginJobs as never,
    fakeScheduledJobRegistry() as never,
    fakeCountsCache() as never,
  );
  return { service, repo, registrationRepo, processService, pluginJobs };
}

describe('PluginRegistryService — boot load', () => {
  const originalEnv = process.env[FLIKS_PLUGINS_DISABLED_ENV];

  beforeEach(() => {
    sweepOrphansMock.mockClear();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[FLIKS_PLUGINS_DISABLED_ENV];
    else process.env[FLIKS_PLUGINS_DISABLED_ENV] = originalEnv;
  });

  it('sweeps orphaned pid files from the sockets dir before anything else, even when plugins are disabled', async () => {
    process.env[FLIKS_PLUGINS_DISABLED_ENV] = '1';
    const { service, repo } = makeService([makePackage(minimalDataManifest({ fliks: COMPATIBLE_RANGE }))]);

    await service.onModuleInit();

    expect(sweepOrphansMock).toHaveBeenCalledWith(getPluginsSocketDir());
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('L0: FLIKS_PLUGINS_DISABLED=1 registers nothing and never queries the repository', async () => {
    process.env[FLIKS_PLUGINS_DISABLED_ENV] = '1';
    const { service, repo } = makeService([makePackage(minimalDataManifest({ fliks: COMPATIBLE_RANGE }))]);

    await service.onModuleInit();

    expect(repo.find).not.toHaveBeenCalled();
    expect(service.list()).toEqual([]);
  });

  it('a boot-time registration failure marks the row failed, so the admin list stops reporting it active', async () => {
    const bad = minimalDataManifest({ id: 'fliks.bootstatusfail', fliks: '>=99.0.0' });
    const pkg = makePackage(bad);
    const { service, repo } = makeService([pkg]);

    await service.onModuleInit();

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: bad.id, status: 'failed', statusReason: expect.stringContaining('incompatible-fliks') }),
    );
  });

  it('a boot-time registration success clears a status left failed by a previous boot', async () => {
    const good = minimalDataManifest({ id: 'fliks.bootstatusclear', fliks: COMPATIBLE_RANGE });
    const pkg = makePackage(good, { status: 'failed', statusReason: 'incompatible-fliks: stale' });
    const { service, repo } = makeService([pkg]);

    await service.onModuleInit();

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ pluginId: good.id, status: 'active', statusReason: null }));
  });

  it('an unexpected exception during registration still marks the row failed', async () => {
    const good = minimalDataManifest({ id: 'fliks.bootstatusthrow', fliks: COMPATIBLE_RANGE });
    const pkg = makePackage(good);
    const { service, repo } = makeService([pkg]);
    jest.spyOn(service, 'register').mockRejectedValueOnce(new Error('boom'));

    await service.onModuleInit();

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ pluginId: good.id, status: 'failed', statusReason: 'boom' }));
  });

  it('boot continues past a failing package and still registers a later valid one', async () => {
    const bad = minimalDataManifest({ id: 'fliks.bad-plugin', fliks: '>=99.0.0' });
    const good = minimalDataManifest({ id: 'fliks.good-plugin', fliks: COMPATIBLE_RANGE });
    const { service } = makeService([makePackage(bad), makePackage(good)]);

    await service.onModuleInit();

    expect(service.get(bad.id)).toBeUndefined();
    expect(service.get(good.id)).toBeDefined();
    expect(service.list()).toHaveLength(1);
  });

  it('a process-tier plugin whose spawn fails does not take boot down, and a later valid plugin still loads', async () => {
    const failing = minimalProcessManifest(
      { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) },
      { id: 'fliks.spawnfails', fliks: COMPATIBLE_RANGE },
    );
    const good = minimalDataManifest({ id: 'fliks.good-plugin', fliks: COMPATIBLE_RANGE });
    const { service } = makeService([makePackage(failing), makePackage(good)], {
      ok: false,
      reason: 'spawn-failed',
      detail: 'never reached ready',
    });

    await service.onModuleInit();

    expect(service.get(failing.id)).toBeUndefined();
    expect(service.get(good.id)).toBeDefined();
    expect(service.list()).toHaveLength(1);
  });

  it('a disabled package is neither started nor registered, and a later enabled one still loads', async () => {
    const disabled = minimalDataManifest({ id: 'fliks.boot-disabled', fliks: COMPATIBLE_RANGE });
    const good = minimalDataManifest({ id: 'fliks.good-plugin', fliks: COMPATIBLE_RANGE });
    const { service } = makeService([makePackage(disabled, { enabled: false }), makePackage(good)]);

    await service.onModuleInit();

    expect(service.get(disabled.id)).toBeUndefined();
    expect(service.get(good.id)).toBeDefined();
    expect(service.list()).toHaveLength(1);
  });

  it('a disabled process-tier package never spawns its supervisor', async () => {
    const manifest = minimalProcessManifest(
      { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) },
      { id: 'fliks.boot-disabled-process', fliks: COMPATIBLE_RANGE },
    );
    const { service, processService } = makeService([makePackage(manifest, { enabled: false })]);

    await service.onModuleInit();

    expect(processService.startFor).not.toHaveBeenCalled();
    expect(service.get(manifest.id)).toBeUndefined();
  });
});

describe('PluginRegistryService.register()', () => {
  afterEach(() => {
    (OFFICIAL_KEYS as Map<string, Buffer>).clear();
  });

  it('registers a valid data-tier package and is idempotent', async () => {
    const manifest = minimalDataManifest({ fliks: COMPATIBLE_RANGE });
    const pkg = makePackage(manifest);
    const { service } = makeService();

    const first = await service.register(pkg);
    const second = await service.register(pkg);

    expect(first).toEqual({ ok: true, pluginId: manifest.id });
    expect(second).toEqual({ ok: true, pluginId: manifest.id });
    expect(service.list()).toHaveLength(1);
    expect(service.get(manifest.id)?.manifest).toEqual(manifest);
  });

  it('L2: does not register when verifiedByKeyId is no longer in the trust store', async () => {
    const { privateKey } = generateTestKeypair();
    const manifest = minimalDataManifest({ fliks: COMPATIBLE_RANGE });
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const sig = signManifestBase64(privateKey, manifestBytes);
    const archive = archiveFor(manifest, [{ name: 'plugin.json.sig', content: Buffer.from(sig, 'utf8') }]);
    const pkg = makePackage(manifest, { archive, signature: 'official', verifiedByKeyId: 'revoked-key' });
    const { service } = makeService();

    const result = await service.register(pkg);

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'untrusted',
      detail: expect.stringContaining('revoked-key'),
    });
    expect(service.get(manifest.id)).toBeUndefined();
  });

  it('L2: registers when verifiedByKeyId is still present and the signature still verifies', async () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    (OFFICIAL_KEYS as Map<string, Buffer>).set('release-2026', rawPublicKey);
    const manifest = minimalDataManifest({ fliks: COMPATIBLE_RANGE });
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const sig = signManifestBase64(privateKey, manifestBytes);
    const archive = archiveFor(manifest, [{ name: 'plugin.json.sig', content: Buffer.from(sig, 'utf8') }]);
    const pkg = makePackage(manifest, { archive, signature: 'official', verifiedByKeyId: 'release-2026' });
    const { service } = makeService();

    const result = await service.register(pkg);

    expect(result).toEqual({ ok: true, pluginId: manifest.id });
  });

  it('L4: does not register when pluginApi differs from PLUGIN_API_VERSION, with its own reason', async () => {
    const manifest = minimalDataManifest({ fliks: COMPATIBLE_RANGE, pluginApi: 99 });
    const pkg = makePackage(manifest);
    const { service } = makeService();

    const result = await service.register(pkg);

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'incompatible-api',
      detail: expect.any(String),
    });
  });

  it('L4: does not register when the fliks range excludes the running version, with its own reason', async () => {
    const manifest = minimalDataManifest({ fliks: '>=99.0.0' });
    const pkg = makePackage(manifest);
    const { service } = makeService();

    const result = await service.register(pkg);

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'incompatible-fliks',
      detail: expect.any(String),
    });
  });

  describe('process tier', () => {
    function processPackage(overrides: Partial<ProcessPluginManifest> = {}) {
      const pluginJs = Buffer.from('module.exports = {};', 'utf8');
      const manifest = minimalProcessManifest(
        { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) },
        { fliks: COMPATIBLE_RANGE, ...overrides },
      );
      const archive = archiveFor(manifest, [{ name: 'plugin.js', content: pluginJs }]);
      return makePackage(manifest, { archive });
    }

    it('registers and spawns a valid process-tier package, seeding its registration row', async () => {
      const pkg = processPackage({ id: 'fliks.processhappy' });
      const { service, registrationRepo, processService } = makeService();

      const result = await service.register(pkg);

      expect(result).toEqual({ ok: true, pluginId: pkg.pluginId });
      expect(processService.startFor).toHaveBeenCalledWith(pkg, PLUGIN_UID_MIN);
      expect(service.get(pkg.pluginId)).toBeDefined();
      const row = registrationRepo.rows.get(pkg.pluginId);
      expect(row).toEqual(
        expect.objectContaining({ pluginId: pkg.pluginId, ingestRoots: [], scopes: ['media:read'] }),
      );
    });

    it('refreshes the cached manifest on a second registration, and resyncs ingestRoots so a narrower upgrade takes effect', async () => {
      const pkg = processPackage({ id: 'fliks.processreload', ingestRoots: ['/media'] });
      const { service, registrationRepo } = makeService();
      await service.register(pkg);
      // Simulates the wider grant a previous, un-narrowed version left on the row.
      registrationRepo.rows.get(pkg.pluginId)!.ingestRoots = ['/media', '/downloads'];

      const second = await service.register(pkg);

      expect(second).toEqual({ ok: true, pluginId: pkg.pluginId });
      const row = registrationRepo.rows.get(pkg.pluginId);
      expect(row?.ingestRoots).toEqual(['/media']);
      expect(row?.manifest).toEqual(pkg.manifest);
    });


    it('propagates a spawn failure reason and registers nothing', async () => {
      const pkg = processPackage({ id: 'fliks.processspawnfail' });
      const { service } = makeService([], { ok: false, reason: 'spawn-failed', detail: 'stderr tail here' });

      const result = await service.register(pkg);

      expect(result).toEqual({
        ok: false,
        pluginId: pkg.pluginId,
        reason: 'spawn-failed',
        detail: 'stderr tail here',
      });
      expect(service.get(pkg.pluginId)).toBeUndefined();
    });
  });
});

describe('PluginRegistryService — i18n namespace claims', () => {
  function withI18n(id: string, key: string) {
    return makePackage(minimalDataManifest({ id, fliks: COMPATIBLE_RANGE, i18n: { en: { [key]: 'Label' } } }));
  }

  it('VERDICT: refuses a second plugin whose i18n root another loaded plugin already claims', async () => {
    const { service } = makeService();

    expect((await service.register(withI18n('acme.one', 'shared.greeting'))).ok).toBe(true);
    const result = await service.register(withI18n('acme.two', 'shared.other'));

    expect(result).toMatchObject({ ok: false, reason: 'i18n-namespace-conflict' });
    if (!result.ok) expect(result.detail).toContain('acme.one');
  });

  it('accepts two plugins under different roots', async () => {
    const { service } = makeService();

    expect((await service.register(withI18n('acme.one', 'one.greeting'))).ok).toBe(true);
    expect((await service.register(withI18n('acme.two', 'two.greeting'))).ok).toBe(true);
  });
});

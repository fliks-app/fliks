import { PluginRegistryService } from './plugin-registry.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { buildZip, ZipEntrySpec } from './archive/zip-builder';
import { generateTestKeypair, signManifestBase64 } from './archive/ed25519-test-keys';
import { minimalDataManifest, minimalProcessManifest } from './archive/test-manifests';
import { svgLogo, pngLogo } from './archive/test-fixtures';
import { OFFICIAL_KEYS } from './archive/trust-store';
import { FLIKS_PLUGINS_DISABLED_ENV } from '../../common/constants/plugin-flags';
import type { PluginManifest } from '../../common/plugin-contract';

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
    ...overrides,
  } as PluginPackage;
}

function repoMock(rows: PluginPackage[] = []) {
  return { find: jest.fn().mockResolvedValue(rows) };
}

describe('PluginRegistryService — boot load', () => {
  const originalEnv = process.env[FLIKS_PLUGINS_DISABLED_ENV];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[FLIKS_PLUGINS_DISABLED_ENV];
    else process.env[FLIKS_PLUGINS_DISABLED_ENV] = originalEnv;
  });

  it('L0: FLIKS_PLUGINS_DISABLED=1 registers nothing and never queries the repository', async () => {
    process.env[FLIKS_PLUGINS_DISABLED_ENV] = '1';
    const repo = repoMock([makePackage(minimalDataManifest({ fliks: COMPATIBLE_RANGE }))]);
    const service = new PluginRegistryService(repo as never);

    await service.onModuleInit();

    expect(repo.find).not.toHaveBeenCalled();
    expect(service.list()).toEqual([]);
  });

  it('boot continues past a failing package and still registers a later valid one', async () => {
    const bad = minimalDataManifest({ id: 'fliks.bad-plugin', fliks: '>=99.0.0' });
    const good = minimalDataManifest({ id: 'fliks.good-plugin', fliks: COMPATIBLE_RANGE });
    const repo = repoMock([makePackage(bad), makePackage(good)]);
    const service = new PluginRegistryService(repo as never);

    await service.onModuleInit();

    expect(service.get(bad.id)).toBeUndefined();
    expect(service.get(good.id)).toBeDefined();
    expect(service.list()).toHaveLength(1);
  });
});

describe('PluginRegistryService.register()', () => {
  afterEach(() => {
    (OFFICIAL_KEYS as Map<string, Buffer>).clear();
  });

  it('registers a valid data-tier package and is idempotent', async () => {
    const manifest = minimalDataManifest({ fliks: COMPATIBLE_RANGE });
    const pkg = makePackage(manifest);
    const service = new PluginRegistryService(repoMock() as never);

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
    const service = new PluginRegistryService(repoMock() as never);

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
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(pkg);

    expect(result).toEqual({ ok: true, pluginId: manifest.id });
  });

  it('L4: does not register when pluginApi differs from PLUGIN_API_VERSION, with its own reason', async () => {
    const manifest = minimalDataManifest({ fliks: COMPATIBLE_RANGE, pluginApi: 99 });
    const pkg = makePackage(manifest);
    const service = new PluginRegistryService(repoMock() as never);

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
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(pkg);

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'incompatible-fliks',
      detail: expect.any(String),
    });
  });

  it('refuses a process-tier package as not supported yet', async () => {
    const pluginJs = Buffer.from('module.exports = {};', 'utf8');
    const manifest = minimalProcessManifest(
      { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) },
      { fliks: COMPATIBLE_RANGE },
    );
    const archive = archiveFor(manifest, [{ name: 'plugin.js', content: pluginJs }]);
    const pkg = makePackage(manifest, { archive });
    const service = new PluginRegistryService(repoMock() as never);

    const result = await service.register(pkg);

    expect(result).toEqual({
      ok: false,
      pluginId: manifest.id,
      reason: 'unsupported-tier',
      detail: expect.any(String),
    });
  });
});

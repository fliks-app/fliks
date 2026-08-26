import axios, { AxiosRequestConfig } from 'axios';
import { PluginCatalogClientService } from './plugin-catalog-client.service';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginPackage } from './entities/plugin-package.entity';
import { generateTestKeypair, signManifestBase64 } from './archive/ed25519-test-keys';
import { OFFICIAL_KEYS } from './archive/trust-store';
import type { CatalogDocument } from './catalog/catalog';
import { PLUGIN_API_VERSION } from '../../common/plugin-contract';

const COMPATIBLE_RANGE = '>=1.0.0';

function fakeSource(overrides: Partial<PluginSource> = {}): PluginSource {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    url: 'https://catalog.example.com/catalog.json',
    enabled: true,
    publicKey: null,
    lastRefreshedAt: null,
    lastRefreshError: null,
    cachedCatalog: null,
    ...overrides,
  } as PluginSource;
}

function catalogWith(versionOverrides: Record<string, unknown> = {}): CatalogDocument {
  return {
    plugins: [
      {
        id: 'fliks.test-plugin',
        name: 'Test plugin',
        description: 'A fixture.',
        author: 'Fliks',
        kind: 'data',
        versions: [
          {
            version: '1.0.0',
            pluginApi: PLUGIN_API_VERSION,
            fliks: COMPATIBLE_RANGE,
            // A version with no verifiable archive is not installable, so a fixture without one
            // describes a row the filter would never offer.
            zipUrl: 'https://example.com/p-1.0.0.fkplugin',
            sha256: 'a'.repeat(64),
            ...versionOverrides,
          },
        ],
      },
    ],
  } as CatalogDocument;
}

function repoStub() {
  const save = jest.fn(async (s: PluginSource) => s);
  return { save } as unknown as { save: jest.Mock };
}

/** No installed packages by default — nothing for `enforceDenyList` to act on. */
function fakePackageRepo(rows: PluginPackage[] = []) {
  return { find: jest.fn(async () => rows), save: jest.fn(async (row: PluginPackage) => row) };
}

function fakeRegistry() {
  return { revoke: jest.fn(async () => undefined) };
}

/** Routes a GET by URL suffix — `catalog.json` and `catalog.json.sig` never collide since
 *  `endsWith` is exact. A value that is an `Error` rejects instead of resolving. */
function adapterFor(responses: Record<string, Buffer | Error>) {
  return (config: AxiosRequestConfig) => {
    const url = String(config.url);
    const entry = Object.entries(responses).find(([suffix]) => url.endsWith(suffix));
    if (!entry) return Promise.reject(new Error(`unexpected request to ${url}`));
    const [, value] = entry;
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve({ data: value, status: 200, statusText: 'OK', headers: {}, config }) as never;
  };
}

describe('PluginCatalogClientService', () => {
  const originalAdapter = axios.defaults.adapter;

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  it('fetches, verifies against the source key, filters and caches a compatible catalog', async () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const doc = catalogWith();
    const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
    const sig = Buffer.from(signManifestBase64(privateKey, bytes), 'utf8');
    axios.defaults.adapter = adapterFor({ 'catalog.json.sig': sig, 'catalog.json': bytes });

    const repo = repoStub();
    const service = new PluginCatalogClientService(repo as never, fakePackageRepo() as never, fakeRegistry() as never);
    const source = fakeSource({ publicKey: rawPublicKey });

    const result = await service.refreshSource(source);

    expect(result).toEqual({ ok: true });
    expect(source.lastRefreshError).toBeNull();
    expect(source.lastRefreshedAt).toBeInstanceOf(Date);
    expect(source.cachedCatalog).toEqual({
      denyList: [],
      signedByKeyId: 'source',
      plugins: [
        expect.objectContaining({
          id: 'fliks.test-plugin',
          installable: [
            expect.objectContaining({ version: '1.0.0', pluginApi: PLUGIN_API_VERSION, fliks: COMPATIBLE_RANGE }),
          ],
          hidden: null,
        }),
      ],
    });
    expect(repo.save).toHaveBeenCalledWith(source);
  });

  it('refuses a catalog whose signature does not verify, and keeps the previous cache', async () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const bytes = Buffer.from(JSON.stringify(catalogWith()), 'utf8');
    const tamperedSig = Buffer.from(signManifestBase64(privateKey, bytes), 'utf8');
    tamperedSig[10] ^= 0xff; // corrupt the signature bytes themselves
    axios.defaults.adapter = adapterFor({ 'catalog.json.sig': tamperedSig, 'catalog.json': bytes });

    const repo = repoStub();
    const service = new PluginCatalogClientService(repo as never, fakePackageRepo() as never, fakeRegistry() as never);
    const previousCatalog = { plugins: [{ id: 'old' }] };
    const source = fakeSource({
      publicKey: rawPublicKey,
      cachedCatalog: previousCatalog,
      lastRefreshedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await service.refreshSource(source);

    expect(result).toEqual({ ok: false, reason: 'bad-signature', detail: expect.any(String) });
    expect(source.cachedCatalog).toBe(previousCatalog);
    expect(source.lastRefreshedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(source.lastRefreshError).toEqual(expect.any(String));
  });

  it('refuses a catalog signed by a key that is not the source’s configured key', async () => {
    const sourceKeypair = generateTestKeypair();
    const attackerKeypair = generateTestKeypair();
    const bytes = Buffer.from(JSON.stringify(catalogWith()), 'utf8');
    const sig = Buffer.from(signManifestBase64(attackerKeypair.privateKey, bytes), 'utf8');
    axios.defaults.adapter = adapterFor({ 'catalog.json.sig': sig, 'catalog.json': bytes });

    const repo = repoStub();
    const service = new PluginCatalogClientService(repo as never, fakePackageRepo() as never, fakeRegistry() as never);
    const source = fakeSource({ publicKey: sourceKeypair.rawPublicKey });

    const result = await service.refreshSource(source);

    expect(result).toEqual({ ok: false, reason: 'bad-signature', detail: expect.any(String) });
    expect(source.cachedCatalog).toBeNull();
  });

  it('falls back to the compiled-in official keys when the source has none configured', async () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const bytes = Buffer.from(JSON.stringify(catalogWith()), 'utf8');
    const sig = Buffer.from(signManifestBase64(privateKey, bytes), 'utf8');
    axios.defaults.adapter = adapterFor({ 'catalog.json.sig': sig, 'catalog.json': bytes });

    const mutableOfficialKeys = OFFICIAL_KEYS as unknown as Map<string, Buffer>;
    mutableOfficialKeys.set('test-official', rawPublicKey);
    try {
      const repo = repoStub();
      const service = new PluginCatalogClientService(repo as never, fakePackageRepo() as never, fakeRegistry() as never);
      const source = fakeSource({ publicKey: null });

      const result = await service.refreshSource(source);

      expect(result).toEqual({ ok: true });
    } finally {
      mutableOfficialKeys.delete('test-official');
    }
  });

  it('hides an incompatible pluginApi version and reports the hidden count and minimum core version', async () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const doc = catalogWith({ pluginApi: PLUGIN_API_VERSION + 1, fliks: '>=5.0.0 <6.0.0' });
    const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
    const sig = Buffer.from(signManifestBase64(privateKey, bytes), 'utf8');
    axios.defaults.adapter = adapterFor({ 'catalog.json.sig': sig, 'catalog.json': bytes });

    const repo = repoStub();
    const service = new PluginCatalogClientService(repo as never, fakePackageRepo() as never, fakeRegistry() as never);
    const source = fakeSource({ publicKey: rawPublicKey });

    await service.refreshSource(source);

    const catalog = source.cachedCatalog as { plugins: { installable: unknown[]; hidden: { count: number; minFliksVersion: string } }[] };
    expect(catalog.plugins[0].installable).toEqual([]);
    expect(catalog.plugins[0].hidden).toEqual({ count: 1, minFliksVersion: '5.0.0' });
  });

  it('stops and marks failed an installed package a landed revocation denies, immediately — not on next reboot', async () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const doc = { ...catalogWith(), denyList: [{ pluginId: 'fliks.test-plugin', reason: 'known credential leak' }] };
    const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
    const sig = Buffer.from(signManifestBase64(privateKey, bytes), 'utf8');
    axios.defaults.adapter = adapterFor({ 'catalog.json.sig': sig, 'catalog.json': bytes });

    // `publicKey` pins this source's verification key to id 'source' — the same id the
    // installed package's `verifiedByKeyId` must carry for the revocation to reach it.
    const pkg = {
      pluginId: 'fliks.test-plugin',
      version: '1.0.0',
      archive: Buffer.from('fake archive bytes'),
      verifiedByKeyId: 'source',
      status: 'active',
      statusReason: null,
    } as PluginPackage;
    const packageRepo = fakePackageRepo([pkg]);
    const registry = fakeRegistry();
    const repo = repoStub();
    const service = new PluginCatalogClientService(repo as never, packageRepo as never, registry as never);
    const source = fakeSource({ publicKey: rawPublicKey });

    const result = await service.refreshSource(source);

    expect(result).toEqual({ ok: true });
    expect(registry.revoke).toHaveBeenCalledWith('fliks.test-plugin', 'known credential leak');
    expect(pkg.status).toBe('failed');
    expect(pkg.statusReason).toBe('revoked: known credential leak');
  });

  it('leaves an installed package alone when the deny-list was signed by a different key', async () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const doc = { ...catalogWith(), denyList: [{ pluginId: 'fliks.test-plugin', reason: 'known credential leak' }] };
    const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
    const sig = Buffer.from(signManifestBase64(privateKey, bytes), 'utf8');
    axios.defaults.adapter = adapterFor({ 'catalog.json.sig': sig, 'catalog.json': bytes });

    // This package was verified by the compiled-in official key, not this source's pinned key.
    const pkg = {
      pluginId: 'fliks.test-plugin',
      version: '1.0.0',
      archive: Buffer.from('fake archive bytes'),
      verifiedByKeyId: 'release-2026',
      status: 'active',
      statusReason: null,
    } as PluginPackage;
    const packageRepo = fakePackageRepo([pkg]);
    const registry = fakeRegistry();
    const repo = repoStub();
    const service = new PluginCatalogClientService(repo as never, packageRepo as never, registry as never);
    const source = fakeSource({ publicKey: rawPublicKey });

    await service.refreshSource(source);

    expect(registry.revoke).not.toHaveBeenCalled();
    expect(pkg.status).toBe('active');
  });

  it('keeps the previous cachedCatalog and records the error on a network failure', async () => {
    axios.defaults.adapter = adapterFor({
      'catalog.json.sig': new Error('ECONNRESET'),
      'catalog.json': new Error('ECONNRESET'),
    });

    const repo = repoStub();
    const service = new PluginCatalogClientService(repo as never, fakePackageRepo() as never, fakeRegistry() as never);
    const previousCatalog = { plugins: [{ id: 'old' }] };
    const previousRefreshedAt = new Date('2026-01-01T00:00:00Z');
    const source = fakeSource({
      publicKey: generateTestKeypair().rawPublicKey,
      cachedCatalog: previousCatalog,
      lastRefreshedAt: previousRefreshedAt,
    });

    const result = await service.refreshSource(source);

    expect(result).toEqual({ ok: false, reason: 'network-error', detail: expect.any(String) });
    expect(source.cachedCatalog).toBe(previousCatalog);
    expect(source.lastRefreshedAt).toBe(previousRefreshedAt);
    expect(source.lastRefreshError).toEqual(expect.any(String));
  });

  it('refuses malformed JSON after a valid signature as a catalog error, without throwing', async () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const bytes = Buffer.from('not valid json{{{', 'utf8');
    const sig = Buffer.from(signManifestBase64(privateKey, bytes), 'utf8');
    axios.defaults.adapter = adapterFor({ 'catalog.json.sig': sig, 'catalog.json': bytes });

    const repo = repoStub();
    const service = new PluginCatalogClientService(repo as never, fakePackageRepo() as never, fakeRegistry() as never);
    const source = fakeSource({ publicKey: rawPublicKey });

    await expect(service.refreshSource(source)).resolves.toEqual({
      ok: false,
      reason: 'malformed-catalog',
      detail: expect.any(String),
    });
  });

  it('refuses a non-https source url before making any request', async () => {
    let requested = false;
    axios.defaults.adapter = (config: AxiosRequestConfig) => {
      requested = true;
      return Promise.reject(new Error(`unexpected request to ${String(config.url)}`)) as never;
    };

    const repo = repoStub();
    const service = new PluginCatalogClientService(repo as never, fakePackageRepo() as never, fakeRegistry() as never);
    const source = fakeSource({ url: 'http://insecure.example.com/catalog.json' });

    const result = await service.refreshSource(source);

    expect(result).toEqual({ ok: false, reason: 'insecure-url', detail: expect.any(String) });
    expect(requested).toBe(false);
  });

  describe('refreshAll (daily cron)', () => {
    it('refreshes every enabled source and never queries a disabled one', async () => {
      const enabledSource = fakeSource({ id: 1, enabled: true });
      const find = jest.fn().mockResolvedValue([enabledSource]);
      const service = new PluginCatalogClientService({ find } as never, fakePackageRepo() as never, fakeRegistry() as never);
      jest.spyOn(service, 'refreshSource').mockResolvedValue({ ok: true });

      await service.refreshAll();

      expect(find).toHaveBeenCalledWith({ where: { enabled: true } });
      expect(service.refreshSource).toHaveBeenCalledWith(enabledSource);
    });

    it('one source throwing does not abort the rest of the run', async () => {
      const bad = fakeSource({ id: 1 });
      const good = fakeSource({ id: 2 });
      const find = jest.fn().mockResolvedValue([bad, good]);
      const service = new PluginCatalogClientService({ find } as never, fakePackageRepo() as never, fakeRegistry() as never);
      jest
        .spyOn(service, 'refreshSource')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ ok: true });

      await service.refreshAll();

      expect(service.refreshSource).toHaveBeenCalledTimes(2);
      expect(service.refreshSource).toHaveBeenLastCalledWith(good);
    });
  });

  describe('boot refresh', () => {
    function serviceWith(sources: PluginSource[]) {
      const find = jest.fn().mockResolvedValue(sources);
      const service = new PluginCatalogClientService({ find } as never, fakePackageRepo() as never, fakeRegistry() as never);
      jest.spyOn(service, 'refreshSource').mockResolvedValue({ ok: true });
      return service;
    }

    // The regression: a migration-seeded source has no cached catalog, so before this
    // the catalogue stayed empty until the 3am job ran.
    it('VERDICT: refreshes a source that has never been fetched', async () => {
      const service = serviceWith([fakeSource({ cachedCatalog: null, lastRefreshedAt: null })]);

      await service.refreshAll({ staleOnly: true });

      expect(service.refreshSource).toHaveBeenCalledTimes(1);
    });

    it('refreshes a cached catalog that has gone stale', async () => {
      const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
      const service = serviceWith([fakeSource({ cachedCatalog: {}, lastRefreshedAt: old })]);

      await service.refreshAll({ staleOnly: true });

      expect(service.refreshSource).toHaveBeenCalledTimes(1);
    });

    // A crash-restart loop must not hammer a public catalog host.
    it('VERDICT: leaves a freshly cached catalog alone, so restarts do not refetch', async () => {
      const recent = new Date(Date.now() - 60 * 1000);
      const service = serviceWith([fakeSource({ cachedCatalog: {}, lastRefreshedAt: recent })]);

      await service.refreshAll({ staleOnly: true });

      expect(service.refreshSource).not.toHaveBeenCalled();
    });

    // Without this the hook could be deleted and every test above would still pass.
    it('VERDICT: the bootstrap hook is what triggers the stale-only refresh', async () => {
      const service = serviceWith([fakeSource({ cachedCatalog: null, lastRefreshedAt: null })]);
      const refreshAll = jest.spyOn(service, 'refreshAll');

      service.onApplicationBootstrap();
      await new Promise((resolve) => setImmediate(resolve));

      expect(refreshAll).toHaveBeenCalledWith({ staleOnly: true });
      expect(service.refreshSource).toHaveBeenCalledTimes(1);
    });

    it('the scheduled run still refetches everything, stale or not', async () => {
      const recent = new Date(Date.now() - 60 * 1000);
      const service = serviceWith([fakeSource({ cachedCatalog: {}, lastRefreshedAt: recent })]);

      await service.refreshAll();

      expect(service.refreshSource).toHaveBeenCalledTimes(1);
    });
  });
});

import axios, { AxiosRequestConfig } from 'axios';
import { createHash } from 'crypto';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PluginInstallService, installedPluginDir } from './plugin-install.service';
import { PluginInstallException } from './plugin-install.exception';
import { PluginStagingService } from './plugin-staging.service';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { PluginSource } from './entities/plugin-source.entity';
import { buildZip, ZipEntrySpec } from './archive/zip-builder';
import { generateTestKeypair, signManifestBase64 } from './archive/ed25519-test-keys';
import { minimalDataManifest } from './archive/test-manifests';
import { svgLogo } from './archive/test-fixtures';
import { getPluginsRuntimeDir } from '../../common/constants/paths';
import { PLUGIN_API_VERSION } from '../../common/plugin-contract';
import type { DataPluginManifest } from '../../common/plugin-contract';

/** A `fliks` range every test can rely on matching this repo's own `package.json` version. */
const COMPATIBLE_RANGE = '>=1.0.0 <3.0.0';

function signedDataArchive(overrides: Partial<DataPluginManifest> = {}): { buffer: Buffer; manifest: DataPluginManifest } {
  const manifest = minimalDataManifest({ fliks: COMPATIBLE_RANGE, ...overrides });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const { privateKey } = generateTestKeypair();
  const sig = signManifestBase64(privateKey, manifestBytes);
  const buffer = buildZip([
    { name: 'plugin.json', content: manifestBytes },
    { name: 'plugin.json.sig', content: Buffer.from(sig, 'utf8') },
    { name: 'logo.svg', content: svgLogo() },
  ]);
  return { buffer, manifest };
}

function tamperedZip(): Buffer {
  // A well-formed archive that `inspect()` refuses on its own — a control
  // character in an entry name — standing in for a directory modified
  // out from under `confirm` by something other than this API.
  const entries: ZipEntrySpec[] = [{ name: 'logo.svg' + String.fromCharCode(0) + '.js', content: svgLogo() }];
  return buildZip(entries);
}

function stagedArchivePath(stagingId: string): string {
  return join(getPluginsRuntimeDir(), 'import-staging', stagingId, 'archive.zip');
}

function fakePackageRepo() {
  const rows = new Map<string, PluginPackage>();
  let nextId = 1;
  return {
    rows,
    findOne: jest.fn(async ({ where: { pluginId } }: { where: { pluginId: string } }) => rows.get(pluginId) ?? null),
    create: jest.fn(
      (partial: Partial<PluginPackage>) =>
        ({ id: nextId++, createdAt: new Date(), updatedAt: new Date(), statusReason: null, ...partial }) as PluginPackage,
    ),
    save: jest.fn(async (row: PluginPackage) => {
      rows.set(row.pluginId, row);
      return row;
    }),
    remove: jest.fn(async (row: PluginPackage) => {
      rows.delete(row.pluginId);
      return row;
    }),
    find: jest.fn(async () => [...rows.values()]),
  };
}

function fakeSource(cachedCatalog: Record<string, unknown> | null): PluginSource {
  return {
    id: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    url: 'https://catalog.example.com/catalog.json',
    enabled: true,
    publicKey: null,
    lastRefreshedAt: null,
    lastRefreshError: null,
    cachedCatalog,
  } as PluginSource;
}

/** Routes a GET by URL suffix, mirroring `plugin-catalog-client.service.spec.ts`'s adapter. */
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

async function expectInstallError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  const err = await promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PluginInstallException);
  expect((err as PluginInstallException).getStatus()).toBe(status);
  expect((err as PluginInstallException).code).toBe(code);
}

describe('PluginInstallService', () => {
  let repo: ReturnType<typeof fakePackageRepo>;
  let registry: PluginRegistryService;
  let staging: PluginStagingService;
  let service: PluginInstallService;
  const originalAdapter = axios.defaults.adapter;

  function stagingRoot(): string {
    return join(getPluginsRuntimeDir(), 'import-staging');
  }

  beforeEach(() => {
    rmSync(stagingRoot(), { recursive: true, force: true });
    rmSync(join(getPluginsRuntimeDir(), 'installed'), { recursive: true, force: true });
    repo = fakePackageRepo();
    registry = new PluginRegistryService(repo as never);
    staging = new PluginStagingService();
    service = new PluginInstallService(repo as never, registry, staging);
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  describe('inspectUpload', () => {
    it('reports a valid signed data archive as installable, with its id/version/trust, and stages it', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.inspect-happy' });

      const report = await service.inspectUpload(buffer);

      expect(report).toEqual(
        expect.objectContaining({
          installable: true,
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          kind: 'data',
          signature: 'unverified',
          compatible: true,
          stagingId: expect.any(String),
          sha256: expect.any(String),
        }),
      );
      expect(existsSync(stagedArchivePath(report.stagingId!))).toBe(true);
    });

    it('refuses a malformed archive with its specific refusal code and stages nothing', async () => {
      const stageSpy = jest.spyOn(staging, 'stage');

      const report = await service.inspectUpload(Buffer.from('not a zip at all'));

      expect(report).toEqual({ installable: false, refusalCode: 'PLUGIN_BAD_MAGIC', detail: expect.any(String) });
      expect(stageSpy).not.toHaveBeenCalled();
    });
  });

  describe('confirmImport', () => {
    it('refuses with a distinct conflict code when the claimed hash no longer matches the staged bytes', async () => {
      const { buffer } = signedDataArchive({ id: 'fliks.confirm-stale' });
      const { stagingId } = await service.inspectUpload(buffer);

      await expectInstallError(
        service.confirmImport({ stagingId: stagingId!, sha256: '0'.repeat(64) }),
        409,
        'PLUGIN_STAGING_STALE',
      );
    });

    it('refuses an unknown staging id', async () => {
      await expectInstallError(
        service.confirmImport({ stagingId: 'f'.repeat(32), sha256: '0'.repeat(64) }),
        404,
        'PLUGIN_STAGING_NOT_FOUND',
      );
    });

    it('re-runs the guards against a fresh read: a directory modified after inspect is caught even when the claimed hash matches the tampered bytes', async () => {
      const { buffer } = signedDataArchive({ id: 'fliks.confirm-tamper' });
      const { stagingId } = await service.inspectUpload(buffer);

      const tampered = tamperedZip();
      writeFileSync(stagedArchivePath(stagingId!), tampered);
      const tamperedSha256 = createHash('sha256').update(tampered).digest('hex');

      // The claimed hash matches exactly what is now on disk — only a second guard
      // pass over the fresh bytes, not the hash check, can catch this.
      await expectInstallError(
        service.confirmImport({ stagingId: stagingId!, sha256: tamperedSha256 }),
        422,
        'PLUGIN_CONTROL_CHAR',
      );
    });

    it('promotes on success: a plugin_packages row exists and the registry has the plugin', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.confirm-promote' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);

      const result = await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });

      expect(result).toEqual({ pluginId: manifest.id, version: manifest.version, status: 'active' });
      expect(repo.rows.get(manifest.id)).toEqual(expect.objectContaining({ status: 'active', pluginId: manifest.id }));
      expect(registry.get(manifest.id)).toBeDefined();
      expect(existsSync(installedPluginDir(manifest.id, manifest.version))).toBe(true);
    });

    it('discards the staging directory after a successful confirm', async () => {
      const { buffer } = signedDataArchive({ id: 'fliks.confirm-discard' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);

      await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });

      expect(existsSync(join(stagingRoot(), stagingId!))).toBe(false);
    });

    it('leaves a failed activation standing: the row is present with its reason, and nothing is registered', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.confirm-incompatible', fliks: '>=99.0.0' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);

      const result = await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });

      expect(result).toEqual({
        pluginId: manifest.id,
        version: manifest.version,
        status: 'failed',
        reason: 'incompatible-fliks',
        detail: expect.any(String),
      });
      const row = repo.rows.get(manifest.id);
      expect(row?.status).toBe('failed');
      expect(row?.statusReason).toContain('incompatible-fliks');
      expect(registry.get(manifest.id)).toBeUndefined();
    });

    it('re-uploading the same archive reuses its staging directory rather than creating a second', async () => {
      const { buffer } = signedDataArchive({ id: 'fliks.reupload' });

      const first = await service.inspectUpload(buffer);
      const second = await service.inspectUpload(buffer);

      expect(second.stagingId).toBe(first.stagingId);
    });
  });

  describe('inspectFromCatalog', () => {
    it('refuses before any guard runs when the fetched archive disagrees with the signed catalog checksum', async () => {
      const { buffer } = signedDataArchive({ id: 'fliks.catalog-mismatch' });
      axios.defaults.adapter = adapterFor({ 'plugin.zip': buffer });
      const source = fakeSource({
        plugins: [
          {
            id: 'fliks.catalog-mismatch',
            installable: [
              {
                version: '1.0.0',
                pluginApi: PLUGIN_API_VERSION,
                fliks: COMPATIBLE_RANGE,
                zipUrl: 'https://cdn.example.com/plugin.zip',
                sha256: '0'.repeat(64),
              },
            ],
          },
        ],
      });

      await expectInstallError(
        service.inspectFromCatalog(source, 'fliks.catalog-mismatch', '1.0.0'),
        422,
        'PLUGIN_CHECKSUM_MISMATCH',
      );
    });

    it('stages, but does not promote, a version whose checksum matches the signed catalog entry', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.catalog-happy', version: '2.0.0' });
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      axios.defaults.adapter = adapterFor({ 'plugin.zip': buffer });
      const source = fakeSource({
        plugins: [
          {
            id: manifest.id,
            installable: [
              { version: manifest.version, pluginApi: PLUGIN_API_VERSION, fliks: COMPATIBLE_RANGE, zipUrl: 'https://cdn.example.com/plugin.zip', sha256 },
            ],
          },
        ],
      });

      const report = await service.inspectFromCatalog(source, manifest.id, manifest.version);

      expect(report).toEqual(
        expect.objectContaining({ installable: true, id: manifest.id, version: manifest.version, stagingId: expect.any(String), sha256 }),
      );
      expect(existsSync(stagedArchivePath(report.stagingId!))).toBe(true);
      expect(registry.get(manifest.id)).toBeUndefined();
    });

    it('refuses an id/version that is not on the source catalog', async () => {
      const source = fakeSource({ plugins: [] });

      await expectInstallError(
        service.inspectFromCatalog(source, 'fliks.unknown', '1.0.0'),
        404,
        'PLUGIN_CATALOG_VERSION_NOT_FOUND',
      );
    });

    it('the two-step flow (inspect then confirm) promotes exactly once, recording the catalog origin', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.catalog-two-step' });
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      axios.defaults.adapter = adapterFor({ 'plugin.zip': buffer });
      const source = fakeSource({
        plugins: [
          {
            id: manifest.id,
            installable: [
              { version: manifest.version, pluginApi: PLUGIN_API_VERSION, fliks: COMPATIBLE_RANGE, zipUrl: 'https://cdn.example.com/plugin.zip', sha256 },
            ],
          },
        ],
      });

      const report = await service.inspectFromCatalog(source, manifest.id, manifest.version);
      expect(registry.get(manifest.id)).toBeUndefined();

      const result = await service.confirmImport({ stagingId: report.stagingId!, sha256: report.sha256! });

      expect(result).toEqual({ pluginId: manifest.id, version: manifest.version, status: 'active' });
      expect(repo.rows.get(manifest.id)).toEqual(expect.objectContaining({ origin: 'catalog', status: 'active' }));
      expect(registry.get(manifest.id)).toBeDefined();
      expect(existsSync(join(stagingRoot(), report.stagingId!))).toBe(false);
    });
  });

  describe('uninstall', () => {
    it('removes the row, the registry entry and the directory; calling it twice is not an error', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.uninstall-me' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);
      await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });
      expect(registry.get(manifest.id)).toBeDefined();

      await service.uninstall(manifest.id);

      expect(repo.rows.has(manifest.id)).toBe(false);
      expect(registry.get(manifest.id)).toBeUndefined();
      expect(existsSync(installedPluginDir(manifest.id, manifest.version))).toBe(false);

      await expect(service.uninstall(manifest.id)).resolves.toBeUndefined();
    });

    it('is safe for a plugin whose row and files never existed', async () => {
      await expect(service.uninstall('fliks.never-installed')).resolves.toBeUndefined();
    });
  });

  describe('listInstalled', () => {
    it('lists every row regardless of status, with the failed one carrying its reason', async () => {
      const { buffer: activeBuf, manifest: activeManifest } = signedDataArchive({ id: 'fliks.list-active' });
      const activeStage = await service.inspectUpload(activeBuf);
      await service.confirmImport({ stagingId: activeStage.stagingId!, sha256: activeStage.sha256! });

      const { buffer: failedBuf, manifest: failedManifest } = signedDataArchive({
        id: 'fliks.list-failed',
        fliks: '>=99.0.0',
      });
      const failedStage = await service.inspectUpload(failedBuf);
      await service.confirmImport({ stagingId: failedStage.stagingId!, sha256: failedStage.sha256! });

      const list = await service.listInstalled();

      expect(list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: activeManifest.id,
            name: activeManifest.name,
            status: 'active',
            statusReason: null,
          }),
          expect.objectContaining({
            pluginId: failedManifest.id,
            status: 'failed',
            statusReason: expect.stringContaining('incompatible-fliks'),
          }),
        ]),
      );
    });
  });
});

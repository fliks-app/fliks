import axios, { AxiosRequestConfig } from 'axios';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PluginInstallService, installedPluginDir } from './plugin-install.service';
import { PluginInstallException } from './plugin-install.exception';
import { PluginStagingService } from './plugin-staging.service';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginUiController } from './plugin-ui.controller';
import { PluginDatabaseService } from './plugin-database.service';
import { fakeRegistrationRepo, fakeProcessService, fakePluginJobsService, fakeScheduledJobRegistry, fakeCountsCache } from './plugin-registry.test-helpers';
import { PluginPackage } from './entities/plugin-package.entity';
import { PluginSource } from './entities/plugin-source.entity';
import { buildZip, ZipEntrySpec } from './archive/zip-builder';
import { generateTestKeypair, signManifestBase64 } from './archive/ed25519-test-keys';
import { minimalDataManifest, minimalProcessManifest } from './archive/test-manifests';
import { pngLogo, sha256Hex, svgLogo } from './archive/test-fixtures';
import { getPluginsRuntimeDir } from '../../common/constants/paths';
import { PLUGIN_API_VERSION } from '../../common/plugin-contract';
import type { DataPluginManifest, ProcessPluginManifest } from '../../common/plugin-contract';

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

function signedProcessArchive(overrides: Partial<ProcessPluginManifest> = {}): { buffer: Buffer; manifest: ProcessPluginManifest } {
  const pluginJs = Buffer.from('module.exports = {};', 'utf8');
  const logo = pngLogo();
  const files = { 'plugin.js': sha256Hex(pluginJs), 'logo.png': sha256Hex(logo) };
  const manifest = minimalProcessManifest(files, { fliks: COMPATIBLE_RANGE, ...overrides });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const { privateKey } = generateTestKeypair();
  const sig = signManifestBase64(privateKey, manifestBytes);
  const buffer = buildZip([
    { name: 'plugin.json', content: manifestBytes },
    { name: 'plugin.json.sig', content: Buffer.from(sig, 'utf8') },
    { name: 'plugin.js', content: pluginJs },
    { name: 'logo.png', content: logo },
  ]);
  return { buffer, manifest };
}

function fakePluginDb() {
  return {
    provision: jest.fn(async () => undefined),
    rotatePassword: jest.fn(async () => null),
    deprovision: jest.fn(async () => undefined),
  };
}

function fakeSettingsService() {
  const rows = new Map<string, string | null>();
  return {
    rows,
    getAll: jest.fn(async () => Object.fromEntries(rows)),
    get: jest.fn(async (key: string) => rows.get(key) ?? null),
    set: jest.fn(async (key: string, value: string | null) => {
      rows.set(key, value);
      return { key, value } as never;
    }),
    delete: jest.fn(async (key: string) => {
      rows.delete(key);
    }),
  };
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
  let registrationRepo: ReturnType<typeof fakeRegistrationRepo>;
  let registry: PluginRegistryService;
  let processService: ReturnType<typeof fakeProcessService>;
  let staging: PluginStagingService;
  let pluginDb: ReturnType<typeof fakePluginDb>;
  let settings: ReturnType<typeof fakeSettingsService>;
  let service: PluginInstallService;
  const originalAdapter = axios.defaults.adapter;

  function stagingRoot(): string {
    return join(getPluginsRuntimeDir(), 'import-staging');
  }

  beforeEach(() => {
    rmSync(stagingRoot(), { recursive: true, force: true });
    rmSync(join(getPluginsRuntimeDir(), 'installed'), { recursive: true, force: true });
    repo = fakePackageRepo();
    // One instance shared by both: the registry writes the registration row and uninstall
    // deletes it, so two separate fakes would make either assertion vacuous.
    registrationRepo = fakeRegistrationRepo();
    processService = fakeProcessService();
    registry = new PluginRegistryService(
      repo as never,
      registrationRepo as never,
      processService as never,
      fakePluginJobsService() as never,
      fakeScheduledJobRegistry() as never,
      fakeCountsCache() as never,
    );
    staging = new PluginStagingService();
    pluginDb = fakePluginDb();
    settings = fakeSettingsService();
    service = new PluginInstallService(
      repo as never,
      registrationRepo as never,
      registry,
      staging,
      pluginDb as unknown as PluginDatabaseService,
      settings as never,
    );
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
  });

  describe('inspectUpload', () => {
    it('reports a valid signed data archive as installable, with its id/version/trust, and stages it', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.inspecthappy' });

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

    it('refuses (never crashes on) a data manifest whose ui.contributions is an object, not an array', async () => {
      const { buffer } = signedDataArchive({
        id: 'fliks.badcontribobj',
        ui: { contributions: { foo: 'bar' } } as unknown as DataPluginManifest['ui'],
      });

      const report = await service.inspectUpload(buffer);

      expect(report).toEqual({ installable: false, refusalCode: 'PLUGIN_BAD_UI_CONTRIBUTIONS', detail: expect.any(String) });
    });

    it('refuses a data manifest whose ui.contributions is a string, rather than fabricating capabilities from its characters', async () => {
      const { buffer } = signedDataArchive({
        id: 'fliks.badcontribstr',
        ui: { contributions: 'not-an-array' } as unknown as DataPluginManifest['ui'],
      });

      const report = await service.inspectUpload(buffer);

      expect(report).toEqual({ installable: false, refusalCode: 'PLUGIN_BAD_UI_CONTRIBUTIONS', detail: expect.any(String) });
    });
  });

  describe('confirmImport', () => {
    it('refuses with a distinct conflict code when the claimed hash no longer matches the staged bytes', async () => {
      const { buffer } = signedDataArchive({ id: 'fliks.confirmstale' });
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
      const { buffer } = signedDataArchive({ id: 'fliks.confirmtamper' });
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
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.confirmpromote' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);

      const result = await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });

      expect(result).toEqual({ pluginId: manifest.id, version: manifest.version, status: 'active' });
      expect(repo.rows.get(manifest.id)).toEqual(expect.objectContaining({ status: 'active', pluginId: manifest.id }));
      expect(registry.get(manifest.id)).toBeDefined();
      expect(existsSync(installedPluginDir(manifest.id, manifest.version))).toBe(true);
    });

    it('discards the staging directory after a successful confirm', async () => {
      const { buffer } = signedDataArchive({ id: 'fliks.confirmdiscard' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);

      await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });

      expect(existsSync(join(stagingRoot(), stagingId!))).toBe(false);
    });

    it('leaves a failed activation standing: the row is present with its reason, and nothing is registered', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.confirmincompatible', fliks: '>=99.0.0' });
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

    it('refuses a data manifest with a malformed shared field (its own re-inspect, bypassing inspectUpload) and never creates a package row', async () => {
      const { buffer, manifest } = signedDataArchive({
        id: 'fliks.confirmbadevents',
        events: { event: 'media.imported', webhook: 'https://example.invalid/hook' } as unknown as DataPluginManifest['events'],
      });
      const { stagingId, sha256 } = staging.stage(buffer);

      await expectInstallError(service.confirmImport({ stagingId, sha256 }), 422, 'PLUGIN_BAD_EVENTS');

      expect(repo.rows.has(manifest.id)).toBe(false);
    });

    it('VERDICT: never leaves an active row behind a register() that throws', async () => {
      const { buffer, manifest } = signedProcessArchive({ id: 'fliks.processregistercrash' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);
      jest.spyOn(registry, 'register').mockRejectedValueOnce(new Error('object is not iterable'));

      const result = await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });

      expect(result).toEqual({
        pluginId: manifest.id,
        version: manifest.version,
        status: 'failed',
        reason: 'register-crashed',
        detail: expect.any(String),
      });
      expect(repo.rows.get(manifest.id)?.status).toBe('failed');
    });

    it('records a deliberate downgrade and installs it, leaving no older directory behind', async () => {
      const { buffer: newer, manifest: newerManifest } = signedDataArchive({ id: 'fliks.downgradeguard', version: '1.1.0' });
      const newerStage = await service.inspectUpload(newer);
      await service.confirmImport({ stagingId: newerStage.stagingId!, sha256: newerStage.sha256! });

      const warn = jest.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
      const { buffer: older } = signedDataArchive({ id: 'fliks.downgradeguard', version: '1.0.0' });
      const olderStage = await service.inspectUpload(older);
      await service.confirmImport({ stagingId: olderStage.stagingId!, sha256: olderStage.sha256! });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('over the newer 1.1.0'));
      expect(repo.rows.get(newerManifest.id)?.version).toBe('1.0.0');
      expect(existsSync(installedPluginDir(newerManifest.id, '1.0.0'))).toBe(true);
      expect(existsSync(installedPluginDir(newerManifest.id, '1.1.0'))).toBe(false);
    });

    it('reinstalling the exact same version still succeeds', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.samereinstall', version: '1.0.0' });
      const first = await service.inspectUpload(buffer);
      await service.confirmImport({ stagingId: first.stagingId!, sha256: first.sha256! });

      const second = await service.inspectUpload(buffer);
      const result = await service.confirmImport({ stagingId: second.stagingId!, sha256: second.sha256! });

      expect(result).toEqual({ pluginId: manifest.id, version: '1.0.0', status: 'active' });
    });

    it('VERDICT: an upgrade removes every older on-disk version of the same id, leaving other plugins untouched', async () => {
      const { buffer: otherBuf, manifest: otherManifest } = signedDataArchive({ id: 'fliks.upgradesweepother', version: '1.0.0' });
      const otherStage = await service.inspectUpload(otherBuf);
      await service.confirmImport({ stagingId: otherStage.stagingId!, sha256: otherStage.sha256! });

      const { buffer: firstBuf } = signedDataArchive({ id: 'fliks.upgradesweep', version: '1.0.0' });
      const firstStage = await service.inspectUpload(firstBuf);
      await service.confirmImport({ stagingId: firstStage.stagingId!, sha256: firstStage.sha256! });

      // A directory no longer named by any row — what an interrupted upgrade leaves behind, and
      // what removing only the immediately-previous version can never reach.
      const stranded = installedPluginDir('fliks.upgradesweep', '0.9.0');
      mkdirSync(stranded, { recursive: true });

      const { buffer: nextBuf } = signedDataArchive({ id: 'fliks.upgradesweep', version: '1.1.0' });
      const nextStage = await service.inspectUpload(nextBuf);
      await service.confirmImport({ stagingId: nextStage.stagingId!, sha256: nextStage.sha256! });

      expect(existsSync(stranded)).toBe(false);
      expect(existsSync(installedPluginDir('fliks.upgradesweep', '1.0.0'))).toBe(false);
      expect(existsSync(installedPluginDir('fliks.upgradesweep', '1.1.0'))).toBe(true);
      expect(existsSync(installedPluginDir(otherManifest.id, '1.0.0'))).toBe(true);
    });
  });

  describe('inspectFromCatalog', () => {
    it('refuses before any guard runs when the fetched archive disagrees with the signed catalog checksum', async () => {
      const { buffer } = signedDataArchive({ id: 'fliks.catalogmismatch' });
      axios.defaults.adapter = adapterFor({ 'plugin.zip': buffer });
      const source = fakeSource({
        plugins: [
          {
            id: 'fliks.catalogmismatch',
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
        service.inspectFromCatalog(source, 'fliks.catalogmismatch', '1.0.0'),
        422,
        'PLUGIN_CHECKSUM_MISMATCH',
      );
    });

    it('stages, but does not promote, a version whose checksum matches the signed catalog entry', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.cataloghappy', version: '2.0.0' });
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
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.catalogtwostep' });
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

  describe('process-tier database provisioning', () => {
    it('provisions before promoting, then activates via the (faked) process service', async () => {
      const { buffer, manifest } = signedProcessArchive({ id: 'fliks.provisionhappy' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);

      const result = await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });

      expect(pluginDb.provision).toHaveBeenCalledWith(expect.objectContaining({ id: manifest.id }));
      expect(result).toEqual({ pluginId: manifest.id, version: manifest.version, status: 'active' });
      expect(existsSync(installedPluginDir(manifest.id, manifest.version))).toBe(true);
      expect(registry.get(manifest.id)).toBeDefined();
    });

    it('purges the staged extraction and never promotes when provisioning fails', async () => {
      const { buffer, manifest } = signedProcessArchive({ id: 'fliks.provisionfails' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);
      pluginDb.provision.mockRejectedValueOnce(new Error('db unreachable'));

      await expect(service.confirmImport({ stagingId: stagingId!, sha256: sha256! })).rejects.toThrow('db unreachable');

      expect(existsSync(installedPluginDir(manifest.id, manifest.version))).toBe(false);
      expect(repo.rows.has(manifest.id)).toBe(false);
    });
  });

  describe('uninstall', () => {
    it('removes the row, the registry entry and the directory; calling it twice is not an error', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.uninstallme' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);
      await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });
      expect(registry.get(manifest.id)).toBeDefined();

      await service.uninstall(manifest.id);

      expect(repo.rows.has(manifest.id)).toBe(false);
      expect(registry.get(manifest.id)).toBeUndefined();
      expect(existsSync(installedPluginDir(manifest.id, manifest.version))).toBe(false);

      await expect(service.uninstall(manifest.id)).resolves.toBeUndefined();
    });

    it('deletes the registration row, so a reinstall cannot inherit consented scopes and ingestRoots', async () => {
      const files = { 'plugin.js': 'a'.repeat(64), 'logo.png': 'b'.repeat(64) };
      const manifest = minimalProcessManifest(files, { id: 'fliks.grantleak', fliks: COMPATIBLE_RANGE });
      registrationRepo.rows.set(manifest.id, {
        pluginId: manifest.id,
        ingestRoots: ['/downloads'],
        scopes: ['media:read'],
        enabled: true,
        manifest,
      } as never);

      await service.uninstall(manifest.id);

      expect(registrationRepo.delete).toHaveBeenCalledWith({ pluginId: manifest.id });
      expect(registrationRepo.rows.has(manifest.id)).toBe(false);
    });

    it('deprovisions a process-tier package before removing its row; skips it for a data-tier one', async () => {
      const { buffer: procBuf, manifest: procManifest } = signedProcessArchive({ id: 'fliks.uninstallprocess' });
      const procStage = await service.inspectUpload(procBuf);
      await service.confirmImport({ stagingId: procStage.stagingId!, sha256: procStage.sha256! });
      const { buffer: dataBuf, manifest: dataManifest } = signedDataArchive({ id: 'fliks.uninstalldata' });
      const dataStage = await service.inspectUpload(dataBuf);
      await service.confirmImport({ stagingId: dataStage.stagingId!, sha256: dataStage.sha256! });

      await service.uninstall(procManifest.id);
      await service.uninstall(dataManifest.id);

      expect(pluginDb.deprovision).toHaveBeenCalledTimes(1);
      expect(pluginDb.deprovision).toHaveBeenCalledWith(procManifest.id);
    });

    it('is safe for a plugin whose row and files never existed', async () => {
      await expect(service.uninstall('fliks.neverinstalled')).resolves.toBeUndefined();
    });

    it('clears every plugin.<id>.* setting on uninstall, secrets included, but leaves other plugins alone', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'fliks.settingsclear' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);
      await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });
      await settings.set(`plugin.${manifest.id}.endpoint_url`, 'https://example.invalid/hook');
      await settings.set(`plugin.${manifest.id}.api_token`, 's3cr3t');
      await settings.set('plugin.fliks.other.endpoint_url', 'https://untouched.invalid');

      await service.uninstall(manifest.id);

      expect(settings.rows.has(`plugin.${manifest.id}.endpoint_url`)).toBe(false);
      expect(settings.rows.has(`plugin.${manifest.id}.api_token`)).toBe(false);
      expect(settings.rows.get('plugin.fliks.other.endpoint_url')).toBe('https://untouched.invalid');
    });

    it('VERDICT: never touches a plugin whose id starts with the uninstalled one', async () => {
      // Ids carry dots, so `plugin.acme.` is a prefix of `plugin.acme.extra.`'s namespace.
      const outer = signedDataArchive({ id: 'acme' });
      const inner = signedDataArchive({ id: 'acme.extra' });
      for (const { buffer } of [outer, inner]) {
        const { stagingId, sha256 } = await service.inspectUpload(buffer);
        await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });
      }
      await settings.set('plugin.acme.endpoint_url', 'https://outer.invalid');
      await settings.set('plugin.acme.extra.api_token', 'inner-s3cr3t');

      await service.uninstall('acme');

      expect(settings.rows.has('plugin.acme.endpoint_url')).toBe(false);
      expect(settings.rows.get('plugin.acme.extra.api_token')).toBe('inner-s3cr3t');
    });

    it('VERDICT: an id nothing is installed under deletes no settings at all', async () => {
      const { buffer, manifest } = signedDataArchive({ id: 'acme.installed' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);
      await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });
      await settings.set(`plugin.${manifest.id}.api_token`, 'keep-me');

      await service.uninstall('acme');

      expect(settings.rows.get(`plugin.${manifest.id}.api_token`)).toBe('keep-me');
    });

    it('clears plugin.<id>.* settings for a process-tier plugin too, on the same footing as data', async () => {
      const { buffer, manifest } = signedProcessArchive({ id: 'fliks.processsettingsclear' });
      const { stagingId, sha256 } = await service.inspectUpload(buffer);
      await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });
      await settings.set(`plugin.${manifest.id}.password`, 'hunter2');

      await service.uninstall(manifest.id);

      expect(settings.rows.has(`plugin.${manifest.id}.password`)).toBe(false);
    });
  });

  describe('listInstalled', () => {
    it('lists every row regardless of status, with the failed one carrying its reason', async () => {
      const { buffer: activeBuf, manifest: activeManifest } = signedDataArchive({ id: 'fliks.listactive' });
      const activeStage = await service.inspectUpload(activeBuf);
      await service.confirmImport({ stagingId: activeStage.stagingId!, sha256: activeStage.sha256! });

      const { buffer: failedBuf, manifest: failedManifest } = signedDataArchive({
        id: 'fliks.listfailed',
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

  describe('disable / enable', () => {
    async function installProcess(overrides: Partial<ProcessPluginManifest> = {}): Promise<ProcessPluginManifest> {
      const { buffer, manifest } = signedProcessArchive(overrides);
      const { stagingId, sha256 } = await service.inspectUpload(buffer);
      await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });
      return manifest;
    }

    async function installData(overrides: Partial<DataPluginManifest> = {}): Promise<DataPluginManifest> {
      const { buffer, manifest } = signedDataArchive(overrides);
      const { stagingId, sha256 } = await service.inspectUpload(buffer);
      await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });
      return manifest;
    }

    it('stops the supervisor and drops the live registration, leaving the row, archive and schema alone', async () => {
      const manifest = await installProcess({ id: 'fliks.disablehappy' });
      expect(registry.get(manifest.id)).toBeDefined();

      const summary = await service.disable(manifest.id);

      expect(summary).toEqual(expect.objectContaining({ pluginId: manifest.id, enabled: false, status: 'active' }));
      expect(processService.stopFor).toHaveBeenCalledWith(manifest.id);
      expect(registry.get(manifest.id)).toBeUndefined();
      expect(repo.rows.get(manifest.id)).toEqual(expect.objectContaining({ enabled: false, status: 'active' }));
      expect(repo.remove).not.toHaveBeenCalled();
      expect(pluginDb.deprovision).not.toHaveBeenCalled();
      expect(existsSync(installedPluginDir(manifest.id, manifest.version))).toBe(true);
    });

    it('VERDICT: an upgrade over a disabled plugin stores the archive and stays off', async () => {
      const manifest = await installProcess({ id: 'fliks.upgradedisabled', version: '1.0.0' });
      await service.disable(manifest.id);
      processService.startFor.mockClear();

      await installProcess({ id: 'fliks.upgradedisabled', version: '1.1.0' });

      const row = repo.rows.get(manifest.id);
      expect(row).toEqual(expect.objectContaining({ version: '1.1.0', enabled: false }));
      // Reactivating behind a version bump would undo the operator's decision in silence.
      expect(registry.get(manifest.id)).toBeUndefined();
      expect(processService.startFor).not.toHaveBeenCalled();
    });

    it('is idempotent: disabling an already-disabled plugin does not stop the supervisor again', async () => {
      const manifest = await installProcess({ id: 'fliks.disabletwice' });
      await service.disable(manifest.id);
      processService.stopFor.mockClear();

      const summary = await service.disable(manifest.id);

      expect(summary.enabled).toBe(false);
      expect(processService.stopFor).not.toHaveBeenCalled();
    });

    it('restores the plugin through the same activation path a boot load takes', async () => {
      const manifest = await installProcess({ id: 'fliks.enablehappy' });
      await service.disable(manifest.id);
      processService.startFor.mockClear();

      const summary = await service.enable(manifest.id);

      expect(summary).toEqual(expect.objectContaining({ pluginId: manifest.id, enabled: true, status: 'active' }));
      expect(processService.startFor).toHaveBeenCalledTimes(1);
      expect(registry.get(manifest.id)).toBeDefined();
    });

    it('is idempotent: enabling an already-enabled plugin does not re-register', async () => {
      const manifest = await installProcess({ id: 'fliks.enabletwice' });
      processService.startFor.mockClear();

      const summary = await service.enable(manifest.id);

      expect(summary.enabled).toBe(true);
      expect(processService.startFor).not.toHaveBeenCalled();
    });

    it('a failed re-activation reports the way it would at boot: enabled, but status failed with the reason', async () => {
      const manifest = await installProcess({ id: 'fliks.enablefails' });
      await service.disable(manifest.id);
      processService.startFor.mockResolvedValueOnce({ ok: false, reason: 'spawn-failed', detail: 'never reached ready' });

      const summary = await service.enable(manifest.id);

      expect(summary).toEqual(
        expect.objectContaining({ enabled: true, status: 'failed', statusReason: expect.stringContaining('spawn-failed') }),
      );
      expect(registry.get(manifest.id)).toBeUndefined();
    });

    it('404s on an unknown plugin id for both routes', async () => {
      await expectInstallError(service.disable('fliks.neverinstalled'), 404, 'PLUGIN_NOT_FOUND');
      await expectInstallError(service.enable('fliks.neverinstalled'), 404, 'PLUGIN_NOT_FOUND');
    });

    it('excludes a disabled plugin from GET /plugins/ui — the controller reads the same registry membership', async () => {
      const manifest = await installData({ id: 'fliks.disableui' });
      const ui = new PluginUiController(registry);
      expect(ui.list().map((r) => r.pluginId)).toContain(manifest.id);

      await service.disable(manifest.id);

      expect(ui.list().map((r) => r.pluginId)).not.toContain(manifest.id);
    });
  });

  describe('restart', () => {
    async function installProcess(overrides: Partial<ProcessPluginManifest> = {}): Promise<ProcessPluginManifest> {
      const { buffer, manifest } = signedProcessArchive(overrides);
      const { stagingId, sha256 } = await service.inspectUpload(buffer);
      await service.confirmImport({ stagingId: stagingId!, sha256: sha256! });
      return manifest;
    }

    it('persists an active status and resolves without throwing when the process comes back up', async () => {
      const manifest = await installProcess({ id: 'fliks.restarthappy' });

      await expect(service.restart(manifest.id)).resolves.toBeUndefined();

      expect(processService.startFor).toHaveBeenCalledWith(expect.objectContaining({ pluginId: manifest.id }));
      expect(repo.rows.get(manifest.id)).toEqual(expect.objectContaining({ status: 'active', statusReason: null }));
    });

    it('VERDICT: refuses to revive a plugin the admin disabled', async () => {
      const manifest = await installProcess({ id: 'fliks.restartdisabled' });
      await service.disable(manifest.id);
      processService.startFor.mockClear();

      await expectInstallError(service.restart(manifest.id), 503, 'PLUGIN_UNAVAILABLE');
      expect(processService.startFor).not.toHaveBeenCalled();
    });

    it('answers 503 and marks the row failed, instead of a silent success, when the restart cannot bring the plugin up', async () => {
      const manifest = await installProcess({ id: 'fliks.restartfails' });
      processService.startFor.mockResolvedValueOnce({ ok: false, reason: 'db-provision-failed', detail: 'role missing' });

      await expectInstallError(service.restart(manifest.id), 503, 'PLUGIN_UNAVAILABLE');

      expect(repo.rows.get(manifest.id)).toEqual(
        expect.objectContaining({ status: 'failed', statusReason: expect.stringContaining('db-provision-failed') }),
      );
    });

    it('404s restarting a plugin that is not installed', async () => {
      await expectInstallError(service.restart('fliks.neverinstalled'), 404, 'PLUGIN_NOT_FOUND');
    });
  });
});

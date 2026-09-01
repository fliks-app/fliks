import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { createHash } from 'crypto';
import { closeSync, fsyncSync, openSync, readdirSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';
import * as semver from 'semver';
import { PluginPackage, PluginPackageOrigin, PluginPackageStatus } from './entities/plugin-package.entity';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginRegistration } from './entities/plugin-registration.entity';
import { PluginRegistryService, CURRENT_FLIKS_VERSION, type PluginRegistrationResult } from './plugin-registry.service';
import { PluginStagingService } from './plugin-staging.service';
import { PluginDatabaseService } from './plugin-database.service';
import { SettingsService } from '../settings/settings.service';
import { PluginInstallException } from './plugin-install.exception';
import { installedPluginDir, pluginDataDir, promoteDir } from './plugin-paths';
import {
  inspect,
  refuse,
  InspectSuccess,
  InspectResult,
  InspectOptions,
  extractToStaging,
  MAX_ARCHIVE_COMPRESSED_BYTES,
  type PluginRefusalCode,
} from './archive';
import { validateManifestShape } from './manifest-shape.validator';
import type { TrustOutcome } from './archive/trust-store';
import { extractCachedDenyList, findDenial, type CatalogVersionEntry, type FilteredCatalog, type FilteredCatalogEntry } from './catalog/catalog';
import { SUPPORTED_PLUGIN_API_VERSIONS, fliksRangeVersion, type PluginKind, type PluginManifest } from '../../common/plugin-contract';
import type { ConfirmImportDto } from './dto/confirm-import.dto';
import type { SupervisorState } from './supervisor/plugin-supervisor';

const ARCHIVE_FETCH_TIMEOUT_MS = 30_000;

/** Admin opt-in to installing unsigned `process` plugins. Off unless the stored value is 'true'. */
export const PLUGIN_ALLOW_UNSIGNED_SETTING = 'plugins.allow_unsigned';

export interface PluginInspectReport {
  installable: boolean;
  refusalCode?: PluginRefusalCode;
  detail?: string;
  stagingId?: string;
  sha256?: string;
  id?: string;
  /** The manifest's human-readable `name` — the consent sheet's copy ("{{name}} runs code…") reads this, never `id`. */
  name?: string;
  version?: string;
  kind?: PluginKind;
  signature?: TrustOutcome;
  signedByKeyId?: string;
  capabilities?: string[];
  /** `pluginApi` exact match + `fliks` range — informational, never blocks staging. */
  compatible?: boolean;
}

export interface PluginInstallResult {
  pluginId: string;
  version: string;
  status: 'active' | 'failed';
  reason?: string;
  detail?: string;
}

/** One row of the admin plugin list — sourced from `plugin_packages`, not the in-memory registry, so a `failed` row still shows up. */
export interface PluginSummary {
  pluginId: string;
  name: string;
  version: string;
  kind: PluginKind;
  origin: PluginPackageOrigin;
  status: PluginPackageStatus;
  statusReason: string | null;
  signature: TrustOutcome;
  verifiedByKeyId: string | null;
  enabled: boolean;
  /** `process` only — `null`/`''` for `data`, which has no supervisor. */
  processState: SupervisorState | null;
  statusMessage: string;
}

export { installedPluginDir, promoteDir };

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Same two checks `PluginRegistryService.register()` runs at L4 — reported here as information only, never a staging gate. */
function isCompatible(manifest: PluginManifest): boolean {
  return (
    SUPPORTED_PLUGIN_API_VERSIONS.includes(manifest.pluginApi) &&
    semver.satisfies(fliksRangeVersion(CURRENT_FLIKS_VERSION), manifest.fliks)
  );
}

/** `zipUrl`/`sha256` are install-pipeline-owned fields on a catalog version entry — see `catalog/catalog.ts`'s doc comment. */
function catalogArchiveInfo(entry: CatalogVersionEntry): { zipUrl: string; sha256: string } | null {
  const { zipUrl, sha256 } = entry as { zipUrl?: unknown; sha256?: unknown };
  if (typeof zipUrl !== 'string' || typeof sha256 !== 'string') return null;
  return { zipUrl, sha256 };
}

function findInstallableVersion(
  cachedCatalog: Record<string, unknown> | null,
  pluginId: string,
  version: string,
): CatalogVersionEntry | null {
  const catalog = cachedCatalog as unknown as FilteredCatalog | null;
  const entry = catalog?.plugins?.find((p: FilteredCatalogEntry) => p.id === pluginId);
  const versionEntry = entry?.installable.find((v) => v.version === version);
  return versionEntry ?? null;
}

/**
 * Orchestrates the install/update/uninstall pipeline for both tiers. `process`
 * archives flow through the same guards and the same promotion — only
 * `PluginRegistryService.register()` tells them apart, provisioning a schema
 * and spawning a supervisor. A spawn failure does not roll back the install.
 */
@Injectable()
export class PluginInstallService {
  private readonly logger = new Logger(PluginInstallService.name);

  constructor(
    @InjectRepository(PluginPackage)
    private readonly packageRepo: Repository<PluginPackage>,
    @InjectRepository(PluginRegistration)
    private readonly registrationRepo: Repository<PluginRegistration>,
    @InjectRepository(PluginSource)
    private readonly sourceRepo: Repository<PluginSource>,
    private readonly registry: PluginRegistryService,
    private readonly staging: PluginStagingService,
    private readonly pluginDb: PluginDatabaseService,
    private readonly settings: SettingsService,
  ) {}

  /** Read live, never cached: an admin flipping it expects the next install to obey it. */
  private async allowUnsigned(): Promise<boolean> {
    return (await this.settings.get(PLUGIN_ALLOW_UNSIGNED_SETTING)) === 'true';
  }

  /** `inspect()` refuses every malformed archive by itself; a throw reaching here is a defect in
   *  core, so it is logged rather than reported as the author's malformed manifest and forgotten. */
  private async safeInspect(buffer: Buffer, options: InspectOptions): Promise<InspectResult> {
    try {
      return await inspect(buffer, options);
    } catch (err) {
      this.logger.error(`inspect() threw instead of refusing: ${(err as Error).message}`);
      return refuse('PLUGIN_BAD_MANIFEST', `plugin.json failed structural validation: ${(err as Error).message}`);
    }
  }

  /** V1-V7 in memory, then stages the raw bytes. Nothing is activated. */
  async inspectUpload(buffer: Buffer): Promise<PluginInspectReport> {
    const result = await this.safeInspect(buffer, { allowUnsigned: await this.allowUnsigned() });
    if (!result.ok) return { installable: false, refusalCode: result.code, detail: result.detail };

    const { stagingId } = this.staging.stage(buffer);
    return this.buildReport(result, stagingId);
  }

  /**
   * Re-runs V1-V7 against a fresh read of the staged bytes — never the
   * buffer inspect() already validated — because a writable directory is
   * not proof of what a second HTTP call will find in it.
   */
  async confirmImport(dto: ConfirmImportDto): Promise<PluginInstallResult> {
    const buffer = this.staging.read(dto.stagingId);
    const actualSha256 = createHash('sha256').update(buffer).digest('hex');
    if (actualSha256 !== dto.sha256) {
      throw new PluginInstallException(
        HttpStatus.CONFLICT,
        'PLUGIN_STAGING_STALE',
        'the staged bytes no longer match the hash the client saw',
      );
    }

    const result = await this.safeInspect(buffer, { allowUnsigned: await this.allowUnsigned() });
    if (!result.ok) {
      throw new PluginInstallException(HttpStatus.UNPROCESSABLE_ENTITY, result.code, result.detail);
    }

    // Origin is recorded at stage time, not trusted from the request: a manual upload and a
    // catalog inspect both land here, and only the staging directory itself says which one it was.
    const origin = this.staging.originFor(dto.stagingId);
    try {
      return await this.promote(buffer, result, origin);
    } finally {
      this.staging.discard(dto.stagingId);
    }
  }

  /**
   * A1 (fetch) + A2 (checksum vs the signed catalog document, before any guard runs), then the
   * same V1-V7 guards as a manual upload, then staging — never promotion. The consent sheet is
   * the only place an *Unverified* plugin gets acknowledged, so a catalog source goes through it
   * too: `POST /plugins/import/confirm` finishes the install, exactly like a manual upload does.
   */
  async inspectFromCatalog(source: PluginSource, pluginId: string, version: string): Promise<PluginInspectReport> {
    const entry = findInstallableVersion(source.cachedCatalog, pluginId, version);
    const info = entry && catalogArchiveInfo(entry);
    if (!info) {
      throw new PluginInstallException(
        HttpStatus.NOT_FOUND,
        'PLUGIN_CATALOG_VERSION_NOT_FOUND',
        `"${pluginId}@${version}" is not an installable version on source #${source.id}`,
      );
    }

    const buffer = await this.fetchArchive(info.zipUrl);

    const actualSha256 = createHash('sha256').update(buffer).digest('hex');
    if (actualSha256 !== info.sha256) {
      throw new PluginInstallException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'PLUGIN_CHECKSUM_MISMATCH',
        'the downloaded archive does not match the signed catalog checksum',
      );
    }

    const result = await this.safeInspect(buffer, { allowUnsigned: await this.allowUnsigned() });
    if (!result.ok) return { installable: false, refusalCode: result.code, detail: result.detail };

    const { stagingId } = this.staging.stage(buffer, 'catalog');
    return this.buildReport(result, stagingId);
  }

  /** Every installed row, active or failed — the admin list reads the table directly for this reason. */
  async listInstalled(): Promise<PluginSummary[]> {
    const packages = await this.packageRepo.find();
    return packages.map((pkg) => this.toSummary(pkg));
  }

  /** Safe to call for a plugin whose row, registry entry or directory is already gone. */
  async uninstall(pluginId: string): Promise<void> {
    await this.registry.forget(pluginId);
    // The registration row carries the consented `scopes` and `ingestRoots`: leaving it behind
    // would let a reinstall silently inherit grants instead of asking for them again.
    await this.registrationRepo.delete({ pluginId });
    const pkg = await this.packageRepo.findOne({ where: { pluginId } });
    if (!pkg) return;
    // Config-page values and anything the plugin wrote via `config.set`, secrets included: a
    // reinstall must ask again rather than inherit them.
    await this.clearPluginSettings(pluginId);
    if (pkg.manifest.kind === 'process') {
      await this.pluginDb.deprovision(pluginId);
    }
    await this.packageRepo.remove(pkg);
    rmSync(installedPluginDir(pkg.pluginId, pkg.version), { recursive: true, force: true });
    // Same reason as the settings wipe above: a reinstall must not inherit what this one wrote.
    rmSync(pluginDataDir(pkg.pluginId), { recursive: true, force: true });
  }

  /** Every `plugin.<id>.*` app setting this plugin owns. Ids contain dots, so one id can be a
   *  prefix of another's namespace — those keys belong to the more specific id, never to this one. */
  private async clearPluginSettings(pluginId: string): Promise<void> {
    const prefix = `plugin.${pluginId}.`;
    const others = (await this.packageRepo.find())
      .map((p) => `plugin.${p.pluginId}.`)
      .filter((p) => p !== prefix && p.startsWith(prefix));
    const all = await this.settings.getAll();
    for (const key of Object.keys(all)) {
      if (!key.startsWith(prefix)) continue;
      if (others.some((p) => key.startsWith(p))) continue;
      await this.settings.delete(key);
    }
  }

  /** Persists the enabled flag on `plugin_registrations` and starts or stops the process to match. */

  /** Clears a tripped circuit breaker and respawns, or cold-starts a plugin that never came
   *  up — persists whichever it turns out to be, and answers 503 rather than a silent success. */
  async restart(pluginId: string): Promise<void> {
    const pkg = await this.findInstalledProcessPlugin(pluginId);
    const result = await this.registry.restartProcess(pkg);
    pkg.status = result.ok ? 'active' : 'failed';
    pkg.statusReason = result.ok ? null : `${result.reason}: ${result.detail}`;
    await this.packageRepo.save(pkg);
    if (!result.ok) {
      throw new PluginInstallException(HttpStatus.SERVICE_UNAVAILABLE, 'PLUGIN_UNAVAILABLE', `${result.reason}: ${result.detail}`);
    }
  }

  /** 404s an id nothing is installed under, for a caller that acts on a plugin without needing
   *  its row. */
  async assertInstalled(pluginId: string): Promise<void> {
    await this.findInstalledPlugin(pluginId);
  }

  /** Idempotent: an already-disabled plugin is returned as-is. Stops the supervisor and drops the
   *  live registration via `unregister()` — the package row, its archive and its schema are untouched. */
  async disable(pluginId: string): Promise<PluginSummary> {
    const pkg = await this.findInstalledPlugin(pluginId);
    if (!pkg.enabled) return this.toSummary(pkg);

    pkg.enabled = false;
    await this.packageRepo.save(pkg);
    await this.registry.unregister(pluginId);
    return this.toSummary(pkg);
  }

  /** Idempotent: an already-enabled plugin is returned as-is. Otherwise re-registers through the
   *  same path a boot load takes, so a failure to come back reports the way it would at boot. */
  async enable(pluginId: string): Promise<PluginSummary> {
    const pkg = await this.findInstalledPlugin(pluginId);
    if (pkg.enabled) return this.toSummary(pkg);

    pkg.enabled = true;
    const result = await this.registry.register(pkg);
    pkg.status = result.ok ? 'active' : 'failed';
    pkg.statusReason = result.ok ? null : `${result.reason}: ${result.detail}`;
    await this.packageRepo.save(pkg);
    return this.toSummary(pkg);
  }

  private async findInstalledPlugin(pluginId: string): Promise<PluginPackage> {
    const pkg = await this.packageRepo.findOne({ where: { pluginId } });
    if (!pkg) throw new PluginInstallException(HttpStatus.NOT_FOUND, 'PLUGIN_NOT_FOUND', `plugin "${pluginId}" is not installed`);
    return pkg;
  }

  private async findInstalledProcessPlugin(pluginId: string): Promise<PluginPackage> {
    const pkg = await this.findInstalledPlugin(pluginId);
    if (pkg.manifest.kind !== 'process') {
      throw new PluginInstallException(HttpStatus.BAD_REQUEST, 'PLUGIN_NOT_PROCESS_TIER', `plugin "${pluginId}" is not a process-tier plugin`);
    }
    return pkg;
  }

  private toSummary(pkg: PluginPackage): PluginSummary {
    const isProcess = pkg.manifest.kind === 'process';
    return {
      pluginId: pkg.pluginId,
      name: pkg.manifest.name,
      version: pkg.version,
      kind: pkg.manifest.kind,
      origin: pkg.origin,
      status: pkg.status,
      statusReason: pkg.statusReason,
      signature: pkg.signature,
      verifiedByKeyId: pkg.verifiedByKeyId,
      enabled: pkg.enabled,
      processState: isProcess ? this.registry.processStateOf(pkg.pluginId) : null,
      statusMessage: isProcess ? this.registry.processStatusMessageOf(pkg.pluginId) : '',
    };
  }

  private buildReport(result: InspectSuccess, stagingId: string): PluginInspectReport {
    return {
      installable: true,
      stagingId,
      sha256: result.sha256,
      id: result.id,
      name: result.manifest.name,
      version: result.version,
      kind: result.kind,
      signature: result.signature,
      signedByKeyId: result.signedByKeyId,
      capabilities: result.capabilities,
      compatible: isCompatible(result.manifest),
    };
  }

  /** P2 (fsync + rename) -> P3 (upsert the row) -> P4a (register). A P4a refusal leaves the row `failed`, install stands. */
  private async promote(buffer: Buffer, result: InspectSuccess, origin: PluginPackageOrigin): Promise<PluginInstallResult> {
    const { manifest } = result;

    if (result.signature === 'unsigned') {
      this.logger.warn(`installing "${manifest.id}" ${manifest.version} unsigned: nothing vouches for its code`);
    }

    const denial = await this.checkDenial(manifest.id, manifest.version, result.sha256, result.signedByKeyId ?? null);
    if (denial) {
      throw new PluginInstallException(HttpStatus.FORBIDDEN, 'PLUGIN_DENIED', denial.reason);
    }

    const existing = await this.packageRepo.findOne({ where: { pluginId: manifest.id } });
    // Going back is a legitimate operator choice and the only rollback there is, so it is recorded
    // rather than refused — the catalogue list is ordered, so it cannot be reached by accident.
    if (existing && semver.lt(manifest.version, existing.version)) {
      this.logger.warn(
        `installing "${manifest.id}" ${manifest.version} over the newer ${existing.version}`,
      );
    }

    const extracted = await extractToStaging(buffer, manifest);
    if (!extracted.ok) {
      throw new PluginInstallException(HttpStatus.UNPROCESSABLE_ENTITY, extracted.code, extracted.detail);
    }

    // P1 before P2: idempotent, so a retry after a later failure just reuses the role.
    if (manifest.kind === 'process') {
      try {
        await this.pluginDb.provision(manifest);
      } catch (err) {
        rmSync(extracted.dir, { recursive: true, force: true });
        throw err;
      }
    }

    const targetDir = installedPluginDir(manifest.id, manifest.version);

    try {
      for (const file of extracted.files) fsyncPath(file.path);
      fsyncPath(extracted.dir);
      promoteDir(extracted.dir, targetDir);
    } catch (err) {
      rmSync(extracted.dir, { recursive: true, force: true });
      throw new PluginInstallException(HttpStatus.INTERNAL_SERVER_ERROR, 'PLUGIN_PROMOTE_FAILED', (err as Error).message);
    }

    let saved: PluginPackage;
    try {
      // A fresh install always starts enabled; an upgrade keeps whatever the admin last chose.
      const row = existing ?? this.packageRepo.create({ pluginId: manifest.id, enabled: true });
      row.version = manifest.version;
      row.archive = buffer;
      row.origin = origin;
      row.signature = result.signature;
      row.verifiedByKeyId = result.signedByKeyId ?? null;
      row.manifest = manifest;
      row.status = 'active';
      row.statusReason = null;
      saved = await this.packageRepo.save(row);
    } catch (err) {
      rmSync(targetDir, { recursive: true, force: true });
      throw new PluginInstallException(HttpStatus.INTERNAL_SERVER_ERROR, 'PLUGIN_INSTALL_FAILED', (err as Error).message);
    }

    this.removeOtherVersionDirs(saved.pluginId, targetDir);

    // An upgrade over a disabled plugin stores the new archive and stays off: reactivating it
    // silently would undo the operator's decision behind a version bump.
    if (!saved.enabled) {
      this.logger.log(`plugin "${saved.pluginId}" upgraded while disabled — not activated`);
      return { pluginId: saved.pluginId, version: saved.version, status: 'active' };
    }

    // The row above is already `active`: a throw here — a shape `register()` doesn't guard
    // against — must still land it on `failed`, never leave it active behind an exception.
    let registration: PluginRegistrationResult;
    try {
      registration = await this.registry.register(saved);
    } catch (err) {
      const detail = (err as Error).message;
      saved.status = 'failed';
      saved.statusReason = `register-crashed: ${detail}`;
      await this.packageRepo.save(saved);
      this.logger.warn(`plugin "${saved.pluginId}" installed but not activated (register-crashed): ${detail}`);
      return { pluginId: saved.pluginId, version: saved.version, status: 'failed', reason: 'register-crashed', detail };
    }
    if (!registration.ok) {
      saved.status = 'failed';
      saved.statusReason = `${registration.reason}: ${registration.detail}`;
      await this.packageRepo.save(saved);
      this.logger.warn(`plugin "${saved.pluginId}" installed but not activated (${registration.reason}): ${registration.detail}`);
      return { pluginId: saved.pluginId, version: saved.version, status: 'failed', reason: registration.reason, detail: registration.detail };
    }

    return { pluginId: saved.pluginId, version: saved.version, status: 'active' };
  }

  /** Removes every other on-disk version of this plugin id, e.g. leftovers from upgrades before this
   *  guard existed. `installedPluginDir(id, '')` gives the exact `<id>@` prefix — never hand-built,
   *  so an id that is a dot-prefix of another one's (`acme` vs `acme.hello`) can't collide. */
  private removeOtherVersionDirs(pluginId: string, keepDir: string): void {
    const root = dirname(keepDir);
    const prefix = basename(installedPluginDir(pluginId, ''));
    const keepName = basename(keepDir);
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === keepName || !entry.startsWith(prefix)) continue;
      rmSync(join(root, entry), { recursive: true, force: true });
    }
  }

  /** Every enabled catalog source's cached deny-list, checked against the package this install
   *  would produce — before anything is written to disk or to `plugin_packages`. */
  private async checkDenial(
    pluginId: string,
    version: string,
    sha256: string,
    verifiedByKeyId: string | null,
  ): Promise<{ reason: string } | null> {
    const sources = await this.sourceRepo.find({ where: { enabled: true } });
    return findDenial(
      { pluginId, version, sha256, verifiedByKeyId },
      sources.map((s) => extractCachedDenyList(s.cachedCatalog)),
    );
  }

  private async fetchArchive(zipUrl: string): Promise<Buffer> {
    let url: URL;
    try {
      url = new URL(zipUrl);
    } catch {
      throw new PluginInstallException(HttpStatus.BAD_GATEWAY, 'PLUGIN_FETCH_FAILED', `invalid archive URL "${zipUrl}"`);
    }
    if (url.protocol !== 'https:') {
      throw new PluginInstallException(HttpStatus.BAD_GATEWAY, 'PLUGIN_FETCH_FAILED', 'archive URL must be https');
    }

    try {
      const res = await axios.get<ArrayBuffer>(url.toString(), {
        responseType: 'arraybuffer',
        timeout: ARCHIVE_FETCH_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: MAX_ARCHIVE_COMPRESSED_BYTES,
        headers: { 'User-Agent': 'Fliks-Plugin-Installer/1.0' },
      });
      return Buffer.from(res.data);
    } catch (err) {
      if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') {
        throw new PluginInstallException(HttpStatus.GATEWAY_TIMEOUT, 'PLUGIN_FETCH_TIMEOUT', 'archive download timed out');
      }
      if (axios.isAxiosError(err) && /maxContentLength/i.test(err.message)) {
        throw new PluginInstallException(HttpStatus.PAYLOAD_TOO_LARGE, 'PLUGIN_FETCH_TOO_LARGE', err.message);
      }
      throw new PluginInstallException(HttpStatus.BAD_GATEWAY, 'PLUGIN_FETCH_FAILED', (err as Error).message);
    }
  }
}

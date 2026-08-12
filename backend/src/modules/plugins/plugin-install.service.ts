import { Injectable, Logger, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { createHash } from 'crypto';
import { closeSync, existsSync, fsyncSync, openSync, rmSync } from 'fs';
import * as semver from 'semver';
import { PluginPackage, PluginPackageOrigin, PluginPackageStatus } from './entities/plugin-package.entity';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginRegistration } from './entities/plugin-registration.entity';
import { PluginRegistryService, CURRENT_FLIKS_VERSION } from './plugin-registry.service';
import { PluginStagingService } from './plugin-staging.service';
import { PluginDatabaseService } from './plugin-database.service';
import { PluginInstallException } from './plugin-install.exception';
import { installedPluginDir, promoteDir } from './plugin-paths';
import { unsignedProcessAllowlist } from '../../common/constants/plugin-flags';
import { inspect, InspectSuccess, extractToStaging, MAX_ARCHIVE_COMPRESSED_BYTES, type PluginRefusalCode } from './archive';
import type { TrustOutcome } from './archive/trust-store';
import type { CatalogVersionEntry, FilteredCatalog, FilteredCatalogEntry } from './catalog/catalog';
import { PLUGIN_API_VERSION, type PluginKind, type PluginManifest } from '../../common/plugin-contract';
import type { ConfirmImportDto } from './dto/confirm-import.dto';
import type { SupervisorState } from './supervisor/plugin-supervisor';

const ARCHIVE_FETCH_TIMEOUT_MS = 30_000;

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
  return manifest.pluginApi === PLUGIN_API_VERSION && semver.satisfies(CURRENT_FLIKS_VERSION, manifest.fliks);
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
    private readonly registry: PluginRegistryService,
    private readonly staging: PluginStagingService,
    private readonly pluginDb: PluginDatabaseService,
  ) {}

  /** V1-V7 in memory, then stages the raw bytes. Nothing is activated. */
  async inspectUpload(buffer: Buffer): Promise<PluginInspectReport> {
    const result = await inspect(buffer, { unsignedProcessAllowlist: unsignedProcessAllowlist() });
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

    const result = await inspect(buffer, { unsignedProcessAllowlist: unsignedProcessAllowlist() });
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

    const result = await inspect(buffer, { unsignedProcessAllowlist: unsignedProcessAllowlist() });
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
    if (pkg.manifest.kind === 'process') {
      await this.pluginDb.deprovision(pluginId);
    }
    await this.packageRepo.remove(pkg);
    rmSync(installedPluginDir(pkg.pluginId, pkg.version), { recursive: true, force: true });
  }

  /** Persists the enabled flag on `plugin_registrations` and starts or stops the process to match. */
  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginSummary> {
    const pkg = await this.findInstalledProcessPlugin(pluginId);
    const result = await this.registry.setEnabled(pkg, enabled);
    pkg.status = result.ok ? 'active' : 'failed';
    pkg.statusReason = result.ok ? null : `${result.reason}: ${result.detail}`;
    await this.packageRepo.save(pkg);
    return this.toSummary(pkg);
  }

  /** Clears a tripped circuit breaker and respawns. */
  async restart(pluginId: string): Promise<void> {
    await this.findInstalledProcessPlugin(pluginId);
    await this.registry.restartProcess(pluginId);
  }

  private async findInstalledProcessPlugin(pluginId: string): Promise<PluginPackage> {
    const pkg = await this.packageRepo.findOne({ where: { pluginId } });
    if (!pkg) throw new PluginInstallException(HttpStatus.NOT_FOUND, 'PLUGIN_NOT_FOUND', `plugin "${pluginId}" is not installed`);
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

    const existing = await this.packageRepo.findOne({ where: { pluginId: manifest.id } });
    const targetDir = installedPluginDir(manifest.id, manifest.version);
    const previousDir =
      existing && existing.version !== manifest.version ? installedPluginDir(existing.pluginId, existing.version) : null;

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
      const row = existing ?? this.packageRepo.create({ pluginId: manifest.id });
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

    if (previousDir && existsSync(previousDir)) rmSync(previousDir, { recursive: true, force: true });

    const registration = await this.registry.register(saved);
    if (!registration.ok) {
      saved.status = 'failed';
      saved.statusReason = `${registration.reason}: ${registration.detail}`;
      await this.packageRepo.save(saved);
      this.logger.warn(`plugin "${saved.pluginId}" installed but not activated (${registration.reason}): ${registration.detail}`);
      return { pluginId: saved.pluginId, version: saved.version, status: 'failed', reason: registration.reason, detail: registration.detail };
    }

    return { pluginId: saved.pluginId, version: saved.version, status: 'active' };
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

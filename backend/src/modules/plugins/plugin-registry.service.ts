import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { PluginPackage } from './entities/plugin-package.entity';
import { arePluginsDisabled, FLIKS_PLUGINS_DISABLED_ENV } from '../../common/constants/plugin-flags';
import { PLUGIN_API_VERSION, type PluginKind, type PluginManifest } from '../../common/plugin-contract';
import { OFFICIAL_KEYS, resolveTrust, readArchiveEntries, type TrustOutcome } from './archive';

/** Same pattern as `UpdateCheckService`/`SystemController` — no shared version util exists yet. */
const CURRENT_FLIKS_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface RegisteredPlugin {
  pluginId: string;
  version: string;
  kind: PluginKind;
  manifest: PluginManifest;
  signature: TrustOutcome;
  verifiedByKeyId: string | null;
  /** Same buffer as the `plugin_packages` row — the logo route re-extracts from
   *  this on each request rather than the registry caching decoded image bytes. */
  archive: Buffer;
}

export type PluginRegistrationFailureReason =
  | 'unsupported-tier'
  | 'untrusted'
  | 'incompatible-api'
  | 'incompatible-fliks';

export interface PluginRegistrationSuccess {
  ok: true;
  pluginId: string;
}
export interface PluginRegistrationFailure {
  ok: false;
  pluginId: string;
  reason: PluginRegistrationFailureReason;
  detail: string;
}
export type PluginRegistrationResult = PluginRegistrationSuccess | PluginRegistrationFailure;

/**
 * In-memory installed-plugin set — the only thing the rest of core asks about
 * plugins. Populated at boot (L0-L4 of `plans/plugin-system.plan.md`'s load
 * table) and by `register()`, the hot-reload entry point a future installer
 * calls for a `data` plugin (P4a). L1/L3 — `state.json` and re-hashing
 * `plugin.js` from the fd that will be loaded — belong to the process-tier
 * supervisor, which does not exist yet.
 */
@Injectable()
export class PluginRegistryService implements OnModuleInit {
  private readonly logger = new Logger(PluginRegistryService.name);
  private readonly registry = new Map<string, RegisteredPlugin>();

  constructor(
    @InjectRepository(PluginPackage)
    private readonly packageRepo: Repository<PluginPackage>,
  ) {}

  async onModuleInit(): Promise<void> {
    // L0 — read before any plugin row is touched.
    if (arePluginsDisabled()) {
      this.logger.warn(`${FLIKS_PLUGINS_DISABLED_ENV}=1 — no plugin will be loaded`);
      return;
    }

    const packages = await this.packageRepo.find();
    for (const pkg of packages) {
      try {
        const result = await this.register(pkg);
        if (!result.ok) {
          this.logger.warn(`plugin "${result.pluginId}" not loaded (${result.reason}): ${result.detail}`);
        }
      } catch (err) {
        // One bad row must never take the app down at boot.
        this.logger.warn(`plugin "${pkg.pluginId}" failed to load: ${(err as Error).message}`);
      }
    }
  }

  /** Hot-reload entry point (install pipeline P4a). Same checks as boot load; idempotent on plugin id. */
  async register(pkg: PluginPackage): Promise<PluginRegistrationResult> {
    const manifest = pkg.manifest;

    if (manifest.kind === 'process') {
      return this.fail(pkg.pluginId, 'unsupported-tier', 'process-tier plugins are not supported yet (no supervisor)');
    }

    // L1 (state.json quarantine) slots in here, ahead of the signature re-check — supervisor-owned.
    // L2
    const trust = await this.reverifyTrust(pkg);
    if (!trust.ok) return this.fail(pkg.pluginId, 'untrusted', trust.detail);

    // L3 (re-hash plugin.js from the loaded fd) slots in here, process-tier only — supervisor-owned.
    // L4
    if (manifest.pluginApi !== PLUGIN_API_VERSION) {
      return this.fail(
        pkg.pluginId,
        'incompatible-api',
        `manifest declares pluginApi ${manifest.pluginApi}, running ${PLUGIN_API_VERSION}`,
      );
    }
    if (!semver.satisfies(CURRENT_FLIKS_VERSION, manifest.fliks)) {
      return this.fail(
        pkg.pluginId,
        'incompatible-fliks',
        `manifest requires fliks "${manifest.fliks}", running ${CURRENT_FLIKS_VERSION}`,
      );
    }

    this.registry.set(pkg.pluginId, {
      pluginId: pkg.pluginId,
      version: pkg.version,
      kind: manifest.kind,
      manifest,
      signature: pkg.signature,
      verifiedByKeyId: pkg.verifiedByKeyId,
      archive: pkg.archive,
    });
    return { ok: true, pluginId: pkg.pluginId };
  }

  unregister(pluginId: string): void {
    this.registry.delete(pluginId);
  }

  list(): RegisteredPlugin[] {
    return [...this.registry.values()];
  }

  get(pluginId: string): RegisteredPlugin | undefined {
    return this.registry.get(pluginId);
  }

  private fail(pluginId: string, reason: PluginRegistrationFailureReason, detail: string): PluginRegistrationFailure {
    return { ok: false, pluginId, reason, detail };
  }

  /**
   * Re-verify against `verifiedByKeyId` specifically — never "any trusted key" — so a
   * revoked/removed key fails the plugin rather than silently falling back to another.
   * A package that was never signed against a known key at install (unsigned/unverified)
   * has nothing to re-check here and passes through.
   */
  private async reverifyTrust(pkg: PluginPackage): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (!pkg.verifiedByKeyId) return { ok: true };

    const key = OFFICIAL_KEYS.get(pkg.verifiedByKeyId);
    if (!key) {
      return { ok: false, detail: `key "${pkg.verifiedByKeyId}" is no longer in the trust store` };
    }

    try {
      const entries = await readArchiveEntries(pkg.archive, new Set(['plugin.json', 'plugin.json.sig']));
      const manifestBytes = entries.get('plugin.json');
      const sigText = entries.get('plugin.json.sig')?.toString('utf8').trim();
      if (!manifestBytes || !sigText) {
        return { ok: false, detail: 'archive is missing plugin.json or its signature' };
      }
      const signature = Buffer.from(sigText, 'base64');
      // Scope the check to exactly this one key by passing it as the sole candidate.
      const result = resolveTrust(manifestBytes, signature, new Map([[pkg.verifiedByKeyId, key]]), new Map());
      if (result.trust !== 'official') {
        return { ok: false, detail: `signature no longer verifies against key "${pkg.verifiedByKeyId}"` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: `archive unreadable: ${(err as Error).message}` };
    }
  }
}

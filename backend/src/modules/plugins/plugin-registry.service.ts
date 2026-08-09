import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { PluginPackage } from './entities/plugin-package.entity';
import { arePluginsDisabled, FLIKS_PLUGINS_DISABLED_ENV } from '../../common/constants/plugin-flags';
import {
  PLUGIN_API_VERSION,
  buildIndexerImplementationId,
  INDEXER_ID_SEPARATOR,
  type PluginKind,
  type PluginManifest,
  type IndexerDescriptor,
} from '../../common/plugin-contract';
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

/** The only `driverApi` core knows how to run a search through today. */
const SUPPORTED_INDEXER_DRIVER_APIS: ReadonlySet<string> = new Set(['torznab']);

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

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
  | 'incompatible-fliks'
  | 'unsupported-indexer-driver'
  | 'invalid-indexer-key'
  | 'invalid-indexer-endpoint';

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
  /** Keyed by the namespaced id (`buildIndexerImplementationId`), rebuilt per plugin on every `register()`. */
  private readonly indexerDescriptors = new Map<string, { pluginId: string; descriptor: IndexerDescriptor }>();

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

    const descriptorCheck = this.validateIndexerDescriptors(manifest.provides?.indexers ?? []);
    if (!descriptorCheck.ok) return this.fail(pkg.pluginId, descriptorCheck.reason, descriptorCheck.detail);

    this.registry.set(pkg.pluginId, {
      pluginId: pkg.pluginId,
      version: pkg.version,
      kind: manifest.kind,
      manifest,
      signature: pkg.signature,
      verifiedByKeyId: pkg.verifiedByKeyId,
      archive: pkg.archive,
    });
    this.replaceIndexerDescriptors(pkg.pluginId, descriptorCheck.descriptors);
    return { ok: true, pluginId: pkg.pluginId };
  }

  unregister(pluginId: string): void {
    this.registry.delete(pluginId);
    this.replaceIndexerDescriptors(pluginId, []);
  }

  list(): RegisteredPlugin[] {
    return [...this.registry.values()];
  }

  get(pluginId: string): RegisteredPlugin | undefined {
    return this.registry.get(pluginId);
  }

  /** The descriptor behind a namespaced `Indexer.implementation`, if that plugin is currently registered. */
  getIndexerDescriptor(implementationId: string): IndexerDescriptor | undefined {
    return this.indexerDescriptors.get(implementationId)?.descriptor;
  }

  /** Every indexer descriptor currently on offer, for the discovery route. */
  listIndexerDescriptors(): ({ implementationId: string; pluginId: string } & IndexerDescriptor)[] {
    return [...this.indexerDescriptors.entries()].map(([implementationId, { pluginId, descriptor }]) => ({
      implementationId,
      pluginId,
      ...descriptor,
    }));
  }

  /** Drops this plugin's previous descriptors (if any) and installs `descriptors` in their place. */
  private replaceIndexerDescriptors(pluginId: string, descriptors: IndexerDescriptor[]): void {
    for (const [id, entry] of this.indexerDescriptors) {
      if (entry.pluginId === pluginId) this.indexerDescriptors.delete(id);
    }
    for (const descriptor of descriptors) {
      this.indexerDescriptors.set(buildIndexerImplementationId(pluginId, descriptor.key), { pluginId, descriptor });
    }
  }

  /**
   * `manifest.provides.indexers` is untrusted JSON (`unknown[]` at the type
   * level — see `manifest.ts`), so each entry is read defensively rather
   * than trusted as an `IndexerDescriptor`. Each violation gets its own
   * reason so a refusal is attributable, mirroring
   * `validateDataTierManifest`'s one-code-per-key style.
   */
  private validateIndexerDescriptors(
    raw: unknown[],
  ):
    | { ok: true; descriptors: IndexerDescriptor[] }
    | { ok: false; reason: PluginRegistrationFailureReason; detail: string } {
    const descriptors: IndexerDescriptor[] = [];
    const seenKeys = new Set<string>();
    for (const entry of raw) {
      const d = (entry ?? {}) as Partial<IndexerDescriptor>;
      const key = typeof d.key === 'string' ? d.key : '';
      const driverApi = typeof d.driverApi === 'string' ? d.driverApi : '';
      const endpoint = typeof d.endpoint === 'string' ? d.endpoint : '';
      const name = typeof d.name === 'string' ? d.name : '';
      const settings = Array.isArray(d.settings) ? d.settings : [];

      if (!SUPPORTED_INDEXER_DRIVER_APIS.has(driverApi)) {
        return {
          ok: false,
          reason: 'unsupported-indexer-driver',
          detail: `descriptor "${key}" needs driverApi "${driverApi}", which core does not support (supported: ${[...SUPPORTED_INDEXER_DRIVER_APIS].join(', ')})`,
        };
      }
      if (!key || key.includes(INDEXER_ID_SEPARATOR)) {
        return {
          ok: false,
          reason: 'invalid-indexer-key',
          detail: `indexer key "${key}" is empty or contains "${INDEXER_ID_SEPARATOR}"`,
        };
      }
      if (seenKeys.has(key)) {
        return { ok: false, reason: 'invalid-indexer-key', detail: `duplicate indexer key "${key}"` };
      }
      seenKeys.add(key);
      if (!isAbsoluteHttpUrl(endpoint)) {
        return {
          ok: false,
          reason: 'invalid-indexer-endpoint',
          detail: `descriptor "${key}" has an invalid endpoint "${endpoint}"`,
        };
      }
      descriptors.push({ key, name, driverApi, endpoint, settings });
    }
    return { ok: true, descriptors };
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

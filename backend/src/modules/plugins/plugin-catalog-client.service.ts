import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { createHash } from 'crypto';
import { PluginSource } from './entities/plugin-source.entity';
import { PluginPackage } from './entities/plugin-package.entity';
import { OFFICIAL_KEYS, resolveTrust, MAX_SIGNATURE_BYTES } from './archive';
import { SUPPORTED_PLUGIN_API_VERSIONS } from '../../common/plugin-contract';
import { CURRENT_FLIKS_VERSION, PluginRegistryService } from './plugin-registry.service';
import { parseCatalogDocument, filterCatalog, findDenial, type FilteredCatalog } from './catalog/catalog';

const CATALOG_REQUEST_TIMEOUT_MS = 10_000;
/** A catalog is a small JSON index of plugin metadata, nowhere near the 8 MiB
 *  archive cap (`archive/limits.ts`) — generous versus today's few-KB catalogs. */
const CATALOG_MAX_RESPONSE_BYTES = 1024 * 1024;
/** How old a cached catalog may be before boot refetches it. Short enough that a
 *  restart picks up a day-old catalog, long enough that a crash-restart loop does
 *  not hammer a public host. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export type CatalogRefreshFailureReason = 'insecure-url' | 'network-error' | 'bad-signature' | 'malformed-catalog';

export type CatalogRefreshResult = { ok: true } | { ok: false; reason: CatalogRefreshFailureReason; detail: string };

/**
 * Fetches, verifies and caches one source's `catalog.json`. Deliberately does not
 * reuse `internal-address.ts`: that guard blocks a plugin-authored webhook URL
 * (untrusted input) from reaching the LAN, but a source URL is typed in by the
 * admin themselves, who may legitimately run a self-hosted catalog on their own
 * network — refusing private ranges here would break a supported setup. The two
 * checks share a shape but not a trust boundary, so they stay separate on purpose.
 */
@Injectable()
export class PluginCatalogClientService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PluginCatalogClientService.name);

  constructor(
    @InjectRepository(PluginSource)
    private readonly sourceRepo: Repository<PluginSource>,
    @InjectRepository(PluginPackage)
    private readonly packageRepo: Repository<PluginPackage>,
    private readonly registry: PluginRegistryService,
  ) {}

  /**
   * A source seeded by migration starts with no cached catalog, and until this ran
   * only the 3am job filled it — a fresh install browsed an empty catalogue for up
   * to a day. Refreshing what is stale at boot closes that window.
   *
   * Never awaited and never fatal: an unreachable catalog must not delay startup.
   */
  onApplicationBootstrap(): void {
    void this.refreshAll({ staleOnly: true }).catch((err: unknown) =>
      this.logger.warn(`boot catalog refresh failed: ${(err as Error).message}`),
    );
  }

  /** Driven by `SchedulerService`'s `RefreshPluginSources` job, so the run is listed,
   *  triggerable and recorded — a bare `@Cron` here was none of those. `staleOnly`
   *  is what boot passes; the scheduled run always refetches everything. */
  async refreshAll(opts: { staleOnly?: boolean } = {}): Promise<void> {
    const sources = await this.sourceRepo.find({ where: { enabled: true } });
    const now = Date.now();
    for (const source of sources) {
      if (opts.staleOnly && !this.isStale(source, now)) continue;
      try {
        await this.refreshSource(source);
      } catch (err) {
        // `refreshSource` reports its own expected failures; this catches the
        // unexpected ones so a single bad source cannot abort the whole run.
        this.logger.warn(`catalog refresh threw for source #${source.id}: ${(err as Error).message}`);
      }
    }
  }

  private isStale(source: PluginSource, now: number): boolean {
    if (!source.cachedCatalog || !source.lastRefreshedAt) return true;
    return now - source.lastRefreshedAt.getTime() > STALE_AFTER_MS;
  }

  /**
   * Verifies the exact bytes fetched before any JSON parsing happens — a signature
   * proves who wrote the bytes, and that check has to run before anything trusts
   * their content. A transient failure at any step keeps the source's previous
   * `cachedCatalog` untouched; only a successful refresh replaces it.
   */
  async refreshSource(source: PluginSource): Promise<CatalogRefreshResult> {
    // "catalog: the signed JSON document served at a source's URL" (plan, "Naming, and
    // why not repository") — `source.url` IS the catalog.json URL, not a base to join
    // against. The detached signature is the sibling file the archive convention
    // already uses: the same name plus `.sig`.
    let catalogUrl: URL;
    try {
      catalogUrl = new URL(source.url);
    } catch {
      return this.fail(source, 'insecure-url', `source url "${source.url}" is not a valid URL`);
    }
    if (catalogUrl.protocol !== 'https:') {
      return this.fail(source, 'insecure-url', `source url "${source.url}" must be https`);
    }
    const sigUrl = `${source.url}.sig`;

    let catalogBytes: Buffer;
    let sigBytes: Buffer;
    try {
      [catalogBytes, sigBytes] = await Promise.all([
        this.fetchBytes(catalogUrl.toString(), CATALOG_MAX_RESPONSE_BYTES),
        this.fetchBytes(sigUrl, MAX_SIGNATURE_BYTES),
      ]);
    } catch (err) {
      return this.fail(source, 'network-error', (err as Error).message);
    }

    const officialKeys = source.publicKey ? new Map([['source', source.publicKey]]) : OFFICIAL_KEYS;
    const signature = this.parseSignature(sigBytes);
    const trust = resolveTrust(catalogBytes, signature, officialKeys);
    if (trust.trust === 'unsigned' || trust.trust === 'unverified') {
      return this.fail(source, 'bad-signature', `catalog signature did not verify (${trust.trust})`);
    }

    const document = parseCatalogDocument(catalogBytes);
    if (!document) {
      return this.fail(source, 'malformed-catalog', 'catalog signature verified but the document did not parse');
    }

    const filtered: FilteredCatalog = filterCatalog(document, SUPPORTED_PLUGIN_API_VERSIONS, CURRENT_FLIKS_VERSION);
    const signedByKeyId = trust.signedByKeyId ?? null;
    source.cachedCatalog = { ...filtered, signedByKeyId } as unknown as Record<string, unknown>;
    source.lastRefreshedAt = new Date();
    source.lastRefreshError = null;
    await this.sourceRepo.save(source);
    if (source.enabled) await this.enforceDenyList(filtered.denyList, signedByKeyId);
    return { ok: true };
  }

  /**
   * A revocation that just landed must not wait for a reboot: every installed package this
   * catalogue's key vouched for is re-checked immediately, and a match is stopped and marked
   * `failed` right away rather than merely blocked at the next install.
   */
  private async enforceDenyList(
    denyList: FilteredCatalog['denyList'],
    signedByKeyId: string | null,
  ): Promise<void> {
    if (denyList.length === 0 || !signedByKeyId) return;
    const source = [{ denyList, signedByKeyId }];
    for (const pkg of await this.packageRepo.find()) {
      const sha256 = createHash('sha256').update(pkg.archive).digest('hex');
      const denial = findDenial(
        { pluginId: pkg.pluginId, version: pkg.version, sha256, verifiedByKeyId: pkg.verifiedByKeyId },
        source,
      );
      if (!denial) continue;
      this.logger.warn(`plugin "${pkg.pluginId}" revoked by catalog: ${denial.reason}`);
      try {
        await this.registry.revoke(pkg.pluginId, denial.reason);
        pkg.status = 'failed';
        pkg.statusReason = `revoked: ${denial.reason}`;
        await this.packageRepo.save(pkg);
      } catch (err) {
        // One package must not abort the refresh, nor the rest of the nightly loop.
        this.logger.warn(`could not revoke "${pkg.pluginId}": ${(err as Error).message}`);
      }
    }
  }

  private async fail(
    source: PluginSource,
    reason: CatalogRefreshFailureReason,
    detail: string,
  ): Promise<CatalogRefreshResult> {
    this.logger.warn(`catalog refresh failed for source #${source.id} (${reason}): ${detail}`);
    source.lastRefreshError = detail;
    await this.sourceRepo.save(source);
    return { ok: false, reason, detail };
  }

  /** Same format as `plugin.json.sig` in an archive: base64 text, one file. */
  private parseSignature(sigBytes: Buffer): Buffer | null {
    const text = sigBytes.toString('utf8').trim();
    return text ? Buffer.from(text, 'base64') : null;
  }

  private async fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: CATALOG_REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: maxBytes,
      headers: { 'User-Agent': 'Fliks-Plugin-Catalog-Client/1.0' },
    });
    return Buffer.from(res.data);
  }
}

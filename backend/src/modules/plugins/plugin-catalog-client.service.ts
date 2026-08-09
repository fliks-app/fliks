import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { PluginSource } from './entities/plugin-source.entity';
import { OFFICIAL_KEYS, resolveTrust, MAX_SIGNATURE_BYTES } from './archive';
import { PLUGIN_API_VERSION } from '../../common/plugin-contract';
import { CURRENT_FLIKS_VERSION } from './plugin-registry.service';
import { parseCatalogDocument, filterCatalog, type FilteredCatalog } from './catalog/catalog';

const CATALOG_REQUEST_TIMEOUT_MS = 10_000;
/** A catalog is a small JSON index of plugin metadata, nowhere near the 8 MiB
 *  archive cap (`archive/limits.ts`) — generous versus today's few-KB catalogs. */
const CATALOG_MAX_RESPONSE_BYTES = 1024 * 1024;

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
export class PluginCatalogClientService {
  private readonly logger = new Logger(PluginCatalogClientService.name);

  constructor(
    @InjectRepository(PluginSource)
    private readonly sourceRepo: Repository<PluginSource>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async refreshAll(): Promise<void> {
    const sources = await this.sourceRepo.find({ where: { enabled: true } });
    for (const source of sources) {
      await this.refreshSource(source);
    }
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
    const trust = resolveTrust(catalogBytes, signature, officialKeys, new Map());
    if (trust.trust === 'unsigned' || trust.trust === 'unverified') {
      return this.fail(source, 'bad-signature', `catalog signature did not verify (${trust.trust})`);
    }

    const document = parseCatalogDocument(catalogBytes);
    if (!document) {
      return this.fail(source, 'malformed-catalog', 'catalog signature verified but the document did not parse');
    }

    const filtered: FilteredCatalog = filterCatalog(document, PLUGIN_API_VERSION, CURRENT_FLIKS_VERSION);
    source.cachedCatalog = filtered as unknown as Record<string, unknown>;
    source.lastRefreshedAt = new Date();
    source.lastRefreshError = null;
    await this.sourceRepo.save(source);
    return { ok: true };
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

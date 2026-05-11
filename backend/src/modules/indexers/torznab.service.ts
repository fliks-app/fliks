import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { Indexer } from './entities/indexer.entity';
import { IndexerStat } from './entities/indexer-stat.entity';

export interface TorznabRelease {
  title: string;
  downloadUrl: string;
  indexerId: number;
  indexerName: string;
  size: number; // bytes, 0 if unknown
  seeders: number;
  leechers: number;
  publishDate: string | null; // ISO date string from <pubDate>, null if unavailable
  freeleech: boolean;
  downloadVolumeFactor: number; // 0=free, 0.5=half, 1=normal
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Build a Torznab query string. Drops null/undefined params so optional
 * external-id filters (tvdbid / imdbid / tmdbid) are only sent when known.
 * IMDb IDs are stripped of the `tt` prefix — that's what every Newznab-spec
 * indexer expects on the wire.
 */
function buildTorznabQuery(opts: {
  t: string;
  q?: string;
  season?: number;
  ep?: number;
  cat: string;
  apiKey: string;
  tvdbId?: number | null;
  imdbId?: string | null;
  tmdbId?: number | null;
}): string {
  const parts: string[] = [`t=${opts.t}`];
  if (opts.q) parts.push(`q=${encodeURIComponent(opts.q)}`);
  if (opts.season != null) parts.push(`season=${opts.season}`);
  if (opts.ep != null) parts.push(`ep=${opts.ep}`);
  parts.push(`cat=${opts.cat}`);
  parts.push(`apikey=${encodeURIComponent(opts.apiKey)}`);
  if (opts.tvdbId) parts.push(`tvdbid=${opts.tvdbId}`);
  if (opts.imdbId) {
    const stripped = opts.imdbId.replace(/^tt/i, '');
    if (stripped) parts.push(`imdbid=${stripped}`);
  }
  if (opts.tmdbId) parts.push(`tmdbid=${opts.tmdbId}`);
  return parts.join('&');
}

function extractInnerXml(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return null;
  return decodeXmlEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
}

function torznabAttr(block: string, name: string): string | null {
  const re = new RegExp(
    `<torznab:attr[^>]+name="${name}"[^>]+value="([^"]*)"`,
    'i',
  );
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

function ensureApiKey(url: string, apiKey: string): string {
  if (!apiKey || url.startsWith('magnet:')) return url;
  try {
    const clean = decodeXmlEntities(url);
    const u = new URL(clean);
    // Always force the configured API key — the XML may contain a stale/invalid one
    u.searchParams.set('apikey', apiKey);
    return u.toString();
  } catch {
    return url;
  }
}

function parseTorznabItems(xml: string, indexer: Indexer): TorznabRelease[] {
  const settings = indexer.settings as { apiKey?: string };
  const apiKey = String(settings.apiKey || '');
  const out: TorznabRelease[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractInnerXml(block, 'title');
    const link = extractInnerXml(block, 'link');
    const magnetAttr =
      block.match(/name="magneturl"\s+value="([^"]*)"/i) ||
      block.match(/name='magneturl'\s+value='([^']*)'/i);
    const magnet = magnetAttr?.[1]
      ? decodeXmlEntities(magnetAttr[1].trim())
      : undefined;
    const enc = block.match(/<enclosure[^>]*\surl="([^"]+)"/i);
    const encUrl = enc?.[1] ? decodeXmlEntities(enc[1].trim()) : undefined;
    const url =
      magnet ||
      (link?.startsWith('magnet:') ? link : null) ||
      encUrl ||
      (link && !link.startsWith('http://localhost') ? link : null);
    if (!title || !url) continue;

    // Size: prefer <enclosure length="…">, fallback to torznab:attr name="size"
    const encLen = enc?.[0]?.match(/\blength="(\d+)"/i)?.[1];
    const sizeStr =
      encLen ?? torznabAttr(block, 'size') ?? extractInnerXml(block, 'size');
    const size = sizeStr ? parseInt(sizeStr, 10) || 0 : 0;

    const seeders = parseInt(torznabAttr(block, 'seeders') ?? '0', 10) || 0;
    const leechers =
      parseInt(
        torznabAttr(block, 'leechers') ?? torznabAttr(block, 'peers') ?? '0',
        10,
      ) || 0;

    const dvfStr = torznabAttr(block, 'downloadvolumefactor');
    const downloadVolumeFactor = dvfStr !== null ? parseFloat(dvfStr) : 1;
    const freeleech = downloadVolumeFactor === 0;

    const pubDateRaw = extractInnerXml(block, 'pubDate');
    let publishDate: string | null = null;
    if (pubDateRaw) {
      const d = new Date(pubDateRaw);
      if (!isNaN(d.getTime())) publishDate = d.toISOString();
    }

    out.push({
      title,
      downloadUrl: ensureApiKey(url, apiKey),
      indexerId: indexer.id,
      indexerName: indexer.name,
      size,
      seeders,
      leechers,
      publishDate,
      freeleech,
      downloadVolumeFactor,
    });
  }
  return out;
}

@Injectable()
export class TorznabService {
  private readonly log = new Logger(TorznabService.name);

  constructor(
    @InjectRepository(IndexerStat)
    private readonly statRepo: Repository<IndexerStat>,
  ) {}

  /**
   * Appelle `t=caps` pour valider l’URL et la clé API sans indexer persisté.
   */
  async testConnection(
    baseUrl: string,
    apiKey: string,
  ): Promise<{ ok: boolean; message: string }> {
    const base = String(baseUrl || '').replace(/\/$/, '');
    if (!base) {
      return { ok: false, message: 'baseUrl vide' };
    }
    const url = `${base}?t=caps&apikey=${encodeURIComponent(apiKey || '')}`;
    try {
      const res = await axios.get<string>(url, {
        timeout: 30_000,
        responseType: 'text',
        headers: { 'User-Agent': 'Fliks/1.0' },
        validateStatus: () => true,
      });
      const body = typeof res.data === 'string' ? res.data : String(res.data);
      if (res.status >= 400) {
        return { ok: false, message: `HTTP ${res.status}` };
      }
      if (/<error\s+code=/i.test(body)) {
        const m = body.match(/description="([^"]*)"/i);
        return { ok: false, message: m?.[1]?.trim() || 'Erreur Torznab' };
      }
      if (!/<caps/i.test(body)) {
        return {
          ok: false,
          message: 'Réponse inattendue (pas de document Torznab « caps »)',
        };
      }
      return { ok: true, message: 'Torznab : capacités lues, connexion OK' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /** Fetch RSS feed (t=search with no query = recent releases) */
  async rssSearch(indexer: Indexer): Promise<TorznabRelease[]> {
    if (!indexer.enabled || !indexer.enableRss) return [];
    const settings = indexer.settings as { baseUrl?: string; apiKey?: string };
    const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
    const apiKey = String(settings.apiKey || '');
    if (!baseUrl) return [];

    const url = `${baseUrl}?t=search&q=&cat=2000&apikey=${encodeURIComponent(apiKey)}`;
    const start = Date.now();
    try {
      const res = await axios.get<string>(url, {
        timeout: 60_000,
        responseType: 'text',
        headers: { 'User-Agent': 'Fliks/1.0' },
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const body = typeof res.data === 'string' ? res.data : String(res.data);
      const results = parseTorznabItems(body, indexer);
      void this.statRepo.save(
        this.statRepo.create({
          indexer,
          queryType: 'rss',
          responseTimeMs: Date.now() - start,
          resultCount: results.length,
          errorMessage: null,
        }),
      );
      return results;
    } catch (e) {
      void this.statRepo.save(
        this.statRepo.create({
          indexer,
          queryType: 'rss',
          responseTimeMs: Date.now() - start,
          resultCount: 0,
          errorMessage: (e as Error).message,
        }),
      );
      this.log.warn(
        `RSS sync failed for "${indexer.name}": ${(e as Error).message}`,
      );
      return [];
    }
  }

  /** Search for a season pack (no episode number → indexer returns packs for the whole season) */
  async searchSeasonPack(
    indexer: Indexer,
    showTitle: string,
    season: number,
    externalIds?: { tvdbId?: number | null; imdbId?: string | null },
  ): Promise<TorznabRelease[]> {
    if (!indexer.enabled || !indexer.enableSearch) return [];
    const impl = (indexer.implementation || '').toLowerCase();
    if (!impl.includes('torznab')) return [];

    const settings = indexer.settings as { baseUrl?: string; apiKey?: string };
    const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
    const apiKey = String(settings.apiKey || '');
    if (!baseUrl) return [];

    const url = `${baseUrl}?${buildTorznabQuery({
      t: 'tvsearch',
      q: showTitle,
      season,
      cat: '5000',
      apiKey,
      tvdbId: externalIds?.tvdbId,
      imdbId: externalIds?.imdbId,
    })}`;
    const start = Date.now();
    try {
      const res = await axios.get<string>(url, {
        timeout: 90_000,
        responseType: 'text',
        headers: { 'User-Agent': 'Fliks/1.0' },
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const body = typeof res.data === 'string' ? res.data : String(res.data);
      const results = parseTorznabItems(body, indexer);
      void this.statRepo.save(
        this.statRepo.create({
          indexer,
          queryType: 'season',
          responseTimeMs: Date.now() - start,
          resultCount: results.length,
          errorMessage: null,
        }),
      );
      return results;
    } catch (e) {
      void this.statRepo.save(
        this.statRepo.create({
          indexer,
          queryType: 'season',
          responseTimeMs: Date.now() - start,
          resultCount: 0,
          errorMessage: (e as Error).message,
        }),
      );
      this.log.warn(
        `Torznab season pack search failed for "${indexer.name}": ${(e as Error).message}`,
      );
      return [];
    }
  }

  async searchSeries(
    indexer: Indexer,
    showTitle: string,
    season: number,
    episode: number,
    externalIds?: { tvdbId?: number | null; imdbId?: string | null },
  ): Promise<TorznabRelease[]> {
    if (!indexer.enabled || !indexer.enableSearch) return [];
    const impl = (indexer.implementation || '').toLowerCase();
    if (!impl.includes('torznab')) return [];

    const settings = indexer.settings as { baseUrl?: string; apiKey?: string };
    const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
    const apiKey = String(settings.apiKey || '');
    if (!baseUrl) return [];

    const url = `${baseUrl}?${buildTorznabQuery({
      t: 'tvsearch',
      q: showTitle,
      season,
      ep: episode,
      cat: '5000',
      apiKey,
      tvdbId: externalIds?.tvdbId,
      imdbId: externalIds?.imdbId,
    })}`;
    const start = Date.now();
    try {
      const res = await axios.get<string>(url, {
        timeout: 90_000,
        responseType: 'text',
        headers: { 'User-Agent': 'Fliks/1.0' },
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const body = typeof res.data === 'string' ? res.data : String(res.data);
      const results = parseTorznabItems(body, indexer);
      void this.statRepo.save(
        this.statRepo.create({
          indexer,
          queryType: 'tvsearch',
          responseTimeMs: Date.now() - start,
          resultCount: results.length,
          errorMessage: null,
        }),
      );
      return results;
    } catch (e) {
      void this.statRepo.save(
        this.statRepo.create({
          indexer,
          queryType: 'tvsearch',
          responseTimeMs: Date.now() - start,
          resultCount: 0,
          errorMessage: (e as Error).message,
        }),
      );
      this.log.warn(
        `Torznab tvsearch failed for "${indexer.name}": ${(e as Error).message}`,
      );
      return [];
    }
  }

  async searchMovie(
    indexer: Indexer,
    query: string,
    externalIds?: { imdbId?: string | null; tmdbId?: number | null },
  ): Promise<TorznabRelease[]> {
    if (!indexer.enabled || !indexer.enableSearch) return [];
    const impl = (indexer.implementation || '').toLowerCase();
    if (!impl.includes('torznab')) return [];

    const settings = indexer.settings as { baseUrl?: string; apiKey?: string };
    const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
    const apiKey = String(settings.apiKey || '');
    if (!baseUrl) {
      this.log.warn(`Indexer "${indexer.name}" has no baseUrl`);
      return [];
    }

    // `t=movie` is the spec'd endpoint for imdbid/tmdbid filtering. Fall back
    // to the generic `t=search&cat=2000` when no external IDs are available
    // so q=-only trackers stay reachable.
    const useMovieSearch = !!(externalIds?.imdbId || externalIds?.tmdbId);
    const url = `${baseUrl}?${buildTorznabQuery({
      t: useMovieSearch ? 'movie' : 'search',
      q: query,
      cat: '2000',
      apiKey,
      imdbId: externalIds?.imdbId,
      tmdbId: externalIds?.tmdbId,
    })}`;
    const start = Date.now();
    try {
      const res = await axios.get<string>(url, {
        timeout: 90_000,
        responseType: 'text',
        headers: { 'User-Agent': 'Fliks/1.0' },
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const body = typeof res.data === 'string' ? res.data : String(res.data);
      const results = parseTorznabItems(body, indexer);
      void this.statRepo.save(
        this.statRepo.create({
          indexer,
          queryType: 'search',
          responseTimeMs: Date.now() - start,
          resultCount: results.length,
          errorMessage: null,
        }),
      );
      return results;
    } catch (e) {
      void this.statRepo.save(
        this.statRepo.create({
          indexer,
          queryType: 'search',
          responseTimeMs: Date.now() - start,
          resultCount: 0,
          errorMessage: (e as Error).message,
        }),
      );
      this.log.warn(
        `Torznab search failed for "${indexer.name}": ${(e as Error).message}`,
      );
      return [];
    }
  }
}

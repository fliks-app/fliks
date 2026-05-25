import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import FormData from 'form-data';
import { DownloadClient } from './entities/download-client.entity';
import { decodeHtmlEntities } from '../../common/utils/decode-html-entities';

/**
 * Pull the BitTorrent info-hash out of a magnet URI. Magnets carry the
 * hash either as a 40-char hex string or as a 32-char base32 string —
 * the previous regex only matched hex, so trackers that advertise base32
 * magnets (uncommon but they exist) silently fell back to the
 * list-diff recovery path and were briefly orphaned in Activities.
 */
function extractMagnetInfoHash(magnet: string): string | undefined {
  const hex = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40})/)?.[1];
  if (hex) return hex.toLowerCase();
  const b32 = magnet.match(/xt=urn:btih:([A-Z2-7]{32})/i)?.[1];
  if (!b32) return undefined;
  // Decode base32 → 20 bytes, then hex-encode to match qBit's format.
  const upper = b32.toUpperCase();
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = Buffer.alloc(20);
  let idx = 0;
  for (const ch of upper) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return undefined;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (value >>> bits) & 0xff;
    }
  }
  return out.toString('hex');
}

export interface QbittorrentTorrent {
  hash: string;
  name: string;
  size: number;
  downloaded: number; // bytes downloaded so far
  progress: number; // 0–1
  dlspeed: number; // bytes/s
  upspeed: number; // bytes/s
  ratio: number; // upload/download ratio
  eta: number; // seconds
  state: string; // 'downloading' | 'seeding' | 'paused' | 'error' | ...
  category: string;
  num_seeds: number;
  num_leechs: number;
  added_on: number; // unix timestamp
  completion_on: number;
  save_path: string;
  content_path: string;
}

export interface QbittorrentTorrentFile {
  name: string; // relative path within torrent
  size: number;
  progress: number; // 0–1
  priority: number;
}

@Injectable()
export class QbittorrentService {
  private readonly log = new Logger(QbittorrentService.name);

  private buildBaseUrl(s: {
    host?: string;
    port?: number;
    useSsl?: boolean;
  }): string | null {
    let host = String(s.host || '').replace(/\/$/, '');
    if (!host) return null;
    const protocol = s.useSsl ? 'https' : 'http';
    // Strip protocol if user provided one, we'll re-add it
    host = host.replace(/^https?:\/\//i, '');
    // Strip any existing port from hostname
    const portFromHost = host.match(/:(\d+)$/);
    if (portFromHost) host = host.replace(/:\d+$/, '');
    const port = s.port || (portFromHost ? Number(portFromHost[1]) : undefined);
    return `${protocol}://${host}${port ? `:${port}` : ''}`;
  }

  async testConnection(
    settings: Record<string, unknown>,
  ): Promise<{ ok: boolean; message: string }> {
    const s = settings as {
      host?: string;
      username?: string;
      password?: string;
      useSsl?: boolean;
      port?: number;
    };
    const base = this.buildBaseUrl(s);
    if (!base) {
      return { ok: false, message: 'Host is required' };
    }

    try {
      const http = axios.create({
        timeout: 10_000,
        headers: { 'User-Agent': 'Fliks/1.0' },
      });
      const formAuth = new URLSearchParams({
        username: s.username ?? '',
        password: s.password ?? '',
      });
      const res = await http.post(
        `${base}/api/v2/auth/login`,
        formAuth.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          validateStatus: () => true,
        },
      );
      if (res.data === 'Fails.' || !res.headers['set-cookie']?.length) {
        return {
          ok: false,
          message: 'Authentication failed — check credentials',
        };
      }
      return { ok: true, message: 'Successfully connected to qBittorrent' };
    } catch (e) {
      return {
        ok: false,
        message: `Could not reach qBittorrent: ${(e as Error).message}`,
      };
    }
  }

  async getTorrents(client: DownloadClient): Promise<QbittorrentTorrent[]> {
    const s = client.settings as {
      host?: string;
      username?: string;
      password?: string;
      useSsl?: boolean;
      port?: number;
      category?: string;
    };
    const base = this.buildBaseUrl(s);
    if (!base) return [];
    const http = axios.create({
      timeout: 15_000,
      headers: { 'User-Agent': 'Fliks/1.0' },
    });

    const formAuth = new URLSearchParams({
      username: s.username ?? '',
      password: s.password ?? '',
    });
    let cookieHeader = '';
    try {
      const loginRes = await http.post(
        `${base}/api/v2/auth/login`,
        formAuth.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          validateStatus: () => true,
        },
      );
      const cookies = loginRes.headers['set-cookie'];
      if (!cookies?.length || loginRes.data === 'Fails.') {
        this.log.warn(
          `getTorrents: auth failed for client "${client.name}" at ${base}`,
        );
        return [];
      }
      cookieHeader = cookies.map((c: string) => c.split(';')[0]).join('; ');
    } catch (e) {
      this.log.warn(
        `getTorrents: cannot reach client "${client.name}" at ${base}: ${(e as Error).message}`,
      );
      return [];
    }

    try {
      const params: Record<string, string> = {};
      if (s.category?.trim()) params.category = s.category.trim();
      const res = await http.get<QbittorrentTorrent[]>(
        `${base}/api/v2/torrents/info`,
        {
          headers: { Cookie: cookieHeader },
          params,
          validateStatus: () => true,
        },
      );
      if (!Array.isArray(res.data)) {
        this.log.warn(
          `getTorrents: unexpected response from "${client.name}": ${typeof res.data}`,
        );
        return [];
      }
      // Decode HTML entities baked into the `.torrent` `name` field by
      // misbehaving indexers (`Berl&iacute;n` → `Berlín`). Anything
      // downstream — history matching, activity UI, sourceTitle —
      // gets the human-readable form.
      return res.data.map((t) =>
        t.name ? { ...t, name: decodeHtmlEntities(t.name) } : t,
      );
    } catch (e) {
      this.log.warn(
        `getTorrents: error fetching torrents from "${client.name}": ${(e as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Get the list of files belonging to a specific torrent.
   * Uses qBittorrent API /api/v2/torrents/files.
   */
  async getTorrentFiles(
    client: DownloadClient,
    hash: string,
  ): Promise<QbittorrentTorrentFile[]> {
    const s = client.settings as {
      host?: string;
      username?: string;
      password?: string;
      useSsl?: boolean;
      port?: number;
    };
    const base = this.buildBaseUrl(s);
    if (!base) return [];
    const http = axios.create({
      timeout: 15_000,
      headers: { 'User-Agent': 'Fliks/1.0' },
    });

    const formAuth = new URLSearchParams({
      username: s.username ?? '',
      password: s.password ?? '',
    });
    try {
      const loginRes = await http.post(
        `${base}/api/v2/auth/login`,
        formAuth.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          validateStatus: () => true,
        },
      );
      const cookies = loginRes.headers['set-cookie'];
      if (!cookies?.length || loginRes.data === 'Fails.') return [];
      const cookieHeader = cookies
        .map((c: string) => c.split(';')[0])
        .join('; ');

      const res = await http.get<QbittorrentTorrentFile[]>(
        `${base}/api/v2/torrents/files`,
        {
          headers: { Cookie: cookieHeader },
          params: { hash },
          validateStatus: () => true,
        },
      );
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      this.log.warn(
        `getTorrentFiles: error for hash ${hash}: ${(e as Error).message}`,
      );
      return [];
    }
  }

  async deleteTorrent(
    client: DownloadClient,
    hash: string,
    deleteFiles = false,
  ): Promise<void> {
    const s = client.settings as {
      host?: string;
      username?: string;
      password?: string;
      useSsl?: boolean;
      port?: number;
    };
    const base = this.buildBaseUrl(s);
    if (!base) {
      throw new BadRequestException(
        'qBittorrent client has no host configured',
      );
    }

    const http = axios.create({
      timeout: 15_000,
      headers: { 'User-Agent': 'Fliks/1.0' },
    });

    const formAuth = new URLSearchParams({
      username: s.username ?? '',
      password: s.password ?? '',
    });
    const loginRes = await http.post(
      `${base}/api/v2/auth/login`,
      formAuth.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
      },
    );
    const cookies = loginRes.headers['set-cookie'];
    if (!cookies?.length || loginRes.data === 'Fails.') {
      throw new BadRequestException('qBittorrent authentication failed');
    }
    const cookieHeader = cookies.map((c: string) => c.split(';')[0]).join('; ');

    const params = new URLSearchParams({
      hashes: hash,
      deleteFiles: String(deleteFiles),
    });
    const res = await http.post(
      `${base}/api/v2/torrents/delete`,
      params.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookieHeader,
        },
        validateStatus: () => true,
      },
    );
    if (res.status !== 200) {
      throw new BadRequestException(
        `qBittorrent refused deletion (HTTP ${res.status})`,
      );
    }
  }

  supports(client: DownloadClient): boolean {
    if (!client.enabled) return false;
    return (client.implementation || '').toLowerCase().includes('qbittorrent');
  }

  private sanitizeUrl(url: string): string {
    // Decode XML entities that may leak from Torznab XML responses
    return url.replace(/&amp;/g, '&');
  }

  /**
   * Walk the indexer's redirect chain manually so we can intercept a
   * `magnet:` Location header (LimeTorrents et al.) before Axios tries
   * to dial it like a regular HTTP URL — its protocol handler rejects
   * `magnet:` and surfaces "Unsupported protocol".
   *
   * Returns either the resolved `.torrent` body, or the magnet URI we
   * should hand straight to qBittorrent.
   */
  private async fetchTorrentOrMagnet(
    http: import('axios').AxiosInstance,
    startUrl: string,
    maxHops = 5,
  ): Promise<{ buffer: Buffer } | { magnet: string }> {
    let url = startUrl;
    for (let hop = 0; hop <= maxHops; hop++) {
      let res: import('axios').AxiosResponse<Buffer>;
      try {
        res = await http.get<Buffer>(url, {
          responseType: 'arraybuffer',
          timeout: 30_000,
          maxRedirects: 0,
          validateStatus: () => true,
        });
      } catch (e) {
        this.log.error(
          `Failed to download torrent file — URL: ${url} — Error: ${(e as Error).message}`,
        );
        throw new BadRequestException(
          `Could not fetch torrent from indexer: ${(e as Error).message}`,
        );
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers['location'] as string | undefined;
        if (!location) {
          throw new BadRequestException(
            `Indexer redirected without a Location header (HTTP ${res.status})`,
          );
        }
        if (location.startsWith('magnet:')) {
          return { magnet: location };
        }
        const next = new URL(location, url).toString();
        url = next;
        this.log.log(`Following indexer redirect → ${url}`);
        continue;
      }

      if (res.status !== 200) {
        this.log.error(
          `Indexer returned HTTP ${res.status} for torrent download — URL: ${url}`,
        );
        throw new BadRequestException(
          `Indexer returned HTTP ${res.status} for torrent download`,
        );
      }

      return { buffer: Buffer.from(res.data) };
    }
    throw new BadRequestException(
      `Indexer redirect chain exceeded ${maxHops} hops`,
    );
  }

  /**
   * Add a torrent to qBittorrent and return the info hash (lowercase hex).
   */
  async addTorrentUrl(
    client: DownloadClient,
    torrentUrl: string,
    mediaType?: 'movie' | 'series',
  ): Promise<string> {
    torrentUrl = this.sanitizeUrl(torrentUrl);
    const s = client.settings;
    const base = this.buildBaseUrl(
      s as {
        host?: string;
        port?: number;
        useSsl?: boolean;
      },
    );
    if (!base) {
      throw new BadRequestException(
        'qBittorrent client has no host configured',
      );
    }

    let category = String(s.category ?? '').trim();
    if (mediaType === 'movie' && s.movieCategory)
      category = String(s.movieCategory).trim();
    if (mediaType === 'series' && s.seriesCategory)
      category = String(s.seriesCategory).trim();

    const http = axios.create({
      timeout: 60_000,
      headers: { 'User-Agent': 'Fliks/1.0' },
    });

    // --- Authenticate ---
    const formAuth = new URLSearchParams({
      username: String(s.username ?? ''),
      password: String(s.password ?? ''),
    });

    let cookieHeader = '';
    try {
      const loginRes = await http.post(
        `${base}/api/v2/auth/login`,
        formAuth.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          maxRedirects: 0,
          validateStatus: () => true,
        },
      );
      const cookies = loginRes.headers['set-cookie'];
      if (!cookies?.length || loginRes.data === 'Fails.') {
        throw new BadRequestException('qBittorrent authentication failed');
      }
      cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.log.warn(`qBittorrent login error: ${(e as Error).message}`);
      throw new BadRequestException('Could not reach qBittorrent API');
    }

    // --- Add torrent ---
    // For magnet links: send URL directly.
    // For HTTP(S) URLs: download the .torrent file on the backend first,
    // then upload it to qBittorrent as a file so that:
    //   1. qBittorrent gets metadata immediately (proper name shown at once)
    //   2. qBittorrent does not need network access to the indexer
    let addRes: { status: number; data: unknown };
    let infoHash: string | undefined;

    // Snapshot the current torrent set BEFORE the add so we can recover
    // the just-added torrent's hash via list-diff if the URL didn't
    // surface one (base32-encoded magnet that an older regex didn't
    // catch, .torrent buffers we couldn't parse, custom add endpoints
    // returning HTML in the body, …). Cheap — qBit's `/torrents/info`
    // is a single GET we'd run within the next 60s anyway.
    const beforeHashes = await this.snapshotHashes(http, base, cookieHeader);

    if (torrentUrl.startsWith('magnet:')) {
      infoHash = extractMagnetInfoHash(torrentUrl);

      const formAdd = new URLSearchParams({ urls: torrentUrl });
      if (category) formAdd.set('category', category);
      addRes = await http.post(
        `${base}/api/v2/torrents/add`,
        formAdd.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieHeader,
          },
          validateStatus: () => true,
        },
      );
    } else {
      // Download the .torrent file from the indexer on our end. Some
      // indexers (LimeTorrents, a few Torznab proxies …) reply with a
      // 302 whose Location is a `magnet:` URI — Axios' default redirect
      // handler chokes on the magnet protocol, so we walk the redirect
      // chain ourselves and switch to the magnet path on first hit.
      const fetched = await this.fetchTorrentOrMagnet(http, torrentUrl);

      if ('magnet' in fetched) {
        this.log.log(
          `Indexer redirected to magnet — adding directly to qBittorrent`,
        );
        infoHash = extractMagnetInfoHash(fetched.magnet);
        const formAdd = new URLSearchParams({ urls: fetched.magnet });
        if (category) formAdd.set('category', category);
        addRes = await http.post(
          `${base}/api/v2/torrents/add`,
          formAdd.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Cookie: cookieHeader,
            },
            validateStatus: () => true,
          },
        );
      } else {
        const torrentBuffer = fetched.buffer;
        this.log.log(`Downloaded .torrent OK (${torrentBuffer.length} bytes)`);

        // Compute info hash from the raw bencoded "info" dictionary
        infoHash = this.computeInfoHash(torrentBuffer);

        // Upload the .torrent file to qBittorrent via multipart
        const fd = new FormData();
        fd.append('torrents', torrentBuffer, {
          filename: 'download.torrent',
          contentType: 'application/x-bittorrent',
        });
        if (category) fd.append('category', category);

        addRes = await http.post(`${base}/api/v2/torrents/add`, fd, {
          headers: { ...fd.getHeaders(), Cookie: cookieHeader },
          validateStatus: () => true,
        });
      }
    }

    if (addRes.status !== 200) {
      throw new BadRequestException(
        `qBittorrent refused the torrent (HTTP ${addRes.status})`,
      );
    }

    // Recovery path: when none of the upfront extractors produced a
    // hash, ask qBit for its torrent list and diff against the snapshot
    // we took before the add. qBit takes a few hundred ms to index a
    // new entry, so retry a handful of times before giving up.
    if (!infoHash) {
      infoHash = await this.recoverNewlyAddedHash(
        http,
        base,
        cookieHeader,
        beforeHashes,
      );
      if (infoHash) {
        this.log.log(
          `qBittorrent: recovered hash=${infoHash} via list-diff after add (upfront extractor returned none)`,
        );
      } else {
        this.log.warn(
          `qBittorrent: could not recover hash for newly-added torrent — Activities row will rely on name match until next tick`,
        );
      }
    }

    return infoHash ?? '';
  }

  /** Snapshot every torrent's hash currently known by qBit. Used as the
   *  "before" set for {@link recoverNewlyAddedHash}. */
  private async snapshotHashes(
    http: AxiosInstance,
    base: string,
    cookieHeader: string,
  ): Promise<Set<string>> {
    try {
      const res = await http.get(`${base}/api/v2/torrents/info`, {
        headers: { Cookie: cookieHeader },
        validateStatus: () => true,
      });
      if (res.status !== 200 || !Array.isArray(res.data)) return new Set();
      return new Set(
        (res.data as { hash?: string }[])
          .map((t) => t.hash?.toLowerCase())
          .filter((h): h is string => !!h),
      );
    } catch {
      return new Set();
    }
  }

  /** Poll `/torrents/info` for the newly-added torrent and return its
   *  hash. Compares against `before` to find the diff. ~3s budget split
   *  in retries: qBit needs a few hundred ms to register a magnet that
   *  hasn't fetched metadata yet. */
  private async recoverNewlyAddedHash(
    http: AxiosInstance,
    base: string,
    cookieHeader: string,
    before: Set<string>,
  ): Promise<string | undefined> {
    const ATTEMPTS = 6;
    const DELAY_MS = 500;
    for (let i = 0; i < ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      const res = await http.get(`${base}/api/v2/torrents/info`, {
        headers: { Cookie: cookieHeader },
        validateStatus: () => true,
      });
      if (res.status !== 200 || !Array.isArray(res.data)) continue;
      const after = res.data as { hash?: string; added_on?: number }[];
      const fresh = after.filter(
        (t) => t.hash && !before.has(t.hash.toLowerCase()),
      );
      if (fresh.length === 1) return fresh[0].hash!.toLowerCase();
      if (fresh.length > 1) {
        // Multiple new torrents (other consumer of the same qBit
        // instance racing us). Pick the most recently added — best
        // effort.
        fresh.sort((a, b) => (b.added_on ?? 0) - (a.added_on ?? 0));
        return fresh[0].hash!.toLowerCase();
      }
    }
    return undefined;
  }

  /**
   * Extract the SHA1 info hash from a raw .torrent file buffer.
   * Locates the bencoded "info" dict and hashes its raw bytes.
   */
  private computeInfoHash(buf: Buffer): string | undefined {
    // Find "4:info" key in the top-level dict
    const marker = Buffer.from('4:info');
    const idx = buf.indexOf(marker);
    if (idx === -1) return undefined;

    const start = idx + marker.length;
    // The value must be a dict starting with 'd'
    if (start >= buf.length || buf[start] !== 0x64 /* 'd' */) return undefined;

    // Walk the bencoded value to find its end
    const end = this.bencodedEnd(buf, start);
    if (end === -1) return undefined;

    return crypto
      .createHash('sha1')
      .update(buf.subarray(start, end))
      .digest('hex');
  }

  /** Return the byte position just past the bencoded value starting at `pos`. */
  private bencodedEnd(buf: Buffer, pos: number): number {
    if (pos >= buf.length) return -1;
    const ch = buf[pos];

    // Integer: i<digits>e
    if (ch === 0x69 /* 'i' */) {
      const e = buf.indexOf(0x65 /* 'e' */, pos + 1);
      return e === -1 ? -1 : e + 1;
    }

    // List (l...e) or Dict (d...e)
    if (ch === 0x6c /* 'l' */ || ch === 0x64 /* 'd' */) {
      let cur = pos + 1;
      while (cur < buf.length && buf[cur] !== 0x65 /* 'e' */) {
        cur = this.bencodedEnd(buf, cur);
        if (cur === -1) return -1;
      }
      return cur < buf.length ? cur + 1 : -1;
    }

    // Byte string: <length>:<data>
    if (ch >= 0x30 && ch <= 0x39 /* '0'-'9' */) {
      const colon = buf.indexOf(0x3a /* ':' */, pos);
      if (colon === -1) return -1;
      const len = parseInt(buf.subarray(pos, colon).toString('ascii'), 10);
      return colon + 1 + len;
    }

    return -1;
  }
}

import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import FormData from 'form-data';
import { DownloadClient } from './entities/download-client.entity';

export interface QbittorrentTorrent {
  hash: string;
  name: string;
  size: number;
  downloaded: number; // bytes downloaded so far
  progress: number; // 0–1
  dlspeed: number; // bytes/s
  upspeed: number; // bytes/s
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
  name: string;      // relative path within torrent
  size: number;
  progress: number;  // 0–1
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
        headers: { 'User-Agent': 'Suitarr/1.0' },
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
      headers: { 'User-Agent': 'Suitarr/1.0' },
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
      return res.data;
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
      headers: { 'User-Agent': 'Suitarr/1.0' },
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
      const cookieHeader = cookies.map((c: string) => c.split(';')[0]).join('; ');

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
      this.log.warn(`getTorrentFiles: error for hash ${hash}: ${(e as Error).message}`);
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
      headers: { 'User-Agent': 'Suitarr/1.0' },
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
   * Add a torrent to qBittorrent and return the info hash (lowercase hex).
   */
  async addTorrentUrl(
    client: DownloadClient,
    torrentUrl: string,
    mediaType?: 'movie' | 'series',
  ): Promise<string> {
    torrentUrl = this.sanitizeUrl(torrentUrl);
    const s = client.settings as Record<string, unknown>;
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
      headers: { 'User-Agent': 'Suitarr/1.0' },
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

    if (torrentUrl.startsWith('magnet:')) {
      // Extract info hash from magnet URI
      const btih = torrentUrl.match(/xt=urn:btih:([a-fA-F0-9]{40})/)?.[1];
      if (btih) infoHash = btih.toLowerCase();

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
      // Download the .torrent file from the indexer on our end
      this.log.log(`Downloading .torrent from: ${torrentUrl}`);
      let torrentBuffer: Buffer;
      try {
        const dlRes = await http.get<Buffer>(torrentUrl, {
          responseType: 'arraybuffer',
          timeout: 30_000,
          validateStatus: () => true,
        });
        if (dlRes.status !== 200) {
          this.log.error(
            `Indexer returned HTTP ${dlRes.status} for torrent download — URL: ${torrentUrl}`,
          );
          throw new BadRequestException(
            `Indexer returned HTTP ${dlRes.status} for torrent download`,
          );
        }
        torrentBuffer = Buffer.from(dlRes.data);
        this.log.log(`Downloaded .torrent OK (${torrentBuffer.length} bytes)`);
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        this.log.error(
          `Failed to download torrent file — URL: ${torrentUrl} — Error: ${(e as Error).message}`,
        );
        throw new BadRequestException(
          `Could not fetch torrent from indexer: ${(e as Error).message}`,
        );
      }

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

    if (addRes.status !== 200) {
      throw new BadRequestException(
        `qBittorrent refused the torrent (HTTP ${addRes.status})`,
      );
    }

    return infoHash ?? '';
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

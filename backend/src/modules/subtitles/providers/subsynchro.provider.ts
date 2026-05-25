import { Logger } from '@nestjs/common';
import {
  SubtitleProviderInterface,
  SubtitleSearchParams,
  SubtitleSearchResult,
} from './subtitle-provider.interface';

const BASE_URL = 'https://www.subsynchro.com';
const SEARCH_URL = `${BASE_URL}/include/ajax/subMarin.php`;
const USER_AGENT = 'Fliks';

interface SubsynchroSearchItem {
  titre: string;
  titre_original: string;
  release: string;
  filename: string;
  telechargement: string;
  fichier: string;
}

interface SubsynchroSettings {}

export class SubsynchroProvider implements SubtitleProviderInterface {
  private readonly logger = new Logger(SubsynchroProvider.name);

  constructor(private readonly settings: SubsynchroSettings) {}

  private get headers(): Record<string, string> {
    return {
      'User-Agent': USER_AGENT,
      Referer: BASE_URL,
    };
  }

  /**
   * Subsynchro only supports French subtitles for movies.
   * Based on Bazarr's implementation (subliminal_patch/providers/subsynchro.py).
   */
  async search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]> {
    // Subsynchro is movie-only — skip series
    if (params.season != null || params.episode != null) {
      return [];
    }

    const query = new URLSearchParams();
    query.set('title', params.title);
    if (params.year) query.set('year', String(params.year));

    let res: Response;
    try {
      res = await fetch(`${SEARCH_URL}?${query}`, {
        headers: this.headers,
      });
    } catch (e) {
      this.logger.warn(`Subsynchro search error: ${(e as Error).message}`);
      return [];
    }

    if (!res.ok) {
      this.logger.warn(`Subsynchro search failed: ${res.status}`);
      return [];
    }

    const body = (await res.json()) as {
      status: number;
      data: SubsynchroSearchItem[];
    };

    if (body.status !== 200 || !Array.isArray(body.data)) {
      return [];
    }

    return body.data.map((item) => {
      const label =
        item.release || item.filename || item.titre_original || item.titre;
      return {
        // Store the download URL as the provider file ID
        providerFileId: item.telechargement,
        title: label,
        releaseName: item.release || item.filename || undefined,
        language: 'fr',
        forced: false,
        hearingImpaired: false,
        score: 0,
        providerName: 'Subsynchro',
        providerType: 'subsynchro',
      };
    });
  }

  /**
   * Downloads a subtitle from Subsynchro.
   * The download may return a ZIP archive — if so, extract the first subtitle file.
   */
  async download(result: SubtitleSearchResult): Promise<Buffer> {
    const downloadUrl = result.providerFileId;
    // Resolve relative URLs
    const url = downloadUrl.startsWith('http')
      ? downloadUrl
      : `${BASE_URL}${downloadUrl.startsWith('/') ? '' : '/'}${downloadUrl}`;

    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Subsynchro download failed: ${res.status}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());

    // Check if the response is a ZIP archive (PK header)
    if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
      return this.extractSubtitleFromZip(buf);
    }

    return buf;
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${SEARCH_URL}?title=test`, {
        headers: this.headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Extracts the first subtitle file (.srt, .ass, .ssa, .sub) from a ZIP buffer.
   */
  private async extractSubtitleFromZip(zipBuffer: Buffer): Promise<Buffer> {
    // Use Node.js built-in zlib for basic ZIP extraction
    // ZIP files have local file headers starting with PK\x03\x04
    const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa', '.sub', '.vtt'];
    const entries = this.parseZipEntries(zipBuffer);

    for (const entry of entries) {
      const name = entry.name.toLowerCase();
      if (SUBTITLE_EXTS.some((ext) => name.endsWith(ext))) {
        return entry.data;
      }
    }

    // Fallback: return the first file
    if (entries.length > 0) {
      return entries[0].data;
    }

    throw new Error('No subtitle file found in ZIP archive');
  }

  /**
   * Minimal ZIP parser — extracts local file entries.
   */
  private parseZipEntries(buf: Buffer): { name: string; data: Buffer }[] {
    const entries: { name: string; data: Buffer }[] = [];
    let offset = 0;

    while (offset + 30 <= buf.length) {
      // Local file header signature = PK\x03\x04
      if (
        buf[offset] !== 0x50 ||
        buf[offset + 1] !== 0x4b ||
        buf[offset + 2] !== 0x03 ||
        buf[offset + 3] !== 0x04
      ) {
        break;
      }

      const compressionMethod = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const uncompressedSize = buf.readUInt32LE(offset + 22);
      const nameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);

      const name = buf.toString('utf8', offset + 30, offset + 30 + nameLen);
      const dataStart = offset + 30 + nameLen + extraLen;
      const dataEnd = dataStart + compressedSize;

      if (dataEnd > buf.length) break;

      if (compressedSize > 0 && !name.endsWith('/')) {
        let data = buf.subarray(dataStart, dataEnd);

        // Decompress if deflated (method 8)
        if (compressionMethod === 8) {
          const zlib = require('zlib') as typeof import('zlib');
          data = zlib.inflateRawSync(data);
        } else if (compressionMethod !== 0) {
          // Skip unsupported compression methods
          offset = dataEnd;
          continue;
        }

        entries.push({ name, data });
      }

      offset = dataEnd;
    }

    return entries;
  }
}

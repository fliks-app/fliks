import path from 'node:path';
import type { DesktopDownloadItem, DesktopDownloadRequest } from '../shared/contract.ts';
import { obj, str } from './ipc-parse.ts';

/** An http(s) URL: the only schemes `net.request` should be handed from the page. */
export function httpUrl(v: unknown): string {
  const s = str(v, 8192);
  const { protocol } = new URL(s);
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error('invalid url');
  return s;
}

/** Rebuilds the renderer's request field by field. */
export function parseDownloadRequest(v: unknown): DesktopDownloadRequest {
  const o = obj(v);
  return {
    id: str(o.id, 200),
    url: httpUrl(o.url),
    ...(o.filename !== undefined ? { filename: str(o.filename, 1000) } : {}),
    ...(o.quality !== undefined ? { quality: str(o.quality, 100) } : {}),
  };
}

const EXT_BY_TYPE: Record<string, string> = {
  'video/x-matroska': '.mkv',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/mp2t': '.ts',
  'video/webm': '.webm',
};

/** Extension for the on-disk file, from Content-Disposition then Content-Type. */
export function resolveExt(headers: Record<string, string | string[]>): string {
  const cd = headers['content-disposition'];
  const disp = Array.isArray(cd) ? cd[0] : cd;
  const m = disp && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
  if (m) {
    let name = m[1].trim();
    try {
      name = decodeURIComponent(name);
    } catch {
      // A stray % is not an encoding: the Content-Type decides.
      name = '';
    }
    const ext = path.extname(name);
    if (ext) return ext;
  }
  const ct = headers['content-type'];
  const type = (Array.isArray(ct) ? ct[0] : ct)?.split(';')[0].trim();
  return (type && EXT_BY_TYPE[type]) || '.bin';
}

/** The manifest file's content, or a throw when it is not an id → item object. */
export function parseManifest(text: string): Record<string, DesktopDownloadItem> {
  const v: unknown = JSON.parse(text);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('manifest is not an object');
  return v as Record<string, DesktopDownloadItem>;
}

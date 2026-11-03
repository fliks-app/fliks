import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { AuthService } from './auth.service';
import { DownloadCacheService, type OfflineBook } from './download-cache.service';
import { ServerConfigService } from './server-config.service';

const DB = 'fliks-offline-books';
const STORE = 'blobs';
const PARALLEL = 6;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
/** Attributes of a chapter that load a resource the toolkit does not route through its fetcher. */
const RESOURCE_ATTRS: [string, string][] = [
  ['img', 'src'], ['source', 'src'], ['audio', 'src'], ['video', 'src'], ['video', 'poster'],
  ['link', 'href'], ['image', 'href'], ['image', 'xlink:href'],
];

/** Where the files of a book download live: IndexedDB blobs (EPUB publications, PDF, and audio outside the mobile apps), or a file
 *  on disk for the audio of the mobile apps, which the WebView streams by range instead of holding it in memory. */
@Injectable({ providedIn: 'root' })
export class OfflineBookStoreService {
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly cache = inject(DownloadCacheService);

  private db: Promise<IDBDatabase> | null = null;
  /** Object URLs handed to chapters, so a resource shared by several is made once. */
  private readonly urls = new Map<string, string>();

  manifestUrl(itemId: number): string {
    return new URL(this.serverConfig.resolveUrl(`/api/books/${itemId}/pub/manifest.json`), document.baseURI).href;
  }

  /** The reader's fetch: a stored resource when the book is on the device, else the network with the app's credentials. */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    if ((init?.method ?? 'GET') === 'GET') {
      const blob = await this.stored(url).catch(() => null);
      if (blob) return new Response(await (await this.inline(url, blob)).arrayBuffer(), { headers: { 'content-type': blob.type } });
    }
    return this.network(input, init);
  }

  /** Stores the sanitised publication of an EPUB: its manifest and every resource the manifest names. Returns the bytes kept. */
  async storeEpub(itemId: number, onProgress: (fraction: number) => void): Promise<number> {
    const manifestUrl = this.manifestUrl(itemId);
    const manifest = await (await this.ok(manifestUrl)).blob();
    const json = JSON.parse(await manifest.text()) as Record<string, { href?: string; templated?: boolean }[] | undefined>;
    const urls = [...new Set([...(json['readingOrder'] ?? []), ...(json['resources'] ?? []), ...(json['links'] ?? [])]
      .filter((l) => l.href && !l.templated)
      .map((l) => new URL(l.href!, manifestUrl).href.split('#')[0]))].filter((u) => u !== manifestUrl);
    await this.put(this.key(manifestUrl), manifest);
    let bytes = manifest.size;
    let done = 0;
    for (let i = 0; i < urls.length; i += PARALLEL) {
      await Promise.all(
        urls.slice(i, i + PARALLEL).map(async (u) => {
          const blob = await (await this.ok(u)).blob();
          await this.put(this.key(u), blob);
          bytes += blob.size;
          onProgress(++done / urls.length);
        }),
      );
    }
    return bytes;
  }

  /** Stores one file of a book under `key` from `url` (it carries its own token). Returns the bytes kept. */
  async storeFile(book: Pick<OfflineBook, 'family'>, key: string, url: string, onProgress: (fraction: number) => void): Promise<number> {
    if (this.onDisk(book)) {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const path = this.path(key);
      const listener = await Filesystem.addListener('progress', (e) => {
        if (e.url === url && e.contentLength > 0) onProgress(e.bytes / e.contentLength);
      });
      try {
        await Filesystem.downloadFile({ url, path, directory: Directory.Data, recursive: true, progress: true });
        return (await Filesystem.stat({ path, directory: Directory.Data })).size;
      } finally {
        await listener.remove();
      }
    }
    const res = await this.ok(url);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body?.getReader();
    if (!reader) {
      const blob = await res.blob();
      await this.put(this.fileKey(key), blob);
      return blob.size;
    }
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      chunks.push(r.value as Uint8Array<ArrayBuffer>);
      received += r.value.length;
      if (total) onProgress(received / total);
    }
    await this.put(this.fileKey(key), new Blob(chunks, { type: res.headers.get('content-type') ?? '' }));
    return received;
  }

  /** A URL the reader or the audio element can load for a stored file, or null when it is not on the device. */
  async fileUrl(book: Pick<OfflineBook, 'family'>, key: string): Promise<string | null> {
    try {
      if (this.onDisk(book)) {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        const path = this.path(key);
        await Filesystem.stat({ path, directory: Directory.Data });
        return Capacitor.convertFileSrc((await Filesystem.getUri({ path, directory: Directory.Data })).uri);
      }
      const blob = await this.get(this.fileKey(key));
      return blob ? URL.createObjectURL(blob) : null;
    } catch {
      return null;
    }
  }

  async has(book: OfflineBook): Promise<boolean> {
    if (book.family === 'text' && book.format === 'epub') return !!(await this.get(this.key(this.manifestUrl(book.itemId))).catch(() => null));
    for (const f of book.files) if (!(await this.fileUrl(book, f.key))) return false;
    return true;
  }

  async remove(book: OfflineBook): Promise<void> {
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls.clear();
    try {
      if (book.family === 'text' && book.format === 'epub') {
        const prefix = this.key(this.manifestUrl(book.itemId).replace(/manifest\.json$/, ''));
        await this.tx('readwrite', (s) => s.delete(IDBKeyRange.bound(prefix, `${prefix}￿`)));
      }
      for (const f of book.files) {
        if (this.onDisk(book)) {
          const { Filesystem, Directory } = await import('@capacitor/filesystem');
          await Filesystem.deleteFile({ path: this.path(f.key), directory: Directory.Data }).catch(() => undefined);
        } else {
          await this.tx('readwrite', (s) => s.delete(this.fileKey(f.key)));
        }
      }
    } catch {
      // Nothing stored under that key.
    }
  }

  private onDisk(book: Pick<OfflineBook, 'family'>): boolean {
    return Capacitor.isNativePlatform() && book.family === 'audio';
  }

  private path(key: string): string {
    return `fliks-downloads/book-${key}`;
  }

  /** Stored per (server, user), like the task list that owns them. */
  private key(rest: string): string {
    return `${this.cache.scopeSuffix()}|${rest}`;
  }

  private fileKey(key: string): string {
    return this.key(`file|${key}`);
  }

  private async network(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    const token = this.auth.accessToken;
    if (this.serverConfig.isNative && token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers, credentials: this.serverConfig.isNative ? 'omit' : 'include' });
  }

  private async ok(url: string): Promise<Response> {
    const res = await this.network(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res;
  }

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }

  private async tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const r = run(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  private put(key: string, blob: Blob): Promise<unknown> {
    return this.tx('readwrite', (s) => s.put(blob, key));
  }

  private async get(key: string): Promise<Blob | null> {
    return (await this.tx<Blob | undefined>('readonly', (s) => s.get(key))) ?? null;
  }

  private stored(url: string): Promise<Blob | null> {
    return this.get(this.key(url.split('#')[0]));
  }

  /** A chapter or stylesheet whose resources point at the stored copies: the toolkit loads them from the page's base URL, which has no network. */
  private async inline(url: string, blob: Blob): Promise<Blob> {
    if (/css/.test(blob.type)) return new Blob([await this.css(url, await blob.text())], { type: blob.type });
    if (!/html/.test(blob.type)) return blob;
    const doc = new DOMParser().parseFromString(await blob.text(), 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) return blob;
    for (const [tag, attr] of RESOURCE_ATTRS) {
      for (const el of Array.from(doc.querySelectorAll(tag))) {
        const local = await this.objectUrl(el.getAttribute(attr), url);
        if (local) el.setAttribute(attr, local);
      }
    }
    for (const style of Array.from(doc.querySelectorAll('style'))) style.textContent = await this.css(url, style.textContent ?? '');
    return new Blob([new XMLSerializer().serializeToString(doc)], { type: blob.type });
  }

  private async css(url: string, text: string): Promise<string> {
    const local = new Map<string, string>();
    for (const ref of new Set(Array.from(text.matchAll(CSS_URL), (m) => m[2]))) {
      const u = await this.objectUrl(ref, url);
      if (u) local.set(ref, u);
    }
    return text.replace(CSS_URL, (m, _q, ref: string) => (local.has(ref) ? `url("${local.get(ref)}")` : m));
  }

  private async objectUrl(ref: string | null, base: string): Promise<string | null> {
    if (!ref || /^(data:|blob:|#)/.test(ref)) return null;
    let abs: string;
    try {
      abs = new URL(ref, base).href.split('#')[0];
    } catch {
      return null;
    }
    const known = this.urls.get(abs);
    if (known) return known;
    const blob = await this.stored(abs).catch(() => null);
    if (!blob) return null;
    const u = URL.createObjectURL(await this.inline(abs, blob));
    this.urls.set(abs, u);
    return u;
  }
}

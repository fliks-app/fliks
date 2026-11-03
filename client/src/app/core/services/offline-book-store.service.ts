import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { desktopDownloaderOrNull } from '../plugins/desktop-downloader.bridge';
import { AuthService } from './auth.service';
import { DownloadCacheService, type OfflineBook } from './download-cache.service';
import { ServerConfigService } from './server-config.service';

const DB = 'fliks-offline-books';
const STORE = 'blobs';
const PARALLEL = 6;
const CHUNK_BYTES = 8 << 20;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
/** Attributes of a chapter that load a resource the toolkit does not route through its fetcher. */
const RESOURCE_ATTRS: [string, string][] = [
  ['img', 'src'], ['source', 'src'], ['audio', 'src'], ['video', 'src'], ['video', 'poster'],
  ['link', 'href'], ['image', 'href'], ['image', 'xlink:href'],
];

/** Where the files of a book download live: IndexedDB blobs (EPUB publications, PDF, and audio on the web, in fixed-size chunks), or a
 *  file on disk for the audio of the apps (mobile and desktop), which is streamed by range instead of held in memory. */
@Injectable({ providedIn: 'root' })
export class OfflineBookStoreService {
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly cache = inject(DownloadCacheService);

  private readonly desktop = desktopDownloaderOrNull();
  private db: Promise<IDBDatabase> | null = null;
  private persisted = false;
  /** Object URLs handed to chapters (by resource URL) and to players (by file key), so each is made once and revoked with its book. */
  private readonly urls = new Map<string, string>();
  private readonly fileUrls = new Map<string, string>();

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
  async storeEpub(itemId: number, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<number> {
    void this.persist();
    const manifestUrl = this.manifestUrl(itemId);
    const manifest = await (await this.ok(manifestUrl, signal)).blob();
    const json = JSON.parse(await manifest.text()) as Record<string, { href?: string; templated?: boolean }[] | undefined>;
    const urls = [...new Set([...(json['readingOrder'] ?? []), ...(json['resources'] ?? []), ...(json['links'] ?? [])]
      .filter((l) => l.href && !l.templated)
      .map((l) => new URL(l.href!, manifestUrl).href.split('#')[0]))].filter((u) => u !== manifestUrl);
    await this.put(this.key(manifestUrl), manifest, signal);
    let bytes = manifest.size;
    let done = 0;
    for (let i = 0; i < urls.length; i += PARALLEL) {
      await Promise.all(
        urls.slice(i, i + PARALLEL).map(async (u) => {
          const blob = await (await this.ok(u, signal)).blob();
          await this.put(this.key(u), blob, signal);
          bytes += blob.size;
          onProgress(++done / urls.length);
        }),
      );
    }
    return bytes;
  }

  /** Stores one file of a book under `key` from `url` (it carries its own token). Returns the bytes kept. */
  async storeFile(
    book: Pick<OfflineBook, 'family'>,
    key: string,
    url: string,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    if (this.desktop && this.onDisk(book)) {
      // The bridge reports no progress: the file is whole or absent.
      const probe = await this.ok(url, signal, { Range: 'bytes=0-0' });
      void probe.body?.cancel();
      const size = Number(probe.headers.get('content-range')?.split('/')[1] ?? probe.headers.get('content-length')) || 0;
      if (!(await this.desktop.saveFile(this.diskName(key), url))) throw new Error(`desktop download failed ${key}`);
      onProgress(1);
      return size;
    }
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
    void this.persist();
    const res = await this.ok(url, signal);
    const type = res.headers.get('content-type') ?? '';
    const total = Number(res.headers.get('content-length')) || 0;
    const fk = this.fileKey(key);
    const reader = res.body?.getReader();
    let received = 0;
    let n = 0;
    let pending: BlobPart[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (!pendingBytes) return;
      await this.put(this.chunkKey(fk, n++), new Blob(pending, { type }), signal);
      pending = [];
      pendingBytes = 0;
    };
    if (reader) {
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        pending.push(r.value as Uint8Array<ArrayBuffer>);
        pendingBytes += r.value.length;
        received += r.value.length;
        if (total) onProgress(received / total);
        if (pendingBytes >= CHUNK_BYTES) await flush();
      }
    } else {
      const blob = await res.blob();
      pending = [blob];
      pendingBytes = received = blob.size;
    }
    await flush();
    // Written last: a file with no header is a download that did not finish.
    await this.put(fk, new Blob([JSON.stringify({ chunks: n, type })]), signal);
    return received;
  }

  /** A URL the reader or the audio element can load for a stored file, or null when it is not on the device. */
  async fileUrl(book: Pick<OfflineBook, 'family'>, key: string): Promise<string | null> {
    try {
      if (this.desktop && this.onDisk(book)) return await this.desktop.fileUrl(this.diskName(key));
      if (this.onDisk(book)) {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        const path = this.path(key);
        await Filesystem.stat({ path, directory: Directory.Data });
        return Capacitor.convertFileSrc((await Filesystem.getUri({ path, directory: Directory.Data })).uri);
      }
      const fk = this.fileKey(key);
      const known = this.fileUrls.get(fk);
      if (known) return known;
      const header = await this.get(fk);
      if (!header) return null;
      const { chunks, type } = JSON.parse(await header.text()) as { chunks: number; type: string };
      const parts: Blob[] = [];
      for (let i = 0; i < chunks; i++) {
        const part = await this.get(this.chunkKey(fk, i));
        if (!part) return null;
        parts.push(part);
      }
      const u = URL.createObjectURL(new Blob(parts, { type }));
      this.fileUrls.set(fk, u);
      return u;
    } catch {
      return null;
    }
  }

  async has(book: OfflineBook): Promise<boolean> {
    if (book.family === 'text' && book.format === 'epub') return !!(await this.get(this.key(this.manifestUrl(book.itemId))).catch(() => null));
    for (const f of book.files) {
      if (this.onDisk(book) ? !(await this.fileUrl(book, f.key)) : !(await this.get(this.fileKey(f.key)).catch(() => null))) return false;
    }
    return true;
  }

  async remove(book: OfflineBook): Promise<void> {
    const manifestDir = this.manifestUrl(book.itemId).replace(/manifest\.json$/, '');
    for (const [abs, u] of this.urls) {
      if (!abs.startsWith(manifestDir)) continue;
      URL.revokeObjectURL(u);
      this.urls.delete(abs);
    }
    try {
      if (book.family === 'text' && book.format === 'epub') {
        const prefix = this.key(manifestDir);
        await this.tx('readwrite', (s) => s.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`)));
      }
      for (const f of book.files) {
        if (this.desktop && this.onDisk(book)) {
          await this.desktop.deleteFile(this.diskName(f.key));
        } else if (this.onDisk(book)) {
          const { Filesystem, Directory } = await import('@capacitor/filesystem');
          await Filesystem.deleteFile({ path: this.path(f.key), directory: Directory.Data }).catch(() => undefined);
        } else {
          const fk = this.fileKey(f.key);
          const u = this.fileUrls.get(fk);
          if (u) URL.revokeObjectURL(u);
          this.fileUrls.delete(fk);
          await this.tx('readwrite', (s) => s.delete(fk));
          await this.tx('readwrite', (s) => s.delete(IDBKeyRange.bound(`${fk}|`, `${fk}|\uffff`)));
        }
      }
    } catch {
      // Nothing stored under that key.
    }
  }

  private onDisk(book: Pick<OfflineBook, 'family'>): boolean {
    return (Capacitor.isNativePlatform() || !!this.desktop) && book.family === 'audio';
  }

  /** On-disk file name, prefixed by a hash of the (server, user) scope so two servers' item ids never meet. */
  private diskName(key: string): string {
    let h = 5381;
    for (const c of this.cache.scopeSuffix()) h = (Math.imul(h, 33) + c.charCodeAt(0)) >>> 0;
    return `book-${h.toString(16)}-${key}`;
  }

  private path(key: string): string {
    return `fliks-downloads/${this.diskName(key)}`;
  }

  private chunkKey(fileKey: string, i: number): string {
    return `${fileKey}|${String(i).padStart(6, '0')}`;
  }

  /** Asks the browser not to evict the stored books under storage pressure, once. */
  private async persist(): Promise<void> {
    if (this.persisted) return;
    this.persisted = true;
    await navigator.storage?.persist?.().catch(() => false);
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

  private async ok(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<Response> {
    const res = await this.network(url, { signal, headers });
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

  private put(key: string, blob: Blob, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    return this.tx('readwrite', (s) => s.put(blob, key));
  }

  private async get(key: string): Promise<Blob | null> {
    return (await this.tx<Blob | undefined>('readonly', (s) => s.get(key))) ?? null;
  }

  private stored(url: string): Promise<Blob | null> {
    return this.get(this.key(url.split('#')[0]));
  }

  /** A chapter or stylesheet whose resources point at the stored copies: the toolkit loads them from the page's base URL, which has no network. */
  private async inline(url: string, blob: Blob, seen: Set<string> = new Set([url])): Promise<Blob> {
    if (/css/.test(blob.type)) return new Blob([await this.css(url, await blob.text(), seen)], { type: blob.type });
    if (!/html/.test(blob.type)) return blob;
    const doc = new DOMParser().parseFromString(await blob.text(), 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) return blob;
    for (const [tag, attr] of RESOURCE_ATTRS) {
      for (const el of Array.from(doc.querySelectorAll(tag))) {
        const local = await this.objectUrl(el.getAttribute(attr), url, seen);
        if (local) el.setAttribute(attr, local);
      }
    }
    for (const style of Array.from(doc.querySelectorAll('style'))) style.textContent = await this.css(url, style.textContent ?? '', seen);
    return new Blob([new XMLSerializer().serializeToString(doc)], { type: blob.type });
  }

  private async css(url: string, text: string, seen: Set<string>): Promise<string> {
    const local = new Map<string, string>();
    for (const ref of new Set(Array.from(text.matchAll(CSS_URL), (m) => m[2]))) {
      const u = await this.objectUrl(ref, url, seen);
      if (u) local.set(ref, u);
    }
    return text.replace(CSS_URL, (m, _q, ref: string) => (local.has(ref) ? `url("${local.get(ref)}")` : m));
  }

  /** `seen` is the chain of stylesheets being inlined, so an `@import` cycle ends instead of recursing. */
  private async objectUrl(ref: string | null, base: string, seen: Set<string>): Promise<string | null> {
    if (!ref || /^(data:|blob:|#)/.test(ref)) return null;
    let abs: string;
    try {
      abs = new URL(ref, base).href.split('#')[0];
    } catch {
      return null;
    }
    const known = this.urls.get(abs);
    if (known) return known;
    if (seen.has(abs)) return null;
    const blob = await this.stored(abs).catch(() => null);
    if (!blob) return null;
    const u = URL.createObjectURL(await this.inline(abs, blob, new Set(seen).add(abs)));
    this.urls.set(abs, u);
    return u;
  }
}

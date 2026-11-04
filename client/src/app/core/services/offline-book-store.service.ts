import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { desktopDownloaderOrNull } from '../plugins/desktop-downloader.bridge';
import { AuthService } from './auth.service';
import { DownloadCacheService, type OfflineBook } from './download-cache.service';
import { ServerConfigService } from './server-config.service';
import { scopeHash } from '../utils/scope-hash';

const DB = 'fliks-offline-books';
const STORE = 'blobs';
const PARALLEL = 6;
const CHUNK_BYTES = 8 << 20;
const BOOK_DIR = /^.*?\/api\/books\/\d+\/pub\//;
/** `url(ref)` (group 2) or the string form `@import "ref"` (group 4). */
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(['"])(.*?)\3/gi;
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
  private readonly urls = new Map<string, Promise<string | null>>();
  /** Bumped by `release`, so inlining still running for a closed book makes no object URL. */
  private readonly generations = new Map<string, number>();
  /** The resources each chapter or stylesheet being inlined is waiting on, to break `@import` cycles. */
  private readonly waits = new Map<string, string[]>();
  private readonly fileUrls = new Map<string, string>();

  manifestUrl(itemId: number): string {
    return new URL(this.serverConfig.resolveUrl(`/api/books/${itemId}/pub/manifest.json`), document.baseURI).href;
  }

  /** The reader's fetch: a stored resource when the book is on the device, else the network with the app's credentials.
   *  With `inline`, a chapter or stylesheet comes with its resources as object URLs when its frame cannot load them itself. */
  async fetch(input: RequestInfo | URL, init?: RequestInit, inline = true): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    const get = (init?.method ?? 'GET') === 'GET';
    const generation = this.generation(url);
    const stale = () => this.generation(url) !== generation;
    if (get) {
      const blob = await this.stored(url).catch(() => null);
      if (blob) return this.response(inline ? await this.inline(url, blob, stale) : blob);
    }
    const res = await this.network(input, init);
    // An app's frame is cross-origin to the server and has no cookie to send.
    if (!inline || !get || !res.ok || !this.serverConfig.isNative || !/html|css/.test(res.headers.get('content-type') ?? '')) return res;
    return this.response(await this.inline(url, await res.blob(), stale));
  }

  /** Revokes the object URLs handed to a book's chapters; the next open makes them again. */
  release(itemId: number): void {
    const dir = this.manifestUrl(itemId).replace(/manifest\.json$/, '');
    this.generations.set(dir, this.generation(dir) + 1);
    for (const [abs, u] of this.urls) {
      if (!abs.startsWith(dir)) continue;
      void u.then((made) => made && URL.revokeObjectURL(made));
      this.urls.delete(abs);
    }
  }

  private generation(url: string): number {
    return this.generations.get(BOOK_DIR.exec(url)?.[0] ?? '') ?? 0;
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
    this.release(book.itemId);
    try {
      if (book.family === 'text' && book.format === 'epub') {
        const prefix = this.key(this.manifestUrl(book.itemId).replace(/manifest\.json$/, ''));
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
    return `book-${scopeHash(this.cache.scopeSuffix())}-${key}`;
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

  private async response(blob: Blob): Promise<Response> {
    return new Response(await blob.arrayBuffer(), { headers: { 'content-type': blob.type } });
  }

  private stored(url: string): Promise<Blob | null> {
    return this.get(this.key(url.split('#')[0]));
  }

  /** A chapter or stylesheet whose resources point at the stored copies: the toolkit loads them from the page's base URL, which has no network. */
  private async inline(url: string, blob: Blob, stale: () => boolean, owner = url): Promise<Blob> {
    if (/css/.test(blob.type)) return new Blob([await this.css(url, await blob.text(), stale, owner)], { type: blob.type });
    if (!/html/.test(blob.type)) return blob;
    const doc = new DOMParser().parseFromString(await blob.text(), 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) return blob;
    const attrs = RESOURCE_ATTRS.flatMap(([tag, attr]) =>
      Array.from(doc.querySelectorAll(tag), async (el) => {
        const local = await this.objectUrl(el.getAttribute(attr), url, stale, owner);
        if (local) el.setAttribute(attr, local);
      }),
    );
    const styles = Array.from(doc.querySelectorAll('style'), async (style) => {
      style.textContent = await this.css(url, style.textContent ?? '', stale, owner);
    });
    await Promise.all([...attrs, ...styles]);
    return new Blob([new XMLSerializer().serializeToString(doc)], { type: blob.type });
  }

  private async css(url: string, text: string, stale: () => boolean, owner: string): Promise<string> {
    const refs = [...new Set(Array.from(text.matchAll(CSS_URL), (m) => m[2] ?? m[4]))];
    const local = new Map(await Promise.all(refs.map(async (ref) => [ref, await this.objectUrl(ref, url, stale, owner)] as const)));
    return text.replace(CSS_URL, (m, _q, ref: string | undefined, _q2, imported: string | undefined) => {
      const u = local.get(ref ?? imported ?? '');
      if (!u) return m;
      return ref === undefined ? `@import "${u}"` : `url("${u}")`;
    });
  }

  /** A resource of the same book from the server, in the apps only: anything else would get the app's token. */
  private async served(abs: string, base: string): Promise<Blob | null> {
    const dir = BOOK_DIR.exec(base)?.[0];
    if (!this.serverConfig.isNative || !dir || !abs.startsWith(dir)) return null;
    // A redirect would carry the token to wherever it points.
    const res = await this.network(abs, { redirect: 'error' }).catch(() => null);
    return res?.ok ? res.blob().catch(() => null) : null;
  }

  /** One object URL per resource, shared by the chapters being inlined at once, its `#fragment` kept on the URL
   *  handed out. `owner` is the chapter or stylesheet asking: waiting on its own importer would never end. */
  private async objectUrl(ref: string | null, base: string, stale: () => boolean, owner: string): Promise<string | null> {
    if (!ref || /^(data:|blob:|#)/.test(ref)) return null;
    let parsed: URL;
    try {
      parsed = new URL(ref, base);
    } catch {
      return null;
    }
    const hash = parsed.hash;
    parsed.hash = '';
    const abs = parsed.href;
    if (stale() || this.waitsOn(abs, owner)) return null;
    let made = this.urls.get(abs);
    if (!made) {
      made = this.make(abs, base, stale).catch(() => null);
      this.urls.set(abs, made);
    }
    const waiting = this.waits.get(owner) ?? [];
    this.waits.set(owner, waiting);
    waiting.push(abs);
    let u: string | null;
    try {
      u = await made;
    } finally {
      waiting.splice(waiting.indexOf(abs), 1);
      if (!waiting.length) this.waits.delete(owner);
    }
    if (!u && this.urls.get(abs) === made) this.urls.delete(abs);
    return u && u + hash;
  }

  private async make(abs: string, base: string, stale: () => boolean): Promise<string | null> {
    const blob = (await this.stored(abs).catch(() => null)) ?? (await this.served(abs, base));
    if (!blob) return null;
    const inlined = await this.inline(abs, blob, stale);
    return stale() ? null : URL.createObjectURL(inlined);
  }

  /** Whether `from` is, through the resources it waits on, waiting on `to`. */
  private waitsOn(from: string, to: string, visited = new Set<string>()): boolean {
    if (from === to) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    return (this.waits.get(from) ?? []).some((next) => this.waitsOn(next, to, visited));
  }
}

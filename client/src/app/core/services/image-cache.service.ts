import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { NetworkService } from './network.service';

/** Lazy-loaded Filesystem reference — the plugin doesn't exist on web. */
let _fs: typeof import('@capacitor/filesystem') | null = null;
async function getFs() {
  if (!_fs) _fs = await import('@capacitor/filesystem');
  return _fs;
}

const DIR = 'fliks-images';
const INDEX_KEY = 'fliks.imageCache.index';
/** Posters and stills only — a few tens of KB each, so the cap is about
 *  bounding the directory, not the bytes. */
const MAX_ENTRIES = 800;
/** Each store is a fetch plus a base64 round-trip over the Capacitor bridge;
 *  more than a couple at once visibly stalls a scrolling grid. */
const MAX_CONCURRENT_STORES = 2;

/**
 * On-disk cache for server artwork on native.
 *
 * The WebView's own URL cache is the only thing holding images there — no
 * service worker runs under Capacitor — and it is capacity-evicted and expires
 * with `Cache-Control`, so offline the grid comes up with a random subset of
 * its posters. This keeps a copy the app controls.
 *
 * Web is a no-op: the Angular service worker already caches `/api/images/**`.
 */
@Injectable({ providedIn: 'root' })
export class ImageCacheService {
  private readonly network = inject(NetworkService);
  /** Off on web, where the Angular service worker already does this. */
  readonly enabled = Capacitor.isNativePlatform();

  /** cache key → [filename, last use]. Mirrors the on-disk directory so a
   *  lookup costs nothing; a bridge `stat` per image would not be affordable. */
  private readonly index = new Map<string, [string, number]>();
  private readonly inFlight = new Set<string>();
  private readonly queue: string[] = [];
  private active = 0;
  private loaded = false;
  /** The sandbox container path changes across installs, so it is resolved at
   *  runtime rather than assumed. */
  private baseUri: Promise<string | null> | null = null;
  /** Settled value of {@link baseUri}, for the synchronous path. */
  private baseUriValue: string | null = null;

  /** Resolve the container path up front. Every cached image otherwise awaits
   *  this one bridge call, which leaves a whole cold-start grid without a src. */
  async warm(): Promise<void> {
    if (!this.enabled) return;
    this.load();
    await this.resolveBaseUri();
  }

  /**
   * Same as {@link resolve} but without the bridge, so a binding can set `src`
   * in the same frame. Null when the answer isn't already in memory — the
   * caller falls back to the async path.
   */
  resolveNow(remoteUrl: string): string | null {
    if (!this.cacheable(remoteUrl)) return remoteUrl;
    if (!this.baseUriValue) return null;
    this.load();
    const key = cacheKey(remoteUrl);
    const entry = this.index.get(key);
    if (!entry) return null;
    this.index.set(key, [entry[0], Date.now()]);
    return Capacitor.convertFileSrc(`${this.baseUriValue}/${entry[0]}`);
  }

  /**
   * URL to actually render for a remote image: the on-disk copy when there is
   * one, otherwise the remote URL — with a copy queued for next time.
   */
  async resolve(remoteUrl: string): Promise<string> {
    if (!this.cacheable(remoteUrl)) return remoteUrl;
    this.load();
    const key = cacheKey(remoteUrl);
    const entry = this.index.get(key);
    if (entry) {
      const base = await this.resolveBaseUri();
      if (base) {
        this.index.set(key, [entry[0], Date.now()]);
        return Capacitor.convertFileSrc(`${base}/${entry[0]}`);
      }
    }
    this.store(remoteUrl);
    return remoteUrl;
  }

  /** Queue a copy of a remote image for offline use. No-op when already
   *  cached, already queued, or offline. */
  store(remoteUrl: string): void {
    if (!this.cacheable(remoteUrl)) return;
    this.load();
    const key = cacheKey(remoteUrl);
    if (this.index.has(key) || this.inFlight.has(key)) return;
    if (!this.network.isOnline()) return;
    this.inFlight.add(key);
    this.queue.push(remoteUrl);
    this.pump();
  }

  /** Fetch and write now, bypassing the queue. Used to guarantee the artwork of
   *  a downloaded title is there rather than hoping it was scrolled past. */
  async prefetch(remoteUrl: string): Promise<boolean> {
    if (!this.cacheable(remoteUrl)) return false;
    this.load();
    const key = cacheKey(remoteUrl);
    if (this.index.has(key)) return true;
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return this.write(remoteUrl, key);
  }

  /** Only the server's own art. A TMDB URL rendered straight from a search
   *  result has nothing to do with offline use and would just churn the LRU. */
  private cacheable(url: string): boolean {
    return this.enabled && !!url && url.includes('/api/images/');
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT_STORES && this.queue.length) {
      const url = this.queue.shift()!;
      this.active++;
      void this.write(url, cacheKey(url)).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async write(url: string, key: string): Promise<boolean> {
    try {
      const response = await fetch(url);
      if (!response.ok) return false;
      const blob = await response.blob();
      if (!blob.size) return false;
      const data = await toBase64(blob);
      // Capacitor's local file server types the response off the extension, and
      // WebKit will not paint an image served as octet-stream.
      const name = `${key}.${extensionFor(blob.type)}`;

      const { Filesystem, Directory } = await getFs();
      await Filesystem.mkdir({
        path: DIR,
        directory: Directory.Data,
        recursive: true,
      }).catch(() => {
        /* already there */
      });
      await Filesystem.writeFile({ path: `${DIR}/${name}`, data, directory: Directory.Data });
      this.index.set(key, [name, Date.now()]);
      await this.evict();
      this.persist();
      return true;
    } catch {
      return false;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async evict(): Promise<void> {
    if (this.index.size <= MAX_ENTRIES) return;
    const stale = [...this.index.entries()]
      .sort((a, b) => a[1][1] - b[1][1])
      .slice(0, this.index.size - MAX_ENTRIES);
    const { Filesystem, Directory } = await getFs();
    for (const [key, [name]] of stale) {
      this.index.delete(key);
      await Filesystem.deleteFile({
        path: `${DIR}/${name}`,
        directory: Directory.Data,
      }).catch(() => {
        /* already gone */
      });
    }
  }

  private resolveBaseUri(): Promise<string | null> {
    this.baseUri ??= (async () => {
      try {
        const { Filesystem, Directory } = await getFs();
        const { uri } = await Filesystem.getUri({ path: DIR, directory: Directory.Data });
        this.baseUriValue = uri;
        return uri;
      } catch {
        return null;
      }
    })();
    return this.baseUri;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}') as Record<
        string,
        [string, number]
      >;
      for (const [key, entry] of Object.entries(raw)) {
        if (Array.isArray(entry)) this.index.set(key, entry);
      }
    } catch {
      /* corrupt index — start over, the files are just orphaned */
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(Object.fromEntries(this.index)));
    } catch {
      /* quota exceeded */
    }
  }
}

/** FNV-1a over the full URL — the size param and the server host both matter,
 *  and the digest keeps the result safe as a filename. */
function cacheKey(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${url.length.toString(16)}`;
}

function extensionFor(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/avif':
      return 'avif';
    case 'image/gif':
      return 'gif';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'jpg';
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

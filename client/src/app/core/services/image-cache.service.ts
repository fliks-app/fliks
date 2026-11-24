import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { DeviceService } from './device.service';
import { NetworkService } from './network.service';
import { whenIdle } from '../utils/when-idle';
import { viewTransitionDone } from '../../shared/utils/view-transition';

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
/** Eviction drops to this, so it runs once per ~100 stores instead of per store. */
const EVICT_TO = 700;
/** Each store is a fetch plus a base64 round-trip over the Capacitor bridge;
 *  more than a couple at once visibly stalls a scrolling grid. */
const MAX_CONCURRENT_STORES = 2;

/** On-disk artwork cache on native, where the capacity-evicted WebView cache leaves a random subset of posters offline.
 *  Web is a no-op: the Angular service worker already caches `/api/images/**`. */
@Injectable({ providedIn: 'root' })
export class ImageCacheService {
  private readonly network = inject(NetworkService);
  private readonly device = inject(DeviceService);

  /** Off on web (the service worker covers it) and on TV (no offline use there). */
  get enabled(): boolean {
    return Capacitor.isNativePlatform() && !this.device.isTv();
  }

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
    if (!this.enabled) {
      if (Capacitor.isNativePlatform()) void this.purge();
      return;
    }
    this.load();
    await this.resolveBaseUri();
  }

  /** Drops the directory and index a TV install wrote before the cache was turned off there; a no-op once the index key is gone. */
  private async purge(): Promise<void> {
    try {
      if (localStorage.getItem(INDEX_KEY) === null) return;
      const { Filesystem, Directory } = await getFs();
      await Filesystem.rmdir({ path: DIR, directory: Directory.Data, recursive: true }).catch(() => {
        /* never created */
      });
      localStorage.removeItem(INDEX_KEY);
    } catch {
      /* retried next launch */
    }
  }

  /** Like {@link resolve} without the bridge so `src` binds in the same frame; null when not already in memory. */
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

  /** URL to render: the on-disk copy if any, else the remote URL; the caller queues a copy once the image has loaded. */
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
    this.schedulePump();
  }

  private pumpScheduled = false;

  /** Copies wait out the view transition and an idle period: base64 and the native bridge took ~100 ms of a page opening. */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    void viewTransitionDone().then(() =>
      whenIdle(() => {
        this.pumpScheduled = false;
        this.pump();
      }),
    );
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
    return (
      this.enabled &&
      !!url &&
      (url.includes('/api/images/') || url.includes('/api/livetv/channels/'))
    );
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
      // The index is written at once after a batch: a crash must not leave it naming deleted files.
      if (await this.evict()) this.persist();
      else this.persistWhenIdle();
      return true;
    } catch {
      return false;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async evict(): Promise<boolean> {
    if (this.index.size <= MAX_ENTRIES) return false;
    const stale = [...this.index.entries()]
      .sort((a, b) => a[1][1] - b[1][1])
      .slice(0, this.index.size - EVICT_TO);
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
    return true;
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

  private persistScheduled = false;

  /** The index is rewritten once per idle period and when the app is hidden, not per stored image. */
  private persistWhenIdle(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    if (!this.hideListener) {
      this.hideListener = () => document.hidden && this.persist();
      document.addEventListener('visibilitychange', this.hideListener);
    }
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback;
    if (ric) ric(() => this.persist(), { timeout: 30_000 });
    else setTimeout(() => this.persist(), 5_000);
  }
  private hideListener?: () => void;

  private persist(): void {
    this.persistScheduled = false;
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(Object.fromEntries(this.index)));
    } catch {
      /* quota exceeded */
    }
  }
}

/** FNV-1a over the URL minus any `token` param (a Live TV logo's rotating token is the same image); size and host still count. */
export function cacheKey(url: string): string {
  const stable = stripToken(url);
  let hash = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) {
    hash ^= stable.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${stable.length.toString(16)}`;
}

function stripToken(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('token');
    return u.toString();
  } catch {
    return url;
  }
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

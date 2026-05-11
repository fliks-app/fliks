import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { Observable, of, tap } from 'rxjs';

/**
 * Stale-while-revalidate HTTP cache for GET /api/* requests.
 *
 * - Cache hit + fresh → return cached response, done.
 * - Cache hit + stale → return cached response, revalidate in background.
 * - Cache miss + online → fetch, cache, return.
 * - Cache miss + offline → let the request fail naturally.
 *
 * Storage: IndexedDB ("fliks-api-cache" database).
 */

export const REQUEST_CACHE_DB = 'fliks-api-cache';
const DB_NAME = REQUEST_CACHE_DB;
const DB_VERSION = 1;
const STORE_NAME = 'responses';

const CACHEABLE_PREFIXES = [
  '/api/media',
  '/api/playback/continue-watching',
  '/api/playback/recommendations',
  '/api/playback/history',
  '/api/playback/watched-ids',
  '/api/libraries/mine',
];

const EXCLUDED_PREFIXES = [
  '/api/auth',
  '/api/stream',
  '/api/playback/media/',
];

const DETAIL_PATTERN = /^\/api\/media\/\d+$/;
const TTL_LIST = 5 * 60_000;
const TTL_DETAIL = 60 * 60_000;

interface CacheEntry {
  url: string;
  body: any;
  timestamp: number;
}

// ── IndexedDB helpers ──

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function getCached(url: string): Promise<CacheEntry | null> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(url);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function putCache(url: string, body: any): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ url, body, timestamp: Date.now() } satisfies CacheEntry);
  } catch { /* ignore */ }
}

async function invalidatePrefix(prefix: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if ((cursor.key as string).startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
  } catch { /* ignore */ }
}

// ── Interceptor ──

function isCacheable(url: string): boolean {
  if (EXCLUDED_PREFIXES.some((p) => url.startsWith(p))) return false;
  return CACHEABLE_PREFIXES.some((p) => url.startsWith(p));
}

function isFresh(entry: CacheEntry, url: string): boolean {
  const ttl = DETAIL_PATTERN.test(url) ? TTL_DETAIL : TTL_LIST;
  return Date.now() - entry.timestamp < ttl;
}

function resourcePrefix(url: string): string {
  const m = url.match(/^(\/api\/[^/?]+)/);
  return m?.[1] ?? url;
}

export const cacheInterceptor: HttpInterceptorFn = (req, next) => {
  const url = req.urlWithParams;

  // Mutations → invalidate cache.
  if (req.method !== 'GET') {
    if (req.url.startsWith('/api/')) void invalidatePrefix(resourcePrefix(req.url));
    return next(req);
  }

  if (!isCacheable(url)) return next(req);

  return new Observable((subscriber) => {
    getCached(url).then((entry) => {
      if (entry) {
        // Serve cached immediately.
        subscriber.next(new HttpResponse({ status: 200, body: entry.body }));
        if (isFresh(entry, url)) {
          subscriber.complete();
          return;
        }
        // Stale → revalidate in background, don't emit network response to caller.
      }

      const networkEmit = !entry; // Only emit to subscriber if no cache was served.
      next(req).pipe(
        tap((event) => {
          if (event instanceof HttpResponse && event.status === 200) {
            void putCache(url, event.body);
          }
        }),
      ).subscribe({
        next: (event) => { if (networkEmit) subscriber.next(event); },
        error: (err) => { if (networkEmit) subscriber.error(err); else subscriber.complete(); },
        complete: () => subscriber.complete(),
      });
    }).catch(() => {
      // IndexedDB unavailable → pass through.
      next(req).subscribe(subscriber);
    });
  });
};

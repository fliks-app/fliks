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
  // Form-population endpoints — change rarely, dominate the media-detail
  // page load when reopened (profiles modal + library picker). SWR keeps
  // them fresh in the background without blocking render.
  '/api/libraries',
  '/api/profiles/quality',
  '/api/profiles/language',
  // Title details barely change; the request-poster fallback (rows without
  // stored local art) re-fetches them on every cold page open otherwise.
  '/api/metadata',
];

const EXCLUDED_PREFIXES = [
  '/api/auth',
  '/api/stream',
  '/api/playback/media/',
];

// Live query endpoints (external indexers / providers) — never cache. A stale
// hit here returns an old (often empty) result and only revalidates in the
// background, so the caller never sees the real response.
const EXCLUDED_PATTERNS = [
  /\/api\/media\/\d+\/(releases|upgrade-releases)/,
  /\/api\/media\/\d+\/seasons\/\d+\/releases/,
  /\/api\/media\/\d+\/episodes\/\d+\/releases/,
  /\/api\/media\/\d+\/subtitles\/search/,
];

const DETAIL_PATTERN = /^\/api\/media\/\d+$/;
const TTL_LIST = 5 * 60_000;
const TTL_DETAIL = 4 * 60 * 60_000;

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

/**
 * Wipe the cache's IDB store. Closes the module-level connection first
 * so `indexedDB.deleteDatabase` doesn't get stuck in the `blocked` state
 * (which then makes a subsequent delete hang forever waiting behind the
 * previous never-completed delete). Resolves within a short ceiling so a
 * stuck IDB doesn't gate a login spinner.
 */
export function clearRequestCache(): Promise<void> {
  const closeExisting = dbPromise
    ? dbPromise
        .then((db) => {
          try { db.close(); } catch { /* ignore */ }
        })
        .catch(() => {
          /* the open itself failed — nothing to close */
        })
    : Promise.resolve();
  dbPromise = null;
  return closeExisting.then(() => {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = done;
        req.onerror = done;
        req.onblocked = done;
      } catch {
        done();
        return;
      }
      // Safety net: some Capacitor WebViews never fire any of the events
      // when another tab/process holds a connection. Don't gate the UI on
      // it — the data is small (TTL-capped per-entry) and any stragglers
      // are overwritten on the next put().
      setTimeout(done, 500);
    });
  });
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

export async function invalidatePrefix(prefix: string): Promise<void> {
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
  if (EXCLUDED_PATTERNS.some((r) => r.test(url))) return false;
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

/** Opt-in hint for callers that want the freshest data on this specific
 *  request even when a fresh cache entry exists. Stripped before the
 *  request leaves the interceptor — the backend has no use for it. */
export const CACHE_BYPASS_HEADER = 'X-Cache-Bypass';

export const cacheInterceptor: HttpInterceptorFn = (req, next) => {
  const url = req.urlWithParams;

  // Mutations → invalidate cache.
  if (req.method !== 'GET') {
    if (req.url.startsWith('/api/')) void invalidatePrefix(resourcePrefix(req.url));
    return next(req);
  }

  if (!isCacheable(url)) return next(req);

  // Force-refresh path: skip the cache READ but still PUT the network
  // response so future cache-first callers get the refreshed value.
  if (req.headers.has(CACHE_BYPASS_HEADER)) {
    const cleanReq = req.clone({ headers: req.headers.delete(CACHE_BYPASS_HEADER) });
    return next(cleanReq).pipe(
      tap((event) => {
        if (event instanceof HttpResponse && event.status === 200) {
          void putCache(url, event.body);
        }
      }),
    );
  }

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

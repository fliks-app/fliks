import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { Observable, of, tap } from 'rxjs';

/** Stale-while-revalidate IndexedDB cache ("fliks-api-cache") for GET /api/*: stale hits revalidate in background, offline misses fail naturally. */

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
  // Rarely-changing form-population endpoints that dominate media-detail reopen; SWR refreshes them without blocking render.
  '/api/libraries',
  '/api/profiles/quality',
  '/api/profiles/language',
  // Title details barely change and the request-poster fallback re-fetches them cold; provider reads only (see EXCLUDED_PATTERNS).
  '/api/metadata',
];

const EXCLUDED_PREFIXES = [
  '/api/auth',
  '/api/stream',
  '/api/playback/media/',
  // A plugin route reaches whatever the plugin talks to — a tracker, a download client. This cache
  // ignores HTTP headers, so the proxy's `no-store` alone would not stop it.
  '/api/plugins',
];

// Live provider queries are never cached: a stale hit returns an old (often empty) result and only revalidates in background.
const EXCLUDED_PATTERNS = [
  /\/api\/media\/\d+\/subtitles\/search/,
  // These carry existingMediaId (library state): caching pins a title to "not in the library" after it was added.
  /^\/api\/metadata\/(search|trending|popular|upcoming|discover)\//,
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

/** Bumped by every wipe. Entries are keyed by path alone, so a response in
 *  flight for the previous account must not land in the new one's cache. */
let cacheGeneration = 0;

/** Past this, an entry is dead weight: too old to be a useful offline fallback,
 *  still scanned by every invalidation. Swept once per app start. */
const MAX_AGE = 7 * 24 * 60 * 60_000;
let pruned = false;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => { resolve(req.result); prune(req.result); };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Entries expire on read but are never deleted there, so a long-lived install
 *  keeps every URL it ever fetched and every invalidation pays for them. */
function prune(db: IDBDatabase): void {
  if (pruned) return;
  pruned = true;
  try {
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    const cutoff = Date.now() - MAX_AGE;
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if ((cursor.value as CacheEntry).timestamp < cutoff) cursor.delete();
      cursor.continue();
    };
  } catch { /* ignore */ }
}

/** Wipe the IDB store, closing the module-level connection first so `deleteDatabase` can't hang `blocked`; bounded so it never gates a login spinner. */
export function clearRequestCache(): Promise<void> {
  cacheGeneration++;
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
  pruned = false;
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
      // Safety net: some Capacitor WebViews fire no event when another process holds a connection; stragglers are overwritten on next put().
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

/** Defer the write past render: `store.put` structured-clones the body on the main thread (a 700-item list stutters the spinner). */
function putCacheWhenIdle(url: string, body: any, generation: number): void {
  const write = () => void putCache(url, body, generation);
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(write, { timeout: 2000 });
  else setTimeout(write, 0);
}

async function putCache(url: string, body: any, generation: number): Promise<void> {
  if (generation !== cacheGeneration) return;
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
    // Key cursor, not openCursor: only the key is read here, and deserializing
    // every cached body to drop it cost 5x more on a mid-size store.
    const req = store.openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if ((cursor.key as string).startsWith(prefix)) store.delete(cursor.key);
      cursor.continue();
    };
  } catch { /* ignore */ }
}

// ── Interceptor ──

export function isCacheable(url: string): boolean {
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

/** Opt-in: force fresh data for this request despite a fresh entry; stripped before it leaves the interceptor. */
export const CACHE_BYPASS_HEADER = 'X-Cache-Bypass';

export const cacheInterceptor: HttpInterceptorFn = (req, next) => {
  const url = req.urlWithParams;
  const generation = cacheGeneration;

  // Only a mutation the server accepted invalidates: a failed one offline would
  // otherwise wipe the very entries the app falls back on.
  if (req.method !== 'GET') {
    if (!req.url.startsWith('/api/')) return next(req);
    return next(req).pipe(
      tap((event) => {
        if (!(event instanceof HttpResponse)) return;
        const prefix = resourcePrefix(req.url);
        void invalidatePrefix(prefix);
        // An import creates media rows.
        if (prefix === '/api/imports') void invalidatePrefix('/api/media');
      }),
    );
  }

  if (!isCacheable(url)) return next(req);

  // Force-refresh path: skip the cache READ but still PUT the network
  // response so future cache-first callers get the refreshed value.
  if (req.headers.has(CACHE_BYPASS_HEADER)) {
    const cleanReq = req.clone({ headers: req.headers.delete(CACHE_BYPASS_HEADER) });
    return next(cleanReq).pipe(
      tap((event) => {
        if (event instanceof HttpResponse && event.status === 200) {
          putCacheWhenIdle(url, event.body, generation);
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
            putCacheWhenIdle(url, event.body, generation);
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

import { HttpEvent, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { finalize, Observable, of, share, tap } from 'rxjs';

/** IndexedDB cache ("fliks-api-cache") of the last known body of each GET /api/*. Invalidation marks
 *  entries stale and never deletes them: the body stays the offline fallback and the paint-first read. */

export const REQUEST_CACHE_DB = 'fliks-api-cache';
const DB_NAME = REQUEST_CACHE_DB;
const DB_VERSION = 2;
const STORE_NAME = 'responses';
const INVALIDATIONS_STORE = 'invalidations';

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

/** Bounds the store by count, not age: an entry is worth keeping however old it is. */
const MAX_ENTRIES = 500;

export interface CacheEntry {
  url: string;
  body: any;
  /** When the request that produced `body` was sent, so a response racing an invalidation is stale. */
  timestamp: number;
}

interface Invalidation {
  prefix: string;
  at: number;
}

// ── IndexedDB helpers ──

let dbPromise: Promise<IDBDatabase> | null = null;

/** Bumped by every wipe. Entries are keyed by path alone, so a response in
 *  flight for the previous account must not land in the new one's cache. */
let cacheGeneration = 0;

/** Mirrors INVALIDATIONS_STORE so a read sees an invalidation before its write commits. */
let invalidations = new Map<string, number>();
let pruned = false;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const responses = db.objectStoreNames.contains(STORE_NAME)
        ? req.transaction!.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: 'url' });
      if (!responses.indexNames.contains('timestamp')) responses.createIndex('timestamp', 'timestamp');
      if (!db.objectStoreNames.contains(INVALIDATIONS_STORE)) {
        db.createObjectStore(INVALIDATIONS_STORE, { keyPath: 'prefix' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).then(async (db) => {
    await loadInvalidations(db);
    prune(db);
    return db;
  });
  return dbPromise;
}

function loadInvalidations(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(INVALIDATIONS_STORE, 'readonly').objectStore(INVALIDATIONS_STORE).getAll();
      req.onsuccess = () => {
        for (const { prefix, at } of req.result as Invalidation[]) {
          invalidations.set(prefix, Math.max(at, invalidations.get(prefix) ?? 0));
        }
        resolve();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Drops the oldest entries past MAX_ENTRIES, then the invalidations older than every entry left. */
function prune(db: IDBDatabase): void {
  if (pruned) return;
  pruned = true;
  try {
    const tx = db.transaction([STORE_NAME, INVALIDATIONS_STORE], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const byAge = store.index('timestamp');
    const countReq = store.count();
    countReq.onsuccess = () => {
      let excess = countReq.result - MAX_ENTRIES;
      const cursorReq = byAge.openKeyCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && excess-- > 0) {
          store.delete(cursor.primaryKey);
          cursor.continue();
          return;
        }
        const oldest = cursor ? (cursor.key as number) : Infinity;
        const marks = tx.objectStore(INVALIDATIONS_STORE);
        for (const [prefix, at] of invalidations) {
          if (at >= oldest) continue;
          invalidations.delete(prefix);
          marks.delete(prefix);
        }
      };
    };
  } catch { /* ignore */ }
}

/** Wipe the IDB store, closing the module-level connection first so `deleteDatabase` can't hang `blocked`; bounded so it never gates a login spinner. */
export function clearRequestCache(): Promise<void> {
  cacheGeneration++;
  invalidations = new Map();
  inFlight.clear();
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
function putCacheWhenIdle(url: string, body: any, sentAt: number, generation: number): void {
  const write = () => void putCache(url, body, sentAt, generation);
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(write, { timeout: 2000 });
  else setTimeout(write, 0);
}

async function putCache(url: string, body: any, sentAt: number, generation: number): Promise<void> {
  if (generation !== cacheGeneration) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ url, body, timestamp: sentAt } satisfies CacheEntry);
  } catch { /* ignore */ }
}

/** Marks every entry under `prefix` stale: the next default read goes to the network. */
export async function invalidatePrefix(prefix: string): Promise<void> {
  const at = Date.now();
  // A request sent before the change may answer with what it replaced.
  for (const key of [...inFlight.keys()]) if (key.startsWith(prefix)) inFlight.delete(key);
  // A broader, newer mark covers the narrower ones.
  const covered = [...invalidations.keys()].filter((p) => p.startsWith(prefix));
  for (const p of covered) invalidations.delete(p);
  invalidations.set(prefix, at);
  try {
    const db = await openDb();
    const marks = db.transaction(INVALIDATIONS_STORE, 'readwrite').objectStore(INVALIDATIONS_STORE);
    for (const p of covered) marks.delete(p);
    marks.put({ prefix, at } satisfies Invalidation);
  } catch { /* ignore */ }
}

// ── Interceptor ──

/** GETs on the wire, by URL: a refresh's paint-first and revalidate passes share one request. */
const inFlight = new Map<string, Observable<HttpEvent<unknown>>>();

function sharedGet(key: string, send: () => Observable<HttpEvent<unknown>>): Observable<HttpEvent<unknown>> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const shared = send().pipe(
    finalize(() => { if (inFlight.get(key) === shared) inFlight.delete(key); }),
    share(),
  );
  inFlight.set(key, shared);
  return shared;
}

export function isCacheable(url: string): boolean {
  if (EXCLUDED_PREFIXES.some((p) => url.startsWith(p))) return false;
  if (EXCLUDED_PATTERNS.some((r) => r.test(url))) return false;
  return CACHEABLE_PREFIXES.some((p) => url.startsWith(p));
}

function isInvalidated(entry: CacheEntry): boolean {
  for (const [prefix, at] of invalidations) {
    if (entry.timestamp < at && entry.url.startsWith(prefix)) return true;
  }
  return false;
}

/** `revalidate` serves the entry and refreshes it in background; `network` keeps it as the offline fallback. */
export function readPlan(entry: CacheEntry | null, known: boolean): 'cached' | 'revalidate' | 'network' {
  if (!entry) return 'network';
  if (known) return 'cached';
  if (isInvalidated(entry)) return 'network';
  const ttl = DETAIL_PATTERN.test(entry.url) ? TTL_DETAIL : TTL_LIST;
  return Date.now() - entry.timestamp < ttl ? 'cached' : 'revalidate';
}

function resourcePrefix(url: string): string {
  const m = url.match(/^(\/api\/[^/?]+)/);
  return m?.[1] ?? url;
}

/** Opt-in: force fresh data for this request despite a fresh entry; stripped before it leaves the interceptor. */
export const CACHE_BYPASS_HEADER = 'X-Cache-Bypass';
/** Opt-in: answer with the last known body whatever its age or invalidation, with no network
 *  call; for a caller that paints first and then revalidates with CACHE_BYPASS_HEADER. */
export const CACHE_KNOWN_HEADER = 'X-Cache-Known';

/** How a read may use the cache: `force` goes to the network, `known` paints whatever is cached. */
export interface CacheRead {
  force?: boolean;
  known?: boolean;
}

export function cacheHeaders(opts: CacheRead): Record<string, string> | undefined {
  if (opts.force) return { [CACHE_BYPASS_HEADER]: '1' };
  if (opts.known) return { [CACHE_KNOWN_HEADER]: '1' };
  return undefined;
}

export const cacheInterceptor: HttpInterceptorFn = (req, next) => {
  const url = req.urlWithParams;
  const generation = cacheGeneration;
  const sentAt = Date.now();

  // Only a mutation the server accepted invalidates: a failed one offline would
  // otherwise mark stale the very entries the app falls back on.
  if (req.method !== 'GET') {
    if (!req.url.startsWith('/api/')) return next(req);
    return next(req).pipe(
      tap((event) => {
        if (event instanceof HttpResponse) void invalidatePrefix(resourcePrefix(req.url));
      }),
    );
  }

  const known = req.headers.has(CACHE_KNOWN_HEADER);
  const bypass = req.headers.has(CACHE_BYPASS_HEADER);
  if (known || bypass) {
    req = req.clone({ headers: req.headers.delete(CACHE_KNOWN_HEADER).delete(CACHE_BYPASS_HEADER) });
  }

  const key = `${url} ${req.responseType}`;
  if (!isCacheable(url)) return sharedGet(key, () => next(req));

  const store = tap((event: HttpEvent<unknown>) => {
    if (event instanceof HttpResponse && event.status === 200) {
      putCacheWhenIdle(url, event.body, sentAt, generation);
    }
  });

  // Force-refresh path: skip the cache READ but still PUT the network
  // response so future cache-first callers get the refreshed value.
  if (bypass) return sharedGet(key, () => next(req).pipe(store));

  return new Observable((subscriber) => {
    getCached(url).then((entry) => {
      const plan = readPlan(entry, known);
      const cached = entry ? new HttpResponse({ status: 200, body: entry.body }) : null;
      if (plan === 'cached') {
        subscriber.next(cached!);
        subscriber.complete();
        return;
      }
      const revalidating = plan === 'revalidate';
      if (revalidating) subscriber.next(cached!);

      sharedGet(key, () => next(req).pipe(store)).subscribe({
        next: (event) => { if (!revalidating) subscriber.next(event); },
        error: (err) => {
          if (revalidating) subscriber.complete();
          // An invalidated body still beats nothing when the server can't be reached.
          else if (cached && err?.status === 0) { subscriber.next(cached); subscriber.complete(); }
          else subscriber.error(err);
        },
        complete: () => subscriber.complete(),
      });
    }).catch(() => {
      // IndexedDB unavailable → pass through.
      next(req).subscribe(subscriber);
    });
  });
};

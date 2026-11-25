import { HttpEvent, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { finalize, map, Observable, of, share, Subscription, tap } from 'rxjs';

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
  '/api/home/featured',
  '/api/playback/history',
  '/api/playback/watched-ids',
  '/api/libraries/mine',
  // Rarely-changing form-population endpoints that dominate media-detail reopen; SWR refreshes them without blocking render.
  '/api/libraries',
  '/api/profiles/quality',
  '/api/profiles/language',
  // Title details barely change and the request-poster fallback re-fetches them cold; provider reads only (see EXCLUDED_PATTERNS).
  '/api/metadata',
  '/api/persons',
  '/api/tracks',
  '/api/collections',
  '/api/playlists',
  '/api/likes',
];

/** Rows under these prefixes embed media, watch state or likes, which mutations under the key change. */
const DERIVED_PREFIXES: Record<string, string[]> = {
  '/api/media': ['/api/persons', '/api/tracks', '/api/collections', '/api/playlists', '/api/home'],
  '/api/playback': ['/api/tracks', '/api/collections', '/api/playlists', '/api/home'],
  '/api/likes': ['/api/tracks'],
};

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
  /^\/api\/persons\/\d+\/(provider-credits|bibliography|discography)/,
  /^\/api\/playlists\/\d+\/export\.m3u/,
  // Derived from profiles and jobs, which change under other prefixes: a stale count would size a rewrite.
  /^\/api\/libraries\/\d+\/optimize\//,
  /^\/api\/media\/\d+\/music\/candidates/,
  // A file's owner changes when it is re-linked: a stale answer would launch the wrong title.
  /^\/api\/media-files\/\d+$/,
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
  /** The server's validator for `body`: an answer with the same one reuses the body object and skips the write. */
  etag?: string;
}

interface Invalidation {
  prefix: string;
  at: number;
}

// ── IndexedDB helpers ──

let dbPromise: Promise<IDBDatabase> | null = null;
/** The open connection, kept synchronously so a wipe can close it without awaiting an open that may never settle. */
let db: IDBDatabase | null = null;
/** Bounds an open queued behind another page's pending delete, so reads fall back to the network. */
const OPEN_TIMEOUT_MS = 2000;

/** Bumped by every wipe. Entries are keyed by path alone, so a response in
 *  flight for the previous account must not land in the new one's cache. */
let cacheGeneration = 0;

/** Mirrors INVALIDATIONS_STORE so a read sees an invalidation before its write commits. */
let invalidations = new Map<string, number>();
let pruned = false;
/** Bodies waiting for their idle write, so a read right after a fetch sees it. */
const pendingWrites = new Map<string, CacheEntry>();

/** Last body emitted per URL, so an unchanged ETag hands back the same object and the views see no change. */
const MAX_MEMOS = 100;
const memos = new Map<string, { etag: string; body: unknown; at: number }>();

function remember(url: string, etag: string, body: unknown, at: number): void {
  memos.delete(url);
  memos.set(url, { etag, body, at });
  if (memos.size > MAX_MEMOS) memos.delete(memos.keys().next().value!);
}

/** A cache read whose ETag matches the memo serves the memo's body, so identity holds across reads. */
function adopt(entry: CacheEntry): CacheEntry {
  if (!entry.etag) return entry;
  const memo = memos.get(entry.url);
  if (memo?.etag === entry.etag) return { ...entry, body: memo.body };
  remember(entry.url, entry.etag, entry.body, entry.timestamp);
  return entry;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opened: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cache open timed out')), OPEN_TIMEOUT_MS);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const upgraded = req.result;
      const responses = upgraded.objectStoreNames.contains(STORE_NAME)
        ? req.transaction!.objectStore(STORE_NAME)
        : upgraded.createObjectStore(STORE_NAME, { keyPath: 'url' });
      if (!responses.indexNames.contains('timestamp')) responses.createIndex('timestamp', 'timestamp');
      if (!upgraded.objectStoreNames.contains(INVALIDATIONS_STORE)) {
        upgraded.createObjectStore(INVALIDATIONS_STORE, { keyPath: 'prefix' });
      }
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const conn = req.result;
      // A wipe or a timeout replaced this open while it was queued: nobody will close it but us.
      if (dbPromise !== opened) {
        conn.close();
        reject(new Error('cache open superseded'));
        return;
      }
      // Another page's wipe or upgrade waits for this connection; closing lets it through.
      conn.onversionchange = () => {
        conn.close();
        if (db === conn) db = null;
        if (dbPromise === opened) dbPromise = null;
        forgetState();
      };
      db = conn;
      resolve(conn);
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error);
    };
  }).then(async (conn) => {
    await loadInvalidations(conn);
    prune(conn);
    return conn;
  });
  opened.catch(() => {
    if (dbPromise === opened) dbPromise = null;
  });
  dbPromise = opened;
  return opened;
}

/** What a wipe invalidates in memory: late responses of the previous contents and their marks. */
function forgetState(): void {
  cacheGeneration++;
  invalidations = new Map();
  inFlight.clear();
  pendingWrites.clear();
  memos.clear();
  pruned = false;
}

function loadInvalidations(conn: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = conn.transaction(INVALIDATIONS_STORE, 'readonly').objectStore(INVALIDATIONS_STORE).getAll();
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
function prune(conn: IDBDatabase): void {
  if (pruned) return;
  try {
    const tx = conn.transaction([STORE_NAME, INVALIDATIONS_STORE], 'readwrite');
    pruned = true;
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

/** Wipe the IDB store, closing our connection first so `deleteDatabase` isn't blocked by it; never waits on an open, and bounded so it never gates a login spinner. */
/** What a `known` read would serve, without waiting: a body that just landed, for a page's first render. */
export function knownBodyNow<T>(url: string): T | undefined {
  return (memos.get(url)?.body ?? pendingWrites.get(url)?.body) as T | undefined;
}

/** The last known body of a cached GET, without the network: what a boot paint restores. */
export async function cachedBody<T>(url: string): Promise<T | null> {
  const entry = await getCached(url);
  return entry ? (adopt(entry).body as T) : null;
}

export function clearRequestCache(): Promise<void> {
  forgetState();
  try { db?.close(); } catch { /* ignore */ }
  db = null;
  dbPromise = null;
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
}

async function getCached(url: string): Promise<CacheEntry | null> {
  // The memo holds the latest body and stamp (a same-ETag answer only re-stamps it); IndexedDB would answer too late to paint.
  const memo = memos.get(url);
  if (memo) return { url, body: memo.body, timestamp: memo.at, etag: memo.etag };
  const pending = pendingWrites.get(url);
  if (pending) return pending;
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
function putCacheWhenIdle(url: string, body: any, sentAt: number, generation: number, etag?: string): void {
  const entry: CacheEntry = { url, body, timestamp: sentAt, ...(etag ? { etag } : {}) };
  pendingWrites.set(url, entry);
  const write = () => void putCache(entry, generation);
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(write, { timeout: 2000 });
  else setTimeout(write, 0);
}

async function putCache(entry: CacheEntry, generation: number): Promise<void> {
  try {
    if (generation !== cacheGeneration) return;
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entry);
  } catch { /* ignore */ } finally {
    if (pendingWrites.get(entry.url) === entry) pendingWrites.delete(entry.url);
  }
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

/** {@link invalidatePrefix} plus the prefixes whose rows embed what changed under it. */
export async function invalidateResource(prefix: string): Promise<void> {
  await Promise.all([prefix, ...(DERIVED_PREFIXES[prefix] ?? [])].map(invalidatePrefix));
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

/** `revalidate` serves the entry and refreshes it in background; `network` keeps it as the offline fallback.
 *  `freshSince` (a forced read) serves only a body requested from the network at or after that time. */
export function readPlan(
  entry: CacheEntry | null,
  known: boolean,
  freshSince?: number,
): 'cached' | 'revalidate' | 'network' {
  if (!entry) return 'network';
  if (freshSince != null) return entry.timestamp >= freshSince && !isInvalidated(entry) ? 'cached' : 'network';
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
/** With CACHE_BYPASS_HEADER: the time from which a body fetched from the network counts as fresh. */
export const CACHE_FRESH_SINCE_HEADER = 'X-Cache-Fresh-Since';

/** How a read may use the cache: `force` goes to the network, `known` paints whatever is cached. */
export interface CacheRead {
  force?: boolean;
  known?: boolean;
  /** With `force`: when the `known` pass it revalidates started, so it skips what that pass fetched from the network. */
  freshSince?: number;
}

export function cacheHeaders(opts: CacheRead): Record<string, string> | undefined {
  if (opts.force) {
    return opts.freshSince == null
      ? { [CACHE_BYPASS_HEADER]: '1' }
      : { [CACHE_BYPASS_HEADER]: '1', [CACHE_FRESH_SINCE_HEADER]: String(opts.freshSince) };
  }
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
        if (event instanceof HttpResponse) void invalidateResource(resourcePrefix(req.url));
      }),
    );
  }

  const known = req.headers.has(CACHE_KNOWN_HEADER);
  const bypass = req.headers.has(CACHE_BYPASS_HEADER);
  const since = req.headers.get(CACHE_FRESH_SINCE_HEADER);
  const freshSince = bypass && since ? Number(since) : undefined;
  if (known || bypass) {
    req = req.clone({
      headers: req.headers.delete(CACHE_KNOWN_HEADER).delete(CACHE_BYPASS_HEADER).delete(CACHE_FRESH_SINCE_HEADER),
    });
  }

  const key = `${url} ${req.responseType}`;
  if (!isCacheable(url)) return sharedGet(key, () => next(req));

  const store = map((event: HttpEvent<unknown>): HttpEvent<unknown> => {
    if (!(event instanceof HttpResponse) || event.status !== 200) return event;
    const etag = event.headers.get('ETag') ?? undefined;
    const memo = etag ? memos.get(url) : undefined;
    if (memo && memo.etag === etag && !isInvalidated({ url, body: null, timestamp: memo.at })) {
      // Same body: only the memo takes the new stamp. Rewriting IndexedDB cloned a whole library list (~130 ms on a tablet)
      // for a timestamp; after a restart the older one just means a background revalidation.
      if (generation === cacheGeneration) remember(url, etag!, memo.body, sentAt);
      return event.clone({ body: memo.body });
    }
    if (etag && generation === cacheGeneration) remember(url, etag, event.body, sentAt);
    putCacheWhenIdle(url, event.body, sentAt, generation, etag);
    return event;
  });

  // Force-refresh path: skip the cache READ but still PUT the network
  // response so future cache-first callers get the refreshed value.
  if (bypass && freshSince == null) return sharedGet(key, () => next(req).pipe(store));

  return new Observable((subscriber) => {
    // Unsubscribing cancels a network read (an aborted caller); a background revalidation runs on.
    const wire = new Subscription();
    getCached(url).then((found) => {
      if (subscriber.closed) return;
      const entry = found && adopt(found);
      const plan = readPlan(entry, known, freshSince);
      const cached = entry ? new HttpResponse({ status: 200, body: entry.body }) : null;
      if (plan === 'cached') {
        subscriber.next(cached!);
        subscriber.complete();
        return;
      }
      const revalidating = plan === 'revalidate';
      if (revalidating) subscriber.next(cached!);

      const sub = sharedGet(key, () => next(req).pipe(store)).subscribe({
        next: (event) => { if (!revalidating) subscriber.next(event); },
        error: (err) => {
          if (revalidating) subscriber.complete();
          // An invalidated body still beats nothing when the server can't be reached.
          else if (cached && err?.status === 0) { subscriber.next(cached); subscriber.complete(); }
          else subscriber.error(err);
        },
        complete: () => subscriber.complete(),
      });
      if (!revalidating) wire.add(sub);
    }).catch(() => {
      // IndexedDB unavailable → pass through.
      wire.add(next(req).subscribe(subscriber));
    });
    return wire;
  });
};

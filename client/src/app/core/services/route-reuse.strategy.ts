import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, DetachedRouteHandle, Route, RouteReuseStrategy } from '@angular/router';
import { Observable, Subject } from 'rxjs';

/** Cap on live detached trees; a handful of libraries visited in one tab, bounding the pathological per-param leak. */
const MAX_CACHE_SIZE = 10;

/**
 * Detaches and caches the DOM of routes flagged with `data: { reuse: true }`.
 *
 * Without this strategy, Angular destroys the component on navigate-away and
 * recreates it on return — the user sees the spinner / empty state again
 * even when the underlying HTTP cache has the data.
 *
 * With it, the page DOM, signals, scroll position and focus are preserved.
 * The opt-in is per route to avoid keeping unstable pages alive (player,
 * settings forms, etc.) and to bound memory.
 *
 * Parameterized routes (e.g. `libraries/:libraryName`) are cached per param
 * value — two distinct values get distinct cache entries so navigating
 * between them does not cross-pollute state.
 *
 * Components on cached routes don't receive ngOnInit / ngOnDestroy when
 * navigating in or out — subscribe to `attached$` / `detached$` instead and
 * filter by `keyFor(this.route.snapshot)` to refresh stale data, restore TV
 * focus, or persist state.
 */
@Injectable({ providedIn: 'root' })
export class CachingReuseStrategy implements RouteReuseStrategy {
  /** Cache keyed by `keyFor(snapshot)` so different param values cache separately. */
  private readonly cache = new Map<string, DetachedRouteHandle>();

  private readonly routeIds = new WeakMap<Route, string>();
  private nextRouteId = 0;

  private readonly attachedSubject = new Subject<string>();
  private readonly detachedSubject = new Subject<string>();
  /** Fires (with the route key) when a previously detached route is reattached. */
  readonly attached$: Observable<string> = this.attachedSubject.asObservable();
  /** Fires (with the route key) when a route is detached and kept alive in cache. */
  readonly detached$: Observable<string> = this.detachedSubject.asObservable();

  /**
   * Stable cache key for a snapshot. Combines the routeConfig identity (each
   * Route object gets a generated id on first sight via WeakMap) with a
   * normalized serialization of the snapshot's own params, so two snapshots
   * sharing the same config but differing on params produce distinct keys.
   * Returns null for routes without a routeConfig (root, redirects).
   */
  keyFor(snapshot: ActivatedRouteSnapshot): string | null {
    const cfg = snapshot.routeConfig;
    if (!cfg) return null;
    const params = Object.entries(snapshot.params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${this.idFor(cfg)}::${params}`;
  }

  /** DetachedRouteHandle is opaque with no public API; componentRef is the only way to run ngOnDestroy. */
  private destroyHandle(handle: DetachedRouteHandle): void {
    try {
      (handle as { componentRef?: { destroy(): void } }).componentRef?.destroy();
    } catch {
      // Shape mismatch must not break navigation.
    }
  }

  private idFor(route: Route): string {
    let id = this.routeIds.get(route);
    if (!id) {
      id = String(this.nextRouteId++);
      this.routeIds.set(route, id);
    }
    return id;
  }

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return !!route.routeConfig?.data?.['reuse'];
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const key = this.keyFor(route);
    if (!key) return;
    if (handle) {
      const existing = this.cache.get(key);
      if (existing && existing !== handle) this.destroyHandle(existing);
      this.cache.delete(key);
      this.cache.set(key, handle);
      while (this.cache.size > MAX_CACHE_SIZE) {
        const oldestKey = this.cache.keys().next().value as string;
        const oldest = this.cache.get(oldestKey);
        this.cache.delete(oldestKey);
        if (oldest && oldest !== handle) this.destroyHandle(oldest);
      }
      this.detachedSubject.next(key);
    } else {
      this.cache.delete(key);
    }
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    const key = this.keyFor(route);
    return !!key && this.cache.has(key);
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    const key = this.keyFor(route);
    if (!key) return null;
    const handle = this.cache.get(key) ?? null;
    if (handle) {
      // Re-insert to mark most-recently-used for the LRU eviction in store().
      this.cache.delete(key);
      this.cache.set(key, handle);
      // Microtask so the outlet has finished attaching before subscribers run
      // their refresh / focus-restore work.
      queueMicrotask(() => this.attachedSubject.next(key));
    }
    return handle;
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, current: ActivatedRouteSnapshot): boolean {
    if (future.routeConfig !== current.routeConfig) return false;
    // For routes flagged `reuse: true` we need stricter behavior: two distinct
    // param values (e.g. /libraries/Movies vs /libraries/Series) must each
    // detach so their state lands in its own cache slot. Without this guard
    // Angular would keep the same component instance and only emit param
    // changes, defeating per-param caching.
    if (future.routeConfig?.data?.['reuse']) {
      return this.keyFor(future) === this.keyFor(current);
    }
    return true;
  }

  /** Drop every cached page (call on logout / user switch). */
  clear(): void {
    for (const handle of this.cache.values()) this.destroyHandle(handle);
    this.cache.clear();
  }
}

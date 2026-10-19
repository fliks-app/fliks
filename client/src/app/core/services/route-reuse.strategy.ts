import { Injectable, Injector, inject } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  DetachedRouteHandle,
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  Route,
  Router,
  RouteReuseStrategy,
} from '@angular/router';
import { filter, Observable, Subject, take } from 'rxjs';
import { DeviceService } from './device.service';

/** Cap on live detached trees; a handful of libraries visited in one tab, bounding the pathological per-param leak. */
export const MAX_CACHE_SIZE = 10;
/** A TV's WebView has a fraction of the memory: keep only the pages a back press is likely to return to. */
export const TV_MAX_CACHE_SIZE = 3;

/** Detaches and caches the DOM of routes flagged `data: { reuse: true }`, preserving signals, scroll and focus; opt-in to bound memory and skip unstable pages.
 *  Cached routes get no ngOnInit/ngOnDestroy: use `attached$` / `detached$` filtered by `keyFor(this.route.snapshot)`; parameterized routes cache per param value. */
@Injectable({ providedIn: 'root' })
export class CachingReuseStrategy implements RouteReuseStrategy {
  /** Cache keyed by `keyFor(snapshot)` so different param values cache separately. */
  private readonly cache = new Map<string, DetachedRouteHandle>();

  private readonly routeIds = new WeakMap<Route, string>();
  private nextRouteId = 0;

  private readonly injector = inject(Injector);
  private readonly maxSize = inject(DeviceService).isTv() ? TV_MAX_CACHE_SIZE : MAX_CACHE_SIZE;

  private readonly attachedSubject = new Subject<string>();
  private readonly detachedSubject = new Subject<string>();
  /** Fires (with the route key) when a previously detached route is reattached. */
  readonly attached$: Observable<string> = this.attachedSubject.asObservable();
  /** Fires (with the route key) when a route is detached and kept alive in cache. */
  readonly detached$: Observable<string> = this.detachedSubject.asObservable();

  /** Stable cache key: routeConfig identity (WeakMap-generated id) plus normalized params; null without a routeConfig (root, redirects). */
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

  /** `dialog[open]` survives detach without emitting `close`, so a cached tree reopens it on retrieve. */
  private closeOpenDialogs(handle: DetachedRouteHandle): void {
    try {
      const el = (handle as { componentRef?: { location: { nativeElement: Element } } })
        .componentRef?.location.nativeElement;
      el?.querySelectorAll('dialog[open]').forEach((dialog) =>
        (dialog as HTMLDialogElement).close(),
      );
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
      this.closeOpenDialogs(handle);
      const existing = this.cache.get(key);
      if (existing && existing !== handle) this.destroyHandle(existing);
      this.cache.delete(key);
      this.cache.set(key, handle);
      while (this.cache.size > this.maxSize) {
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
      this.notifyWhenActivated(key);
    }
    return handle;
  }

  /** Attached means attached: `retrieve` runs a frame before the outlet swaps,
   *  so reclaiming global chrome there moves the page still on screen. */
  private notifyWhenActivated(key: string): void {
    // Lazily resolved: the Router itself depends on this strategy.
    this.injector
      .get(Router)
      .events.pipe(
        filter(
          (e) =>
            e instanceof NavigationEnd ||
            e instanceof NavigationCancel ||
            e instanceof NavigationError,
        ),
        take(1),
      )
      .subscribe((e) => {
        if (e instanceof NavigationEnd) this.attachedSubject.next(key);
      });
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, current: ActivatedRouteSnapshot): boolean {
    if (future.routeConfig !== current.routeConfig) return false;
    // A page that drives itself off the route params keeps its instance across
    // them, so nothing under it is rebuilt when only a param moves.
    if (future.routeConfig?.data?.['reuseOnParamChange']) return true;
    // Reuse routes must detach per param value (/libraries/Movies vs /Series), or Angular keeps one instance and only emits param changes.
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

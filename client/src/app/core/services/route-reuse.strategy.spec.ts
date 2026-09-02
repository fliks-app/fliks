import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, DetachedRouteHandle, Route } from '@angular/router';
import { vi } from 'vitest';
import { CachingReuseStrategy } from './route-reuse.strategy';

const MAX_CACHE_SIZE = 10;

function snapshotFor(route: Route, params: Record<string, string> = {}): ActivatedRouteSnapshot {
  return { routeConfig: route, params } as unknown as ActivatedRouteSnapshot;
}

interface FakeHandle {
  destroy: ReturnType<typeof vi.fn>;
}

function handleWithDestroy(): DetachedRouteHandle & FakeHandle {
  const destroy = vi.fn();
  return { componentRef: { destroy }, destroy } as unknown as DetachedRouteHandle & FakeHandle;
}

describe('CachingReuseStrategy', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    return TestBed.inject(CachingReuseStrategy);
  }

  it('VERDICT: reuseOnParamChange keeps the instance across params, plain reuse does not', () => {
    const strategy = setup();
    const episode: Route = {
      path: 'series/:id/episode/:episodeId',
      data: { reuse: true, reuseOnParamChange: true },
    };
    const library: Route = { path: 'libraries/:libraryName', data: { reuse: true } };

    expect(
      strategy.shouldReuseRoute(
        snapshotFor(episode, { id: '1', episodeId: '8' }),
        snapshotFor(episode, { id: '1', episodeId: '9' }),
      ),
    ).toBe(true);
    expect(
      strategy.shouldReuseRoute(
        snapshotFor(library, { libraryName: 'Movies' }),
        snapshotFor(library, { libraryName: 'Series' }),
      ),
    ).toBe(false);
  });

  it('VERDICT: clear() destroys every cached handle, not just the map entries', () => {
    const strategy = setup();
    const route: Route = { path: 'libraries/:libraryName' };
    const handleA = handleWithDestroy();
    const handleB = handleWithDestroy();
    strategy.store(snapshotFor(route, { libraryName: 'Movies' }), handleA);
    strategy.store(snapshotFor(route, { libraryName: 'Series' }), handleB);

    strategy.clear();

    expect(handleA.destroy).toHaveBeenCalledTimes(1);
    expect(handleB.destroy).toHaveBeenCalledTimes(1);
  });

  it('VERDICT: exceeding the cap destroys and evicts the least-recently-used entry', () => {
    const strategy = setup();
    const route: Route = { path: 'libraries/:libraryName' };
    const handles = Array.from({ length: MAX_CACHE_SIZE }, () => handleWithDestroy());
    handles.forEach((h, i) => strategy.store(snapshotFor(route, { libraryName: `lib${i}` }), h));

    // retrieve() on the oldest entry marks it recently-used, so it must NOT be evicted next.
    strategy.retrieve(snapshotFor(route, { libraryName: 'lib0' }));

    const overflow = handleWithDestroy();
    strategy.store(snapshotFor(route, { libraryName: 'overflow' }), overflow);

    expect(handles[0].destroy).not.toHaveBeenCalled();
    expect(handles[1].destroy).toHaveBeenCalledTimes(1);
    expect(strategy.shouldAttach(snapshotFor(route, { libraryName: 'lib0' }))).toBe(true);
    expect(strategy.shouldAttach(snapshotFor(route, { libraryName: 'lib1' }))).toBe(false);
  });

  it('VERDICT: re-storing the same handle under an existing key does not destroy it', () => {
    const strategy = setup();
    const route: Route = { path: 'libraries/:libraryName' };
    const handle = handleWithDestroy();
    const snapshot = snapshotFor(route, { libraryName: 'Movies' });

    strategy.store(snapshot, handle);
    strategy.store(snapshot, handle);

    expect(handle.destroy).not.toHaveBeenCalled();
    expect(strategy.shouldAttach(snapshot)).toBe(true);
  });
});

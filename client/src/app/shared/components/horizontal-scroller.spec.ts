import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, DetachedRouteHandle, Route } from '@angular/router';
import { vi } from 'vitest';
import { HorizontalScrollerComponent } from './horizontal-scroller';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { NavbarService } from '../../core/services/navbar.service';
import { TvService } from '../../core/services/tv.service';

@Component({
  imports: [HorizontalScrollerComponent],
  template: '<app-horizontal-scroller title="Row"><div>card</div></app-horizontal-scroller>',
})
class HostStub {}

/** A detached subtree loses its scroll offset and the reattach runs no lifecycle
 *  hook, so the row came back at zero on every return. */
describe('HorizontalScrollerComponent', () => {
  beforeAll(() => {
    // jsdom ships no ResizeObserver, and ngAfterViewInit observes the rail.
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  /** Returns the rail's stubbed scrollTo after parking an offset on it and
   *  driving one detach / reattach cycle through the reuse cache. */
  function reattachWith(navigatedBack: boolean) {
    const back = signal(navigatedBack);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: TvService, useValue: { isTv: () => false } as unknown as TvService },
        { provide: NavbarService, useValue: { navigatedBack: back } as unknown as NavbarService },
      ],
    });
    const fixture = TestBed.createComponent(HostStub);
    fixture.detectChanges();

    const rail = fixture.nativeElement.querySelector('[data-scroller]') as HTMLElement;
    const scrollTo = vi.fn();
    rail.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    // jsdom has no layout, so the offset the user left behind is faked onto the
    // element and picked up by the (scroll) handler.
    Object.defineProperty(rail, 'scrollLeft', { value: 640, configurable: true });
    rail.dispatchEvent(new Event('scroll'));

    const reuse = TestBed.inject(CachingReuseStrategy);
    const route: Route = { path: '', data: { reuse: true } };
    const snapshot = { routeConfig: route, params: {} } as unknown as ActivatedRouteSnapshot;
    reuse.store(snapshot, { componentRef: { destroy: () => {} } } as unknown as DetachedRouteHandle);
    reuse.retrieve(snapshot);

    // attached$ is emitted from a microtask inside retrieve().
    return Promise.resolve().then(() => scrollTo);
  }

  it('VERDICT: restores the parked offset on a return, without smooth scroll', async () => {
    expect(await reattachWith(true)).toHaveBeenCalledWith({ left: 640, behavior: 'instant' });
  });

  /** Opening the page is a fresh screen, so the rail stays where the reattach
   *  left it rather than replaying wherever the user was last time. */
  it('VERDICT: leaves the rail alone when the page is navigated to, not returned to', async () => {
    expect(await reattachWith(false)).not.toHaveBeenCalled();
  });
});

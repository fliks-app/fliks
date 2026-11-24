import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  DetachedRouteHandle,
  Event as RouterEvent,
  NavigationEnd,
  Route,
  Router,
} from '@angular/router';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { builtCount, HorizontalScrollerComponent } from './horizontal-scroller';
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
  /** Returns the rail's stubbed scrollTo after parking an offset on it and
   *  driving one detach / reattach cycle through the reuse cache. */
  async function reattachWith(navigatedBack: boolean) {
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
    // The scroll listener is attached after the first render.
    await fixture.whenStable();

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
    // The reattach is announced off the navigation that lands it, so nothing
    // reaches the row until one ends.
    (TestBed.inject(Router).events as Subject<RouterEvent>).next(new NavigationEnd(1, '/', '/'));

    // attached$ is emitted from a microtask inside retrieve().
    await Promise.resolve();
    return scrollTo;
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

/** A long rail built every card at once: on a tablet, 28 episode cards held the main thread ~350 ms. */
describe('builtCount', () => {
  it('builds a first pass, capped by the list', () => {
    expect(builtCount(28, 0, null, null)).toBe(8);
    expect(builtCount(5, 0, null, null)).toBe(5);
  });

  it('builds past the anchor so the rail can centre on it', () => {
    expect(builtCount(28, 0, 20, null)).toBe(24);
    expect(builtCount(28, 0, -1, null)).toBe(8);
  });

  it('builds past the right edge as the rail scrolls', () => {
    expect(builtCount(28, 8, null, 9)).toBe(13);
  });

  it('never drops built cards, which could hold the focus', () => {
    expect(builtCount(28, 20, 2, 4)).toBe(20);
  });
});

@Component({
  imports: [HorizontalScrollerComponent],
  template: `<app-horizontal-scroller [items]="items" [anchorIndex]="anchor">
    <ng-template let-n><span class="card">{{ n }}</span></ng-template>
  </app-horizontal-scroller>`,
})
class ItemsHost {
  items = Array.from({ length: 30 }, (_, i) => i);
  anchor: number | null = null;
}

describe('HorizontalScrollerComponent items mode', () => {
  function render(anchor: number | null) {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(ItemsHost);
    fixture.componentInstance.anchor = anchor;
    fixture.detectChanges();
    return [...fixture.nativeElement.querySelectorAll('.card')].map((e: Element) => e.textContent);
  }

  it('builds the first cards only', () => {
    expect(render(null)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
  });

  it('builds up to the anchor', () => {
    expect(render(15).at(-1)).toBe('18');
  });
});

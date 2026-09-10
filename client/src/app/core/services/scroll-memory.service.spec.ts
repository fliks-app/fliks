import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationStart, Router, Scroll } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScrollMemoryService } from './scroll-memory.service';
import { NavbarService } from './navbar.service';
import { PageScrollerService } from './page-scroller.service';

describe('ScrollMemoryService', () => {
  let events: Subject<unknown>;
  let claimed: HTMLElement | null;
  let offset: number;
  let writes: number[];
  let wentBack: boolean;

  beforeEach(() => {
    events = new Subject();
    claimed = null;
    offset = 0;
    writes = [];
    wentBack = false;
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: Router, useValue: { events } },
        { provide: NavbarService, useValue: { navigatedBack: () => wentBack } },
        {
          provide: PageScrollerService,
          useValue: {
            element: () => claimed,
            offset: () => offset,
            scrollTo: vi.fn((top: number) => {
              writes.push(top);
              offset = top;
            }),
          },
        },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  const service = () => TestBed.inject(ScrollMemoryService);
  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  it('saves and restores the claimed container, not the document', async () => {
    const s = service();
    wentBack = true;
    claimed = document.createElement('div');
    s.activate('library-films');
    offset = 4160;

    events.next(new NavigationStart(1, '/movies/1'));
    offset = 0;
    events.next(new Scroll({} as never, null, null));
    await nextFrame();

    s.restoreSticky('library-films');
    expect(writes).toEqual([4160]);
  });

  it('stops sticking once another page claims its own scroller', async () => {
    const s = service();
    wentBack = true;
    claimed = document.createElement('div');
    s.activate('library-films');
    offset = 4160;
    events.next(new NavigationStart(1, '/movies/1'));
    offset = 0;
    events.next(new Scroll({} as never, null, null));
    await nextFrame();

    // A write that lands short keeps the loop going; a page navigated to in
    // the meantime must not inherit the rest of it.
    const scroller = TestBed.inject(PageScrollerService) as unknown as {
      scrollTo: (top: number) => void;
    };
    scroller.scrollTo = (top: number) => writes.push(top);

    s.restoreSticky('library-films');
    claimed = document.createElement('div');
    await nextFrame();
    await nextFrame();

    expect(writes).toEqual([4160]);
  });

  it('retries while a reattached container is not yet scrollable', async () => {
    const s = service();
    wentBack = true;
    claimed = document.createElement('div');
    s.activate('library-films');
    offset = 4160;
    events.next(new NavigationStart(1, '/movies/1'));
    events.next(new Scroll({} as never, null, null));
    await nextFrame();

    // A container reattached before layout clamps the write to 0; the loop has
    // to come back for it rather than give up on the first frame.
    const scroller = TestBed.inject(PageScrollerService) as unknown as {
      scrollTo: (top: number) => void;
    };
    offset = 0;
    scroller.scrollTo = (top: number) => {
      writes.push(top);
      if (writes.length > 1) offset = top;
    };

    s.restoreSticky('library-films');
    await nextFrame();
    await nextFrame();

    expect(writes.length).toBeGreaterThan(1);
    expect(offset).toBe(4160);
  });

  it("holds a forward entry at the top when the router's own scroll is dropped", async () => {
    service();
    // WKWebView clamps the offset the previous, taller page had to this
    // document's own maximum and ignores the router's single scrollTo.
    offset = 1422;

    events.next(new NavigationStart(1, '/movies/1'));
    events.next(new Scroll({} as never, null, null));
    await nextFrame();

    expect(writes).toContain(0);
    expect(offset).toBe(0);
  });

  it('takes the top back when the clamp lands a few frames later', async () => {
    service();
    events.next(new NavigationStart(1, '/movies/1'));
    events.next(new Scroll({} as never, null, null));
    await nextFrame();
    writes.length = 0;

    // WKWebView settles its contentSize off the main thread and reports the
    // clamp as a scroll of its own, after the router's turn is over.
    offset = 1422;
    window.dispatchEvent(new Event('scroll'));

    expect(writes).toEqual([0]);
    expect(offset).toBe(0);
  });

  it('lets go of the top as soon as the user touches the page', async () => {
    service();
    events.next(new NavigationStart(1, '/movies/1'));
    events.next(new Scroll({} as never, null, null));
    await nextFrame();
    writes.length = 0;

    window.dispatchEvent(new Event('touchstart'));
    offset = 900;
    window.dispatchEvent(new Event('scroll'));

    expect(writes).toEqual([]);
    expect(offset).toBe(900);
  });

  it('leaves a return alone — its own restore owns the offset', async () => {
    const s = service();
    wentBack = true;
    s.activate('library-films');
    offset = 4160;
    events.next(new NavigationStart(1, '/libraries/Films'));
    offset = 1422;
    events.next(new Scroll({} as never, null, null));
    await nextFrame();
    await nextFrame();

    expect(writes).not.toContain(0);
  });
});

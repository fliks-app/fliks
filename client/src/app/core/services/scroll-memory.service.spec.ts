import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, NavigationStart, Router, Scroll } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScrollMemoryService } from './scroll-memory.service';
import { NavbarService } from './navbar.service';
import { PageScrollerService } from './page-scroller.service';

describe('ScrollMemoryService', () => {
  let events: Subject<unknown>;
  let offset: number;
  let writes: number[];
  let wentBack: boolean;

  beforeEach(() => {
    events = new Subject();
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

  const service = () => TestBed.inject(ScrollMemoryService);
  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  // A forward entry holds the top from the next frame: let it land in its own test.
  afterEach(async () => {
    await nextFrame();
    await nextFrame();
    TestBed.resetTestingModule();
  });

  it('saves the offset a page is left at and restores it on the way back', async () => {
    const s = service();
    wentBack = true;
    s.activate('library-films');
    offset = 4160;

    events.next(new NavigationStart(1, '/movies/1'));
    offset = 0;
    events.next(new Scroll({} as never, null, null));
    await nextFrame();

    s.restoreSticky('library-films');
    expect(writes).toEqual([4160]);
  });

  it('retries while the reattached page is not yet tall enough to scroll', async () => {
    const s = service();
    wentBack = true;
    s.activate('library-films');
    offset = 4160;
    events.next(new NavigationStart(1, '/movies/1'));
    events.next(new Scroll({} as never, null, null));
    await nextFrame();

    // A page reattached before layout clamps the write to 0; the loop has to
    // come back for it rather than give up on the first frame.
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

  it('starts a return with nothing queued at the top, without holding it against its own late restore', async () => {
    const s = service();
    wentBack = true;
    s.activate('library-films');
    offset = 4160;
    events.next(new NavigationStart(1, '/libraries/Films'));
    offset = 1422;
    events.next(new Scroll({} as never, null, null));
    s.restoreSticky('library-films');
    await nextFrame();
    await nextFrame();

    expect(writes).toEqual([0, 4160]);
    expect(offset).toBe(4160);
  });

  it('keeps the offset when only the query changes on the same path, unless the call asks for the top', async () => {
    service();
    events.next(new NavigationEnd(1, '/libraries/Films', '/libraries/Films'));
    offset = 640;
    events.next(new NavigationStart(2, '/libraries/Films?view=genres'));
    const tab = new NavigationEnd(2, '/libraries/Films?view=genres', '/libraries/Films?view=genres');
    events.next(tab);
    events.next(new Scroll(tab, null, null));
    await nextFrame();
    expect(offset).toBe(640);

    events.next(new NavigationStart(3, '/libraries/Films?view=likes'));
    const reset = new NavigationEnd(3, '/libraries/Films?view=likes', '/libraries/Films?view=likes');
    events.next(reset);
    events.next(new Scroll(reset, null, null, 'after-transition'));
    await nextFrame();
    expect(offset).toBe(0);
  });

  it('drops a top hold whose page was left before its frame', async () => {
    service();
    offset = 640;
    events.next(new NavigationStart(1, '/movies/1'));
    events.next(new Scroll({} as never, null, null));
    await Promise.resolve();
    events.next(new NavigationStart(2, '/movies/2'));
    await nextFrame();
    await nextFrame();

    expect(writes).not.toContain(0);
  });

  it('leaves a navigation that asks for no scroll alone', async () => {
    service();
    offset = 640;
    events.next(new NavigationStart(1, '/movies/1'));
    events.next(new Scroll({} as never, null, null, 'manual'));
    await nextFrame();
    await nextFrame();

    expect(writes).not.toContain(0);
    expect(offset).toBe(640);
  });
});

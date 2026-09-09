import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationStart, Router, Scroll } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScrollMemoryService } from './scroll-memory.service';
import { PageScrollerService } from './page-scroller.service';

describe('ScrollMemoryService', () => {
  let events: Subject<unknown>;
  let claimed: HTMLElement | null;
  let offset: number;
  let writes: number[];

  beforeEach(() => {
    events = new Subject();
    claimed = null;
    offset = 0;
    writes = [];
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: Router, useValue: { events } },
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
});

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { ActivatedRoute, Router } from '@angular/router';
import { EMPTY, Subject } from 'rxjs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { LibraryComponent } from './library';
import { Media, MediaService } from '../../core/services/api/media.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { OfflinePlaybackSyncService } from '../../core/services/offline-playback-sync.service';
import { PlayableMediaService } from '../../core/services/playable-media.service';
import { SocialApiService } from '../../core/services/api/social-api.service';
import { LikesApiService } from '../../core/services/api/likes-api.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { LibrariesApiService } from '../../core/services/api/libraries-api.service';
import { PageScrollerService } from '../../core/services/page-scroller.service';
import { PageScrollModeService, PageScrollMode } from '../../core/services/page-scroll-mode.service';
import { BackgroundService } from '../../core/services/background.service';
import { DisplaySettingsService } from '../../core/services/display-settings.service';
import { NavbarService } from '../../core/services/navbar.service';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { AppResumeService } from '../../core/services/app-resume.service';

const OWN_KEY = 'library-route::name=films';

function media(id: number, title: string): Media {
  return {
    id,
    title,
    originalTitle: title,
    year: 2024,
    type: 'movie',
    tmdbId: id,
    overview: '',
    status: 'released',
    monitored: true,
    posterUrl: null,
    fanartUrl: null,
    logoUrl: null,
    additionalFanartUrls: [],
    rating: 0,
    runtime: 100,
    files: [],
  };
}

/** Six titles under A then six under B: with the default six columns, row 0 is
 *  the A section and row 1 the B one. */
function twoSections(): Media[] {
  return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) =>
    media(n, n <= 6 ? `Apple ${n}` : `Banana ${n}`),
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** jsdom lays nothing out, so every box the component measures is stubbed. */
function stubTop(el: HTMLElement, top: number): void {
  el.getBoundingClientRect = () => ({ top }) as unknown as DOMRect;
}

/** A fake `CdkVirtualScrollViewport`: a real DOM node (so scroll events can be
 *  dispatched on it) plus spies for the CDK methods the component calls. */
function fakeViewport() {
  const el = document.createElement('div');
  return {
    elementRef: { nativeElement: el },
    measureScrollOffset: vi.fn(() => 0),
    scrollToOffset: vi.fn(),
    checkViewportSize: vi.fn(),
  } as unknown as CdkVirtualScrollViewport & {
    elementRef: { nativeElement: HTMLElement };
    measureScrollOffset: ReturnType<typeof vi.fn>;
    scrollToOffset: ReturnType<typeof vi.fn>;
    checkViewportSize: ReturnType<typeof vi.fn>;
  };
}

function createHarness(mode: PageScrollMode = 'container') {
  const attached$ = new Subject<string>();
  const detached$ = new Subject<string>();
  // Connected because the restore waits for the shell to be in the document:
  // a scrollTop write to a detached element is dropped.
  const shellEl = document.createElement('div');
  document.body.appendChild(shellEl);
  // jsdom lays nothing out, so the element's own scroll method is a spy.
  const shellScrollTo = vi.fn();
  shellEl.scrollTo = shellScrollTo;
  const pageScroller = {
    claim: vi.fn(),
    release: vi.fn(),
    element: signal<HTMLElement | null>(null),
    offset: () => 0,
    // Same two effects as the real service on a claimed scroller: the write,
    // and the scroll event the browser then emits.
    scrollTo: vi.fn((top: number) => {
      shellEl.scrollTop = top;
      shellEl.dispatchEvent(new Event('scroll'));
    }),
    changes: () => EMPTY,
  };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: ActivatedRoute,
        useValue: {
          params: EMPTY,
          queryParamMap: EMPTY,
          snapshot: { queryParamMap: { get: () => null } },
        },
      },
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: MediaService, useValue: { getAll: vi.fn(async () => ({ data: [], total: 0 })) } },
      { provide: StreamingApiService, useValue: { getWatchedMediaIds: vi.fn(async () => []) } },
      { provide: OfflinePlaybackSyncService, useValue: {} },
      { provide: PlayableMediaService, useValue: {} },
      { provide: SocialApiService, useValue: {} },
      { provide: LikesApiService, useValue: {} },
      { provide: ProfilesService, useValue: {} },
      { provide: LibrariesApiService, useValue: {} },
      { provide: PageScrollerService, useValue: pageScroller },
      { provide: PageScrollModeService, useValue: { mode: () => mode } },
      { provide: BackgroundService, useValue: { url: signal(null), applyPool: vi.fn(), clear: vi.fn() } },
      { provide: DisplaySettingsService, useValue: { settings: signal({ homeBackground: false }) } },
      { provide: NavbarService, useValue: { setPageTitle: vi.fn(), clearPageTitle: vi.fn(), mobileNavbarVisible: signal(true) } },
      { provide: TranslateService, useValue: { instant: (key: string) => key } },
      { provide: CachingReuseStrategy, useValue: { attached$, detached$, keyFor: () => OWN_KEY } },
      {
        provide: ScrollMemoryService,
        useValue: { activate: vi.fn(), deactivate: vi.fn(), deactivateIf: vi.fn(), restore: vi.fn(), restoreSticky: vi.fn() },
      },
      { provide: AppResumeService, useValue: { resume$: EMPTY } },
    ],
  });

  TestBed.overrideComponent(LibraryComponent, { set: { template: '', imports: [] } });

  const fixture = TestBed.createComponent(LibraryComponent);
  // No `#shell` in the stubbed template, and `ngOnInit` claims it: stand in
  // before the first change detection runs.
  (fixture.componentInstance as unknown as { shellRef: { nativeElement: HTMLElement } }).shellRef = {
    nativeElement: shellEl,
  };
  fixture.detectChanges(); // runs ngOnInit

  return {
    fixture,
    component: fixture.componentInstance,
    pageScroller,
    attached$,
    detached$,
    shellEl,
    shellScrollTo,
  };
}

/** Simulates Angular resolving the `@ViewChild(CdkVirtualScrollViewport)` query. */
function attachViewport(component: LibraryComponent) {
  const viewport = fakeViewport();
  (component as unknown as { viewportRef: CdkVirtualScrollViewport }).viewportRef = viewport;
  return viewport;
}

/** A filter change and a background revalidation reach the private `load()`
 *  through the same call, differing only by its flag. */
function load(component: LibraryComponent, silent: boolean): Promise<void> {
  return (component as unknown as { load(id: number, silent: boolean): Promise<void> }).load(
    1,
    silent,
  );
}

describe('LibraryComponent — container scroller', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('derives the active letter from the viewport\'s own measureScrollOffset()', async () => {
    const { component, shellEl } = createHarness();
    component.list.setItems(twoSections(), (m) => m.title);

    const viewport = attachViewport(component);

    viewport.measureScrollOffset.mockReturnValue(0);
    shellEl.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(component.list.activeLetter()).toBe('A');

    viewport.measureScrollOffset.mockReturnValue(component.rowHeight());
    shellEl.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(component.list.activeLetter()).toBe('B');
  });

  it('a detach/attach cycle re-claims the same shell without touching the viewport\'s scroll state', () => {
    const { component, pageScroller, attached$, detached$, shellEl } = createHarness();
    attachViewport(component);

    expect(pageScroller.claim).toHaveBeenCalledWith(shellEl);
    pageScroller.claim.mockClear();

    detached$.next(OWN_KEY);
    expect(pageScroller.release).toHaveBeenCalledWith(shellEl);

    attached$.next(OWN_KEY);
    expect(pageScroller.claim).toHaveBeenCalledWith(shellEl);

    // No scroll happened between detach and attach, so there is nothing to restore.
    expect(pageScroller.scrollTo).not.toHaveBeenCalled();
  });

  it('records the shell\'s scrollTop while scrolling and restores it on attach', () => {
    const { component, pageScroller, attached$, detached$, shellEl, shellScrollTo } = createHarness();
    attachViewport(component);

    // The router detaches the subtree before `store()` runs, so by detach time
    // the offset is already 0 — only a live scroll can capture it.
    shellEl.scrollTop = 1234;
    shellEl.dispatchEvent(new Event('scroll'));
    shellEl.scrollTop = 0;

    detached$.next(OWN_KEY);
    attached$.next(OWN_KEY);

    expect(shellScrollTo).toHaveBeenCalledWith({ top: 1234, left: 0, behavior: 'instant' });
    // A cached re-attach is not a content swap: a reset here would land the
    // return from a media detail back at the top of the library.
    expect(shellScrollTo).not.toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
  });

  it('does not restore on a first attach with nothing saved', () => {
    const { component, attached$, detached$, shellScrollTo } = createHarness();
    attachViewport(component);

    detached$.next(OWN_KEY);
    attached$.next(OWN_KEY);

    expect(shellScrollTo).not.toHaveBeenCalled();
  });

  it('keeps the active letter through the restore\'s own scroll event', async () => {
    const { component, attached$, detached$, shellEl } = createHarness();
    component.list.setItems(twoSections(), (m) => m.title);
    const viewport = attachViewport(component);

    viewport.measureScrollOffset.mockReturnValue(component.rowHeight());
    shellEl.scrollTop = component.rowHeight();
    shellEl.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(component.list.activeLetter()).toBe('B');

    // What the re-attached viewport reads before CDK re-renders its range: the
    // restore's scroll event must not take the letter back to the top.
    viewport.measureScrollOffset.mockReturnValue(0);
    detached$.next(OWN_KEY);
    attached$.next(OWN_KEY);
    await nextFrame();

    expect(component.list.activeLetter()).toBe('B');
  });

  it('lands a letter jump on the first row below the fixed chrome', () => {
    const { component, shellEl } = createHarness();
    component.list.setItems(twoSections(), (m) => m.title);
    component.rowHeight.set(200);
    const viewport = attachViewport(component);

    // The grid starts 300px below the shell's top edge, which is itself already
    // scrolled 50px down, and 96px of fixed chrome overlap the scroller.
    stubTop(shellEl, 100);
    stubTop(viewport.elementRef.nativeElement, 400);
    shellEl.scrollTop = 50;
    shellEl.style.paddingTop = '96px';

    component.scrollToLetter('B');

    // The first B opens row 1, so 200px of rows, plus the grid's 350px offset
    // inside the scroller, less the 96px of chrome the row has to clear.
    expect(viewport.scrollToOffset).toHaveBeenCalledWith(454, 'instant');
  });

  it('resets its own scroll on a content swap, but not on a silent revalidation', async () => {
    const { component, pageScroller, shellScrollTo } = createHarness();

    await load(component, true);
    expect(shellScrollTo).not.toHaveBeenCalled();

    await load(component, false);
    expect(shellScrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
    // Its own element, never the ambient claim, which on TV points at whichever
    // page is on screen by the time a background load lands.
    expect(pageScroller.scrollTo).not.toHaveBeenCalled();
  });

  it('resets its own scroll on a view-mode change', () => {
    const { component, pageScroller, shellScrollTo } = createHarness();
    // `setViewMode` no-ops on the mode already active, so start off the target.
    component.viewMode.set('genres');

    component.setViewMode('all');

    expect(shellScrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
    expect(pageScroller.scrollTo).not.toHaveBeenCalled();
  });
});

describe('LibraryComponent — window scroller (TV / desktop)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('never claims the shell as a scroller', () => {
    const { pageScroller } = createHarness('window');
    expect(pageScroller.claim).not.toHaveBeenCalled();
  });

  it('derives the active letter from a window scroll, not the shell', async () => {
    const { component } = createHarness('window');
    component.list.setItems(twoSections(), (m) => m.title);
    const viewport = attachViewport(component);

    viewport.measureScrollOffset.mockReturnValue(component.rowHeight());
    window.dispatchEvent(new Event('scroll'));
    await nextFrame();

    expect(component.list.activeLetter()).toBe('B');
  });

  it("resets the window's own scroll on a content swap, never the ambient claim", async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    try {
      const { component, pageScroller } = createHarness('window');

      await load(component, false);

      expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
      expect(pageScroller.scrollTo).not.toHaveBeenCalled();
    } finally {
      scrollTo.mockRestore();
    }
  });

  it('does not touch the page scroller across a detach/attach cycle', () => {
    const { pageScroller, attached$, detached$ } = createHarness('window');

    detached$.next(OWN_KEY);
    attached$.next(OWN_KEY);

    expect(pageScroller.release).not.toHaveBeenCalled();
    expect(pageScroller.claim).not.toHaveBeenCalled();
  });

  it('lands a letter jump on the first row below the chrome, measured from the document', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'scrollY');
    Object.defineProperty(window, 'scrollY', { value: 50, configurable: true });
    try {
      const { component } = createHarness('window');
      component.list.setItems(twoSections(), (m) => m.title);
      component.rowHeight.set(200);
      const viewport = attachViewport(component);
      stubTop(viewport.elementRef.nativeElement, 400);

      component.scrollToLetter('B');

      // The first B opens row 1, so 200px of rows, plus the grid's 450px
      // absolute offset in the document (400 viewport-relative + 50 scrolled).
      expect(viewport.scrollToOffset).toHaveBeenCalledWith(650, 'instant');
    } finally {
      if (original) Object.defineProperty(window, 'scrollY', original);
    }
  });
});

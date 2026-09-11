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

/** 420 titles: at six columns that is 70 rows, well past the 47-58 range the
 *  fake viewport reports, so a restored offset resolves to a real first row. */
function manyRows(): Media[] {
  return Array.from({ length: 420 }, (_, i) => media(i + 1, `Title ${i + 1}`));
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
  const wrapper = document.createElement('div');
  wrapper.className = 'cdk-virtual-scroll-content-wrapper';
  el.appendChild(wrapper);
  return {
    elementRef: { nativeElement: el },
    measureScrollOffset: vi.fn(() => 0),
    scrollToOffset: vi.fn(),
    checkViewportSize: vi.fn(),
    getRenderedRange: vi.fn(() => ({ start: 47, end: 58 })),
    setRenderedRange: vi.fn(),
    setRenderedContentOffset: vi.fn(),
  } as unknown as CdkVirtualScrollViewport & {
    elementRef: { nativeElement: HTMLElement };
    measureScrollOffset: ReturnType<typeof vi.fn>;
    scrollToOffset: ReturnType<typeof vi.fn>;
    checkViewportSize: ReturnType<typeof vi.fn>;
    getRenderedRange: ReturnType<typeof vi.fn>;
    setRenderedRange: ReturnType<typeof vi.fn>;
    setRenderedContentOffset: ReturnType<typeof vi.fn>;
  };
}

function createHarness(remembered?: number) {
  const navigatedBack = signal(false);
  const attached$ = new Subject<string>();
  const detached$ = new Subject<string>();

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
      { provide: BackgroundService, useValue: { set: vi.fn(), release: vi.fn(), url: signal(null) } },
      { provide: DisplaySettingsService, useValue: { settings: signal({ homeBackground: false }) } },
      {
        provide: NavbarService,
        useValue: {
          setPageTitle: vi.fn(),
          clearPageTitle: vi.fn(),
          mobileNavbarVisible: signal(true),
          navigatedBack,
        },
      },
      { provide: TranslateService, useValue: { instant: (key: string) => key } },
      { provide: CachingReuseStrategy, useValue: { attached$, detached$, keyFor: () => OWN_KEY } },
      {
        provide: ScrollMemoryService,
        useValue: { activate: vi.fn(), deactivate: vi.fn(), deactivateIf: vi.fn(), restore: vi.fn(), restoreSticky: vi.fn(), remembered: () => remembered },
      },
      { provide: AppResumeService, useValue: { resume$: EMPTY } },
    ],
  });

  TestBed.overrideComponent(LibraryComponent, { set: { template: '', imports: [] } });

  const fixture = TestBed.createComponent(LibraryComponent);
  fixture.detectChanges(); // runs ngOnInit

  return {
    fixture,
    component: fixture.componentInstance,
    attached$,
    detached$,
    navigatedBack,
  };
}

/** jsdom's `window.scrollTo` is a stub that warns; the component's own resets
 *  are asserted through this spy. */
function spyWindowScrollTo() {
  return vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
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

describe('LibraryComponent — page scroll', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it("derives the active letter from the viewport's own measureScrollOffset()", async () => {
    const { component } = createHarness();
    component.list.setItems(twoSections(), (m) => m.title);
    const viewport = attachViewport(component);

    viewport.measureScrollOffset.mockReturnValue(0);
    window.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(component.list.activeLetter()).toBe('A');

    viewport.measureScrollOffset.mockReturnValue(component.rowHeight());
    window.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(component.list.activeLetter()).toBe('B');
  });

  it('does not restore, nor reset the letter, on a cached re-attach with nothing saved', () => {
    const scrollTo = spyWindowScrollTo();
    const { component, attached$, detached$, navigatedBack } = createHarness();
    navigatedBack.set(true);
    attachViewport(component);

    detached$.next(OWN_KEY);
    attached$.next(OWN_KEY);

    expect(scrollTo).not.toHaveBeenCalled();
    // A cached re-attach is not a content swap: a reset here would land the
    // return from a media detail back at the top of the library.
    expect(component.list.activeLetter()).toBe('');
  });

  it('returns to the top on a forward entry, re-ranging the viewport with it', () => {
    const scrollTo = spyWindowScrollTo();
    const { component, attached$, detached$, navigatedBack } = createHarness();
    const viewport = attachViewport(component);

    detached$.next(OWN_KEY);
    navigatedBack.set(false);
    attached$.next(OWN_KEY);

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
    // The document is shared with every page and may already be at the top, so
    // no scroll event will correct the range the page left with. Re-ranged
    // synchronously and without a measure, so the DOM holds the list's first
    // card before the default focus resolves onto it.
    expect(viewport.setRenderedRange).toHaveBeenCalledWith({ start: 0, end: 11 });
    expect(viewport.setRenderedContentOffset).toHaveBeenCalledWith(0);
    expect(viewport.checkViewportSize).not.toHaveBeenCalled();
  });

  it('re-ranges onto the restored row, not just onto the top', () => {
    const offset = 520 * 8;
    const { component, attached$, detached$, navigatedBack } = createHarness(offset);
    navigatedBack.set(true);
    component.libraryName.set('films'); // the memory key is per library
    component.list.setItems(manyRows(), (m) => m.title);
    const viewport = attachViewport(component);

    detached$.next(OWN_KEY);
    attached$.next(OWN_KEY);

    // The page has no offset of its own — the shared scroll memory holds it,
    // and its sticky restore only lands after the re-attach. Without this the
    // range is whatever the page left with, and the poster morph coming back
    // from a media detail has no card to land on.
    expect(viewport.setRenderedRange).toHaveBeenCalledWith({ start: 8, end: 19 });
    expect(viewport.setRenderedContentOffset).toHaveBeenCalledWith(offset);
  });

  it('VERDICT: puts the restored row at the top of the range, offset painted now', () => {
    const offset = 520 * 50;
    const { component, attached$, detached$, navigatedBack } = createHarness(offset);
    navigatedBack.set(true);
    component.libraryName.set('films'); // the memory key is per library
    component.list.setItems(manyRows(), (m) => m.title);
    const viewport = attachViewport(component);

    detached$.next(OWN_KEY);
    attached$.next(OWN_KEY);

    // A window-scrolling viewport re-ranges off whatever page scrolls while this
    // one is detached, so the range it comes back with can hold the restored row
    // and still be drawn at another page's offset.
    expect(viewport.setRenderedRange).toHaveBeenCalledWith({ start: 50, end: 61 });
    expect(viewport.setRenderedContentOffset).toHaveBeenCalledWith(offset);
    expect(
      viewport.elementRef.nativeElement.querySelector<HTMLElement>(
        '.cdk-virtual-scroll-content-wrapper',
      )!.style.transform,
    ).toBe(`translateY(${offset}px)`);
  });

  it("keeps the active letter through the restore's own scroll event", async () => {
    const { component, attached$, detached$, navigatedBack } = createHarness();
    navigatedBack.set(true);
    component.list.setItems(twoSections(), (m) => m.title);
    const viewport = attachViewport(component);

    viewport.measureScrollOffset.mockReturnValue(component.rowHeight());
    window.dispatchEvent(new Event('scroll'));
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

  it('stops reading the window once detached, so the letter survives the trip', async () => {
    const { component, detached$ } = createHarness();
    component.list.setItems(twoSections(), (m) => m.title);
    const viewport = attachViewport(component);
    viewport.measureScrollOffset.mockReturnValue(component.rowHeight());
    window.dispatchEvent(new Event('scroll'));
    await nextFrame();
    expect(component.list.activeLetter()).toBe('B');

    detached$.next(OWN_KEY);
    // The page the user moved on to scrolls the same window back to the top.
    viewport.measureScrollOffset.mockReturnValue(0);
    window.dispatchEvent(new Event('scroll'));
    await nextFrame();

    expect(component.list.activeLetter()).toBe('B');
  });

  it('reads the window again once reattached', async () => {
    const { component, attached$, detached$, navigatedBack } = createHarness();
    component.list.setItems(twoSections(), (m) => m.title);
    const viewport = attachViewport(component);
    navigatedBack.set(true);

    detached$.next(OWN_KEY);
    attached$.next(OWN_KEY);
    // Past the hold that protects the restore's own scroll event.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
    viewport.measureScrollOffset.mockReturnValue(component.rowHeight());
    window.dispatchEvent(new Event('scroll'));
    await nextFrame();

    expect(component.list.activeLetter()).toBe('B');
  });

  it('resets the scroll on a content swap, but not on a silent revalidation', async () => {
    const scrollTo = spyWindowScrollTo();
    const { component } = createHarness();

    await load(component, true);
    expect(scrollTo).not.toHaveBeenCalled();

    await load(component, false);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
  });

  it('resets the scroll on a view-mode change', () => {
    const scrollTo = spyWindowScrollTo();
    const { component } = createHarness();
    // `setViewMode` no-ops on the mode already active, so start off the target.
    component.viewMode.set('genres');

    component.setViewMode('all');

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
  });

  it('lands a letter jump on the row measured from the document', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'scrollY');
    Object.defineProperty(window, 'scrollY', { value: 50, configurable: true });
    try {
      const { component } = createHarness();
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

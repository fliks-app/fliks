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
import { BackgroundService } from '../../core/services/background.service';
import { DisplaySettingsService } from '../../core/services/display-settings.service';
import { NavbarService } from '../../core/services/navbar.service';
import { TvService } from '../../core/services/tv.service';
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
    measureScrollOffset: ReturnType<typeof vi.fn>;
    scrollToOffset: ReturnType<typeof vi.fn>;
    checkViewportSize: ReturnType<typeof vi.fn>;
  };
}

function createHarness() {
  const attached$ = new Subject<string>();
  const detached$ = new Subject<string>();
  const pageScroller = {
    claim: vi.fn(),
    release: vi.fn(),
    element: signal<HTMLElement | null>(null),
    offset: () => 0,
    scrollTo: vi.fn(),
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
      { provide: MediaService, useValue: {} },
      { provide: StreamingApiService, useValue: {} },
      { provide: OfflinePlaybackSyncService, useValue: {} },
      { provide: PlayableMediaService, useValue: {} },
      { provide: SocialApiService, useValue: {} },
      { provide: LikesApiService, useValue: {} },
      { provide: ProfilesService, useValue: {} },
      { provide: LibrariesApiService, useValue: {} },
      { provide: PageScrollerService, useValue: pageScroller },
      { provide: BackgroundService, useValue: { url: signal(null), applyPool: vi.fn(), clear: vi.fn() } },
      { provide: DisplaySettingsService, useValue: { settings: signal({ homeBackground: false }) } },
      { provide: NavbarService, useValue: { setPageTitle: vi.fn(), clearPageTitle: vi.fn(), mobileNavbarVisible: signal(true) } },
      { provide: TvService, useValue: {} },
      { provide: TranslateService, useValue: { instant: (key: string) => key } },
      { provide: CachingReuseStrategy, useValue: { attached$, detached$, keyFor: () => OWN_KEY } },
      { provide: ScrollMemoryService, useValue: { activate: vi.fn(), deactivateIf: vi.fn(), restoreSticky: vi.fn() } },
      { provide: AppResumeService, useValue: { resume$: EMPTY } },
    ],
  });

  TestBed.overrideComponent(LibraryComponent, { set: { template: '', imports: [] } });

  const fixture = TestBed.createComponent(LibraryComponent);
  fixture.detectChanges(); // runs ngOnInit

  // The template is stubbed out above, so the real `#shell` never resolves —
  // stand in for what Angular's `@ViewChild('shell', { static: true })` would give it.
  const shellEl = document.createElement('div');
  (fixture.componentInstance as unknown as { shellRef: { nativeElement: HTMLElement } }).shellRef = {
    nativeElement: shellEl,
  };

  return { fixture, component: fixture.componentInstance, pageScroller, attached$, detached$, shellEl };
}

describe('LibraryComponent — container scroller', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('derives the active letter from the viewport\'s own measureScrollOffset()', async () => {
    const { component, shellEl } = createHarness();
    component.list.setItems(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) =>
        media(n, n <= 6 ? `Apple ${n}` : `Banana ${n}`),
      ),
      (m) => m.title,
    );

    const viewport = fakeViewport();
    // Simulates Angular resolving the `@ViewChild(CdkVirtualScrollViewport)` query.
    (component as unknown as { viewportRef: CdkVirtualScrollViewport }).viewportRef = viewport;

    viewport.measureScrollOffset.mockReturnValue(0);
    shellEl.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(r));
    expect(component.list.activeLetter()).toBe('A');

    viewport.measureScrollOffset.mockReturnValue(component.rowHeight());
    shellEl.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(r));
    expect(component.list.activeLetter()).toBe('B');
  });

  it('a detach/attach cycle re-claims the same shell without touching the viewport\'s scroll state', () => {
    const { component, pageScroller, attached$, detached$, shellEl } = createHarness();
    const viewport = fakeViewport();
    (component as unknown as { viewportRef: CdkVirtualScrollViewport }).viewportRef = viewport;

    expect(pageScroller.claim).toHaveBeenCalledWith(shellEl);
    pageScroller.claim.mockClear();

    detached$.next(OWN_KEY);
    expect(pageScroller.release).toHaveBeenCalledWith(shellEl);

    attached$.next(OWN_KEY);
    expect(pageScroller.claim).toHaveBeenCalledWith(shellEl);

    // No scroll happened between detach and attach, so there is nothing to restore.
    expect(viewport.scrollToOffset).not.toHaveBeenCalled();
  });

  it('saves the shell\'s scrollTop on detach and restores it via scrollToOffset on attach', () => {
    const { component, attached$, detached$, shellEl } = createHarness();
    const viewport = fakeViewport();
    (component as unknown as { viewportRef: CdkVirtualScrollViewport }).viewportRef = viewport;

    // A detached subtree has no layout box — scrollTop would read back 0 on
    // reattach unless the component captures it itself before that happens.
    shellEl.scrollTop = 1234;
    detached$.next(OWN_KEY);
    attached$.next(OWN_KEY);

    expect(viewport.scrollToOffset).toHaveBeenCalledWith(1234, 'instant');
  });

  it('does not restore on a first attach with nothing saved', () => {
    const { component, attached$, detached$ } = createHarness();
    const viewport = fakeViewport();
    (component as unknown as { viewportRef: CdkVirtualScrollViewport }).viewportRef = viewport;

    detached$.next(OWN_KEY);
    attached$.next(OWN_KEY);

    expect(viewport.scrollToOffset).not.toHaveBeenCalled();
  });
});

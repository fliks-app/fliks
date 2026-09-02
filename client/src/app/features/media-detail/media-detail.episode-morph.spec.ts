import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { EMPTY, of } from 'rxjs';
import { vi, afterEach, describe, it, expect } from 'vitest';
import { MediaDetailComponent } from './media-detail';
import { MediaService } from '../../core/services/api/media.service';
import { MediaDetailReleasePickerService } from './media-detail-release-picker.service';
import { AuthService } from '../../core/services/auth.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { LibrariesApiService } from '../../core/services/api/libraries-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { MarkersApiService } from '../../core/services/api/markers-api.service';
import { RequestsService } from '../../core/services/api/requests.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';
import { SseService } from '../../core/services/sse.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import { TvService } from '../../core/services/tv.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { RecommendService } from '../../core/services/recommend.service';
import { LikesApiService } from '../../core/services/api/likes-api.service';
import { ServerConfigService } from '../../core/services/server-config.service';

/**
 * The poster morph out of an episode card pairs with the episode page's hero,
 * and the browser captures that state roughly a frame after the route swap,
 * long before the media request lands. So the page has to paint its real
 * header from what the card handed over, on the very first pass.
 */
const PARAMS = {
  get: (k: string) => (k === 'id' ? '5' : k === 'episodeId' ? '42' : null),
};

function createFixture(media: Promise<unknown> = new Promise(() => {})) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: ActivatedRoute,
        useValue: {
          paramMap: of(PARAMS),
          snapshot: {
            data: { kind: 'series' },
            paramMap: PARAMS,
          },
        },
      },
      { provide: Router, useValue: { navigate: vi.fn(), getCurrentNavigation: () => ({ trigger: 'imperative' }), events: EMPTY } },
      { provide: MediaService, useValue: { getOne: vi.fn(() => media) } },
      { provide: ServerConfigService, useValue: { resolveUrl: (u: string) => u } },
      { provide: MediaDetailReleasePickerService, useValue: {} },
      { provide: AuthService, useValue: { hasPermission: () => false } },
      { provide: ProfilesService, useValue: {} },
      { provide: LibrariesApiService, useValue: {} },
      { provide: NavbarService, useValue: { enterHeroPage: vi.fn(), leaveHeroPage: vi.fn() } },
      { provide: BackgroundService, useValue: { clear: vi.fn(), setBackgrounds: vi.fn(), setBackground: vi.fn(), url: signal(null) } },
      { provide: ConfirmationService, useValue: {} },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: SseService, useValue: { lastEvent: signal(null) } },
      { provide: StreamingApiService, useValue: {} },
      { provide: MarkersApiService, useValue: {} },
      { provide: RequestsService, useValue: {} },
      { provide: DownloadManagerService, useValue: {} },
      { provide: DownloadProgressService, useValue: { progress: signal(new Map()) } },
      { provide: TvService, useValue: { isTv: () => false } },
      {
        provide: ScrollMemoryService,
        useValue: { activate: vi.fn(), deactivate: vi.fn(), restoreSticky: vi.fn() },
      },
      { provide: AddToPlaylistService, useValue: {} },
      { provide: RecommendService, useValue: {} },
      { provide: LikesApiService, useValue: { state: vi.fn(async () => ({ media: false, seasonIds: [], episodeIds: [] })) } },
    ],
  });
  // State-only: the header's own render pulls in the whole detail page's
  // component tree, and what matters here is that the page is already focused
  // on the handed episode by the time the transition captures the new state.
  TestBed.overrideComponent(MediaDetailComponent, { set: { template: '', imports: [] } });
  return TestBed.createComponent(MediaDetailComponent);
}

describe('MediaDetailComponent — episode seed from the card handoff', () => {
  afterEach(() => TestBed.resetTestingModule());

  const SERIES = {
    id: 5,
    type: 'series',
    title: 'Placeholder',
    seasons: [{ id: 9, seasonNumber: 1, episodes: [{ id: 42, episodeNumber: 3 }] }],
  };

  it('focuses the handed episode on the first pass, with no skeleton', () => {
    history.replaceState({ episode: { id: 42, stillUrl: '/still.jpg', label: 'S01:E03' } }, '');
    const fixture = createFixture();

    fixture.detectChanges();

    const c = fixture.componentInstance;
    expect(c.loading()).toBe(false);
    expect(c.episodeMode()).toBe(true);
    expect(c.focusedEpisode()?.id).toBe(42);
    // No season tree yet: the label comes from the seed so the header is complete.
    expect(c.focusedSeason()).toBeNull();
    expect(c.episodeSeed()?.label).toBe('S01:E03');
  });

  it('waits on its skeleton when no card handed anything over', () => {
    history.replaceState({}, '');
    const fixture = createFixture();

    fixture.detectChanges();

    expect(fixture.componentInstance.loading()).toBe(true);
    expect(fixture.componentInstance.episodeMode()).toBe(false);
  });

  it('resolves the season once the real media lands, replacing the seed', async () => {
    history.replaceState({ episode: { id: 42, stillUrl: '/still.jpg' } }, '');
    const fixture = createFixture(Promise.resolve(SERIES));

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const c = fixture.componentInstance;
    expect(c.focusedSeason()?.id).toBe(9);
    expect(c.notFound()).toBe(false);
  });
});

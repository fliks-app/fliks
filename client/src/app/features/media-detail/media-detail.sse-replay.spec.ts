import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { EMPTY, of } from 'rxjs';
import { vi, afterEach, describe, it, expect } from 'vitest';
import { MediaDetailComponent } from './media-detail';
import { MediaService, Media } from '../../core/services/api/media.service';
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
import { SseService, SseEvent } from '../../core/services/sse.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import { TvService } from '../../core/services/tv.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { RecommendService } from '../../core/services/recommend.service';
import { LikesApiService } from '../../core/services/api/likes-api.service';

const MEDIA_ID = 42;

const MOVIE: Media = {
  id: MEDIA_ID,
  title: 'Test Movie',
  originalTitle: 'Test Movie',
  year: 2024,
  type: 'movie',
  tmdbId: 1,
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

/**
 * Reproduces series -> episode navigation, which destroys and recreates
 * MediaDetailComponent while the root-provided SseService keeps its last
 * event: a fresh instance must treat that stale event as already handled.
 */
function createHarness(seedEvent: SseEvent | null) {
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
          paramMap: EMPTY,
          snapshot: { data: { kind: 'movie' }, paramMap: { get: () => null } },
        },
      },
      { provide: Router, useValue: { navigate: vi.fn(), getCurrentNavigation: () => null } },
      { provide: MediaService, useValue: { getOne: vi.fn(async () => MOVIE) } },
      { provide: MediaDetailReleasePickerService, useValue: {} },
      { provide: AuthService, useValue: { hasPermission: () => false } },
      { provide: ProfilesService, useValue: {} },
      { provide: LibrariesApiService, useValue: {} },
      { provide: NavbarService, useValue: { enterHeroPage: vi.fn(), leaveHeroPage: vi.fn() } },
      { provide: BackgroundService, useValue: { clear: vi.fn(), setBackgrounds: vi.fn(), setBackground: vi.fn(), url: signal(null) } },
      { provide: ConfirmationService, useValue: {} },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: SseService, useValue: { lastEvent: signal(seedEvent) } },
      { provide: StreamingApiService, useValue: {} },
      { provide: MarkersApiService, useValue: {} },
      { provide: RequestsService, useValue: {} },
      { provide: DownloadManagerService, useValue: {} },
      { provide: DownloadProgressService, useValue: { progress: signal(new Map()) } },
      { provide: TvService, useValue: { isTv: () => false } },
      { provide: ScrollMemoryService, useValue: { activate: vi.fn(), deactivate: vi.fn(), restoreSticky: vi.fn() } },
      { provide: AddToPlaylistService, useValue: {} },
      { provide: RecommendService, useValue: {} },
      { provide: LikesApiService, useValue: { state: vi.fn(async () => ({ media: false, seasonIds: [], episodeIds: [] })) } },
    ],
  });

  // Template/child components are irrelevant to the SSE-guard logic under test.
  TestBed.overrideComponent(MediaDetailComponent, { set: { template: '', imports: [] } });

  const fixture = TestBed.createComponent(MediaDetailComponent);
  const toast = TestBed.inject(ToastService) as unknown as { success: ReturnType<typeof vi.fn> };
  const mediaService = TestBed.inject(MediaService) as unknown as { getOne: ReturnType<typeof vi.fn> };

  fixture.detectChanges(); // runs ngOnInit + the initial effect pass

  return { fixture, toast, mediaService };
}

describe('MediaDetailComponent — SSE replay across route-driven recreation', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not replay a metadata.refreshed event the service already retained before construction', () => {
    const staleEvent: SseEvent = { type: 'metadata.refreshed', mediaId: MEDIA_ID };
    const { fixture, toast, mediaService } = createHarness(staleEvent);

    fixture.componentInstance.media.set(MOVIE);
    fixture.detectChanges(); // flush sseEffect now that `media` matches the stale event

    expect(toast.success).not.toHaveBeenCalled();
    expect(mediaService.getOne).not.toHaveBeenCalled(); // reloadAfterRescan never fires
  });

  it('sanity check: a genuinely new event for the same media still fires the toast', () => {
    const { fixture, toast } = createHarness(null);

    fixture.componentInstance.media.set(MOVIE);
    fixture.detectChanges();

    const freshEvent: SseEvent = { type: 'metadata.refreshed', mediaId: MEDIA_ID };
    TestBed.inject(SseService).lastEvent.set(freshEvent);
    fixture.detectChanges();

    expect(toast.success).toHaveBeenCalled();
  });
});

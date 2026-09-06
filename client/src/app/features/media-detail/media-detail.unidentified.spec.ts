import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideTranslateService, TranslateLoader, TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
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
import { SseService } from '../../core/services/sse.service';
import { RemoteService } from '../../core/services/remote.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import { TvService } from '../../core/services/tv.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { RecommendService } from '../../core/services/recommend.service';
import { LikesApiService } from '../../core/services/api/likes-api.service';
import { ServerConfigService } from '../../core/services/server-config.service';

const MEDIA_ID = 42;
const PARAMS = { get: (k: string) => (k === 'id' ? String(MEDIA_ID) : null) };

const BASE_MOVIE: Media = {
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

const UNIDENTIFIED_MOVIE: Media = {
  ...BASE_MOVIE,
  tmdbId: null,
  tvdbId: null,
  imdbId: null,
};

/** Only the admin-callout markup, so the test doesn't drag in the whole page's child tree. */
const CALLOUT_TEMPLATE = `
  @if (isAdmin() && unidentified()) {
    <div class="unidentified-callout">
      {{ 'media_detail.unidentified_callout' | translate }}
      <button (click)="openIdentifyModal()">{{ 'media_detail.identify' | translate }}</button>
    </div>
  }
`;

function createHarness(media: Media, isAdmin: boolean) {
  const getSimilar = vi.fn(async () => []);
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
            data: { kind: 'movie' },
            paramMap: PARAMS,
            queryParamMap: { get: () => null },
          },
        },
      },
      { provide: Router, useValue: { navigate: vi.fn(), getCurrentNavigation: () => null } },
      {
        provide: MediaService,
        useValue: {
          getOne: vi.fn(async () => media),
          getCast: vi.fn(async () => []),
          getCrew: vi.fn(async () => []),
          getSimilar,
          getCollection: vi.fn(async () => null),
        },
      },
      { provide: ServerConfigService, useValue: { resolveUrl: (u: string) => u } },
      { provide: MediaDetailReleasePickerService, useValue: {} },
      { provide: AuthService, useValue: { hasPermission: (p: string) => isAdmin && p === 'settings.access' } },
      { provide: ProfilesService, useValue: {} },
      { provide: LibrariesApiService, useValue: {} },
      { provide: NavbarService, useValue: { enterHeroPage: vi.fn(), leaveHeroPage: vi.fn(), navigatedBack: signal(false) } },
      { provide: BackgroundService, useValue: { clear: vi.fn(), setBackgrounds: vi.fn(), setBackground: vi.fn(), url: signal(null) } },
      { provide: ConfirmationService, useValue: {} },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: SseService, useValue: { lastEvent: signal(null) } },
      { provide: RemoteService, useValue: { browse: vi.fn() } },
      {
        provide: StreamingApiService,
        useValue: {
          getMediaResumeInfo: vi.fn(async () => null),
          getWatchedEpisodeIds: vi.fn(async () => []),
          getEpisodeProgress: vi.fn(async () => ({})),
        },
      },
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

  TestBed.overrideComponent(MediaDetailComponent, {
    set: { template: CALLOUT_TEMPLATE, imports: [TranslateModule] },
  });

  const fixture = TestBed.createComponent(MediaDetailComponent);
  const mediaService = TestBed.inject(MediaService) as unknown as {
    getSimilar: ReturnType<typeof vi.fn>;
  };
  fixture.detectChanges();
  return { fixture, mediaService, getSimilar };
}

describe('MediaDetailComponent, unidentified title', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the callout to an admin on an unidentified title', async () => {
    const { fixture } = createHarness(UNIDENTIFIED_MOVIE, true);
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.unidentified-callout')).not.toBeNull();
  });

  it('hides the callout from a non-admin viewer even on an unidentified title', async () => {
    const { fixture } = createHarness(UNIDENTIFIED_MOVIE, false);
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.unidentified-callout')).toBeNull();
  });

  it('hides the callout for an admin on an identified title', async () => {
    const { fixture } = createHarness(BASE_MOVIE, true);
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.unidentified-callout')).toBeNull();
  });

  it('never calls getSimilar for an unidentified title', async () => {
    const { fixture, getSimilar } = createHarness(UNIDENTIFIED_MOVIE, true);
    await fixture.whenStable();

    expect(getSimilar).not.toHaveBeenCalled();
  });

  it('calls getSimilar for an identified movie', async () => {
    const { fixture, getSimilar } = createHarness(BASE_MOVIE, true);
    await fixture.whenStable();

    expect(getSimilar).toHaveBeenCalledWith(MEDIA_ID);
  });
});

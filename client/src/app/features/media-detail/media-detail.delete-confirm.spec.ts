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
import { SseService } from '../../core/services/sse.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import { TvService } from '../../core/services/tv.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { AddToPlaylistService } from '../../core/services/add-to-playlist.service';
import { RecommendService } from '../../core/services/recommend.service';
import { LikesApiService } from '../../core/services/api/likes-api.service';

const MEDIA_ID = 42;

const baseMovie: Media = {
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

/** Deletion is destructive, so the confirm dialog must name the right consequence
 *  (folder removed vs. DB row only) before the user commits to it. */
function createHarness() {
  const confirm = vi.fn().mockResolvedValue(false);

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
      { provide: MediaService, useValue: { getOne: vi.fn(async () => baseMovie), delete: vi.fn() } },
      { provide: MediaDetailReleasePickerService, useValue: {} },
      { provide: AuthService, useValue: { hasPermission: () => false } },
      { provide: ProfilesService, useValue: {} },
      { provide: LibrariesApiService, useValue: {} },
      { provide: NavbarService, useValue: { enterHeroPage: vi.fn(), leaveHeroPage: vi.fn() } },
      { provide: BackgroundService, useValue: { clear: vi.fn(), setBackgrounds: vi.fn(), setBackground: vi.fn(), url: signal(null) } },
      { provide: ConfirmationService, useValue: { confirm } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: SseService, useValue: { lastEvent: signal(null) } },
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

  TestBed.overrideComponent(MediaDetailComponent, { set: { template: '', imports: [] } });

  const fixture = TestBed.createComponent(MediaDetailComponent);
  fixture.detectChanges();

  return { fixture, confirm };
}

describe('MediaDetailComponent.deleteMedia - confirm message', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('warns about the on-disk folder for a title that owns one', async () => {
    const { fixture, confirm } = createHarness();
    fixture.componentInstance.media.set({ ...baseMovie, folderName: 'Test Movie (2024)' });

    await fixture.componentInstance.deleteMedia();

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'media_detail.confirm_delete' }),
    );
  });

  it('says only the library entry goes for a movie with no folder of its own', async () => {
    const { fixture, confirm } = createHarness();
    fixture.componentInstance.media.set({ ...baseMovie, folderName: '' });

    await fixture.componentInstance.deleteMedia();

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'media_detail.delete_no_folder' }),
    );
  });
});

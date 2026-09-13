import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { BehaviorSubject, EMPTY, of } from 'rxjs';
import { vi, afterEach, beforeEach, describe, it, expect } from 'vitest';
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
 * Two episodes of one series are the same route config, so the page keeps its
 * instance and the route is never detached — the two places that normally move
 * the scroll key. Only the param pass is left to do it.
 */
function paramsFor(episodeId: string) {
  return { get: (k: string) => (k === 'id' ? '5' : k === 'episodeId' ? episodeId : null) };
}

const scrollMemory = { activate: vi.fn(), deactivate: vi.fn(), restoreSticky: vi.fn() };
const navigatedBack = signal(false);

function createFixture() {
  const params = new BehaviorSubject(paramsFor('42'));
  const snapshot = { data: { kind: 'series' }, paramMap: paramsFor('42') };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ActivatedRoute, useValue: { paramMap: params, snapshot } },
      {
        provide: Router,
        useValue: {
          navigate: vi.fn(),
          getCurrentNavigation: () => ({ trigger: 'imperative' }),
          events: EMPTY,
        },
      },
      // Never resolves: the page stays on its first pass, so every scroll call
      // in the assertions is the param pass's own.
      { provide: MediaService, useValue: { getOne: vi.fn(() => new Promise(() => {})) } },
      { provide: ServerConfigService, useValue: { resolveUrl: (u: string) => u } },
      { provide: MediaDetailReleasePickerService, useValue: {} },
      { provide: AuthService, useValue: { hasPermission: () => false } },
      { provide: ProfilesService, useValue: {} },
      { provide: LibrariesApiService, useValue: {} },
      {
        provide: NavbarService,
        useValue: { enterHeroPage: vi.fn(), leaveHeroPage: vi.fn(), navigatedBack },
      },
      {
        provide: BackgroundService,
        useValue: { set: vi.fn(), release: vi.fn(), suspend: vi.fn(), url: signal(null) },
      },
      { provide: ConfirmationService, useValue: {} },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: SseService, useValue: { lastEvent: signal(null) } },
      { provide: StreamingApiService, useValue: {} },
      { provide: MarkersApiService, useValue: {} },
      { provide: RequestsService, useValue: {} },
      { provide: DownloadManagerService, useValue: {} },
      { provide: DownloadProgressService, useValue: { progress: signal(new Map()) } },
      { provide: TvService, useValue: { isTv: () => false } },
      { provide: ScrollMemoryService, useValue: scrollMemory },
      { provide: AddToPlaylistService, useValue: {} },
      { provide: RecommendService, useValue: {} },
      {
        provide: LikesApiService,
        useValue: { state: vi.fn(async () => ({ media: false, seasonIds: [], episodeIds: [] })) },
      },
    ],
  });
  TestBed.overrideComponent(MediaDetailComponent, { set: { template: '', imports: [] } });
  const fixture = TestBed.createComponent(MediaDetailComponent);
  const goTo = (episodeId: string) => {
    snapshot.paramMap = paramsFor(episodeId);
    params.next(paramsFor(episodeId));
    fixture.detectChanges();
  };
  return { fixture, goTo };
}

describe('MediaDetailComponent — scroll memory across a sibling episode', () => {
  beforeEach(() => {
    history.replaceState({}, '');
    navigatedBack.set(false);
    scrollMemory.activate.mockClear();
    scrollMemory.restoreSticky.mockClear();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('moves the key onto the episode opened, without asking for an offset', () => {
    const { fixture, goTo } = createFixture();
    fixture.detectChanges();

    goTo('43');

    expect(scrollMemory.activate).toHaveBeenLastCalledWith('episode-43');
    expect(scrollMemory.restoreSticky).not.toHaveBeenCalled();
  });

  it('restores the offset of the episode returned to', () => {
    const { fixture, goTo } = createFixture();
    fixture.detectChanges();
    goTo('43');

    navigatedBack.set(true);
    goTo('42');

    expect(scrollMemory.activate).toHaveBeenLastCalledWith('episode-42');
    expect(scrollMemory.restoreSticky).toHaveBeenCalledWith('episode-42');
  });
});

import { provideZonelessChangeDetection, signal, type EnvironmentProviders, type Provider } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { MediaService, type Media } from '../../core/services/api/media.service';
import { LikesApiService } from '../../core/services/api/likes-api.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import { RecommendService } from '../../core/services/recommend.service';
import { SpoilerService } from '../../core/services/spoiler.service';
import { ToastService } from '../../core/services/toast.service';
import { TrackingModalService } from '../../core/services/tracking-modal.service';
import { TvService } from '../../core/services/tv.service';
import { MEDIA_DETAIL_HOST, type MediaDetailHost } from './media-detail-host';
import type { RequestFlowController } from './request-flow-controller';

export const BASE_MOVIE: Media = {
  id: 42,
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

/** The shell as a kind page sees it, every signal at rest. */
export function fakeHost(overrides: Partial<MediaDetailHost> = {}): MediaDetailHost {
  return {
    media: signal<Media | null>(null),
    fullLoaded: signal(true),
    notFound: signal(false),
    episodeSeed: signal(null),
    navTitle: signal<string | null>(null),
    returns: signal(0),
    requestFlow: {} as RequestFlowController,
    deleteLoading: signal(false),
    monitoredLoading: signal(false),
    registerPageActions: vi.fn(),
    reload: vi.fn(async () => {}),
    openProfiles: vi.fn(),
    openLibrary: vi.fn(),
    openAnalyze: vi.fn(),
    openIdentify: vi.fn(),
    deleteMedia: vi.fn(async () => {}),
    toggleMonitored: vi.fn(async () => {}),
    refreshMetadata: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Providers of a movie or series page whose template is stubbed out: state only. */
export function videoSpecProviders(
  host: MediaDetailHost,
  services: { media?: object; downloadManager?: object; route?: { id?: string; episodeId?: string; season?: string } } = {},
): (Provider | EnvironmentProviders)[] {
  const params = { get: (k: string) => (k === 'id' ? (services.route?.id ?? '42') : k === 'episodeId' ? (services.route?.episodeId ?? null) : null) };
  return [
    provideZonelessChangeDetection(),
    provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
    { provide: MEDIA_DETAIL_HOST, useValue: host },
    {
      provide: ActivatedRoute,
      useValue: { paramMap: of(params), snapshot: { paramMap: params, queryParamMap: { get: () => services.route?.season ?? null } } },
    },
    {
      provide: MediaService,
      useValue: {
        getCast: vi.fn(async () => []),
        getCrew: vi.fn(async () => []),
        getSimilar: vi.fn(async () => []),
        getCollection: vi.fn(async () => null),
        ...services.media,
      },
    },
    {
      provide: StreamingApiService,
      useValue: {
        getMediaResumeInfo: vi.fn(async () => null),
        getWatchedEpisodeIds: vi.fn(async () => []),
        getEpisodeProgress: vi.fn(async () => ({})),
      },
    },
    { provide: AuthService, useValue: { hasPermission: () => false } },
    { provide: SpoilerService, useValue: { title: (_w: boolean, _l: string, t: string) => t, still: () => false, overview: () => false } },
    { provide: ConfirmationService, useValue: {} },
    { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn(), info: vi.fn() } },
    { provide: DownloadManagerService, useValue: services.downloadManager ?? { tasks: signal([]) } },
    { provide: DownloadProgressService, useValue: { progress: signal(new Map()) } },
    { provide: TrackingModalService, useValue: { open: vi.fn() } },
    { provide: TvService, useValue: { isTv: () => false } },
    { provide: RecommendService, useValue: { open: vi.fn() } },
    {
      provide: LikesApiService,
      useValue: { state: vi.fn(async () => ({ media: false, seasonIds: [], episodeIds: [] })), changed: signal(null) },
    },
  ];
}

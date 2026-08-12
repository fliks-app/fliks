import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MediaDetailReleasePickerService, resolveReleasePickerUrl } from './media-detail-release-picker.service';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { PluginUiEntry } from '../../core/plugin-ui/plugin-ui-response';

describe('resolveReleasePickerUrl', () => {
  it('substitutes :id for a movie route', () => {
    expect(resolveReleasePickerUrl('fliks.acme', '/:id/releases', { id: 7 })).toBe('/api/plugins/fliks.acme/7/releases');
  });

  it('substitutes both :id and :seasonId for a season route', () => {
    expect(resolveReleasePickerUrl('fliks.acme', '/:id/seasons/:seasonId/grab', { id: 7, seasonId: 3 })).toBe(
      '/api/plugins/fliks.acme/7/seasons/3/grab',
    );
  });

  it('substitutes both :id and :episodeId for an episode route', () => {
    expect(resolveReleasePickerUrl('fliks.acme', '/:id/episodes/:episodeId/releases', { id: 7, episodeId: 12 })).toBe(
      '/api/plugins/fliks.acme/7/episodes/12/releases',
    );
  });

  it('returns null — never a request — when a placeholder survives substitution', () => {
    expect(resolveReleasePickerUrl('fliks.acme', '/:id/seasons/:seasonId/releases', { id: 7 })).toBeNull();
  });
});

const ROUTES = {
  movie: { search: '/:id/releases', grab: '/:id/grab' },
  season: { search: '/:id/seasons/:seasonId/releases', grab: '/:id/seasons/:seasonId/grab' },
  episode: { search: '/:id/episodes/:episodeId/releases', grab: '/:id/episodes/:episodeId/grab' },
};

describe('MediaDetailReleasePickerService', () => {
  let http: HttpTestingController;
  let service: MediaDetailReleasePickerService;
  let registry: PluginUiRegistryService;

  const install = async (releasePicker: PluginUiEntry['releasePicker']) => {
    const promise = registry.load();
    http.expectOne('/api/plugins/ui').flush([{ pluginId: 'fliks.acme', contributions: [], configPages: [], releasePicker }]);
    await promise;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(MediaDetailReleasePickerService);
    registry = TestBed.inject(PluginUiRegistryService);
  });

  afterEach(() => http.verify());

  it('builds the proxied movie search URL', async () => {
    await install(ROUTES);
    const promise = service.getMovieReleases(7);
    http.expectOne('/api/plugins/fliks.acme/7/releases').flush([]);
    await promise;
  });

  it('builds the proxied season grab URL and posts the release body', async () => {
    await install(ROUTES);
    const promise = service.grabSeason(7, 3, { downloadUrl: 'magnet:x' });
    const req = http.expectOne('/api/plugins/fliks.acme/7/seasons/3/grab');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ downloadUrl: 'magnet:x' });
    req.flush(null);
    await promise;
  });

  it('builds the proxied episode search URL', async () => {
    await install(ROUTES);
    const promise = service.getEpisodeReleases(7, 12);
    http.expectOne('/api/plugins/fliks.acme/7/episodes/12/releases').flush([]);
    await promise;
  });

  it('sends the trimmed q param only when given one', async () => {
    await install(ROUTES);
    const promise = service.getMovieReleases(7, '  1080p  ');
    const req = http.expectOne((r) => r.url === '/api/plugins/fliks.acme/7/releases');
    expect(req.request.params.get('q')).toBe('1080p');
    req.flush([]);
    await promise;
  });

  it('fires no request and rejects when no plugin declares a picker', async () => {
    await install(undefined);
    await expect(service.getMovieReleases(7)).rejects.toThrow();
  });

  it('fires no request and rejects when the declared route has an unresolvable placeholder', async () => {
    await install({ ...ROUTES, season: { search: '/:id/seasons/:seasonId/releases', grab: '/:id/seasons/:seasonId/:extra/grab' } });
    await expect(service.grabSeason(7, 3)).rejects.toThrow();
  });
});

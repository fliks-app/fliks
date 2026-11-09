import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { SseService } from '../../core/services/sse.service';
import { ToastService } from '../../core/services/toast.service';
import { MediaDetailReleasePickerService, resolveReleasePickerUrl } from './media-detail-release-picker.service';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { AcquisitionTarget } from '../../core/acquisition/acquisition';
import type { PluginUiEntry } from '../../core/plugin-ui/plugin-ui-response';

const target = (t: Partial<AcquisitionTarget> = {}): AcquisitionTarget => ({
  mediaId: 7,
  kind: 'movie',
  level: 'work',
  family: 'video',
  language: null,
  ...t,
});

describe('resolveReleasePickerUrl', () => {
  it('substitutes :id for a work route', () => {
    expect(resolveReleasePickerUrl('fliks.acme', '/:id/releases', target())).toBe('/api/plugins/fliks.acme/7/releases');
  });

  it('substitutes :id and :groupId for a group route', () => {
    expect(resolveReleasePickerUrl('fliks.acme', '/:id/groups/:groupId/grab', target({ groupId: 3 }))).toBe(
      '/api/plugins/fliks.acme/7/groups/3/grab',
    );
  });

  it('substitutes :id and :itemId for an item route', () => {
    expect(resolveReleasePickerUrl('fliks.acme', '/:id/items/:itemId/releases', target({ itemId: 12 }))).toBe(
      '/api/plugins/fliks.acme/7/items/12/releases',
    );
  });

  it('returns null — never a request — when a placeholder survives substitution', () => {
    expect(resolveReleasePickerUrl('fliks.acme', '/:id/groups/:groupId/releases', target())).toBeNull();
  });
});

const ROUTES = {
  byKind: {
    movie: { work: { search: '/:id/releases', grab: '/:id/grab' } },
    series: {
      group: { search: '/:id/groups/:groupId/releases', grab: '/:id/groups/:groupId/grab' },
      item: { search: '/:id/items/:itemId/releases', grab: '/:id/items/:itemId/grab' },
    },
    book: { work: { search: '/:id/releases', grab: '/:id/grab' } },
    comic: { item: { search: '/:id/items/:itemId/releases', grab: '/:id/items/:itemId/grab' } },
  },
};

describe('MediaDetailReleasePickerService', () => {
  let http: HttpTestingController;
  let service: MediaDetailReleasePickerService;
  let registry: PluginUiRegistryService;
  const grabBestEvents = new Subject<Record<string, unknown>>();
  const toast = { error: vi.fn() };

  const install = async (releasePicker: PluginUiEntry['releasePicker']) => {
    const promise = registry.load();
    const acquisition = releasePicker && {
      order: 0,
      routes: releasePicker,
      sources: [{ id: '1', name: 'ix', kinds: ['movie', 'series', 'book', 'comic'] }],
    };
    http.expectOne('/api/plugins/ui').flush([{ pluginId: 'fliks.acme', contributions: [], configPages: [], acquisition }]);
    await promise;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SseService, useValue: { grabBestEvents } },
        { provide: ToastService, useValue: toast },
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
      ],
    });
    toast.error.mockClear();
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(MediaDetailReleasePickerService);
    registry = TestBed.inject(PluginUiRegistryService);
  });

  afterEach(() => http.verify());

  it('builds the proxied work search URL and sends the want aimed at', async () => {
    await install(ROUTES);
    const promise = service.search('fliks.acme', target({ kind: 'book', family: 'audio', language: 'fr' }));
    const req = http.expectOne((r) => r.url === '/api/plugins/fliks.acme/7/releases');
    expect(req.request.params.get('family')).toBe('audio');
    expect(req.request.params.get('language')).toBe('fr');
    req.flush([]);
    await promise;
  });

  it('omits language for an any-language want', async () => {
    await install(ROUTES);
    const promise = service.search('fliks.acme', target());
    const req = http.expectOne((r) => r.url === '/api/plugins/fliks.acme/7/releases');
    expect(req.request.params.has('language')).toBe(false);
    req.flush([]);
    await promise;
  });

  it('builds the proxied group grab URL and posts the want with the release body', async () => {
    await install(ROUTES);
    const promise = service.grab('fliks.acme', target({ kind: 'series', level: 'group', groupId: 3, language: 'en' }), {
      downloadUrl: 'magnet:x',
    });
    const req = http.expectOne('/api/plugins/fliks.acme/7/groups/3/grab');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ family: 'video', language: 'en', downloadUrl: 'magnet:x' });
    req.flush(null);
    await promise;
  });

  const outcome = (name: string, scope: Record<string, unknown> = {}) =>
    grabBestEvents.next({ outcome: name, scope: { mediaId: 7, family: 'video', groupId: null, itemId: 12, ...scope } });

  it('posts a grab-best to the core, a null language for an any-language want, and waits for its outcome', async () => {
    await install(ROUTES);
    const promise = service.grabBest(target({ kind: 'series', level: 'item', itemId: 12 }));
    const req = http.expectOne('/api/media/7/grab-best');
    expect(req.request.body).toEqual({ itemId: 12, family: 'video', language: null });
    req.flush({ mediaId: 7 }, { status: 202, statusText: 'Accepted' });
    outcome('grabbed', { itemId: 99 });
    outcome('grabbed');
    await promise;
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts and throws an outcome that grabbed nothing, even one that lands before the 202', async () => {
    await install(ROUTES);
    const promise = service.grabBest(target({ kind: 'series', level: 'item', itemId: 12 }));
    outcome('none');
    http.expectOne('/api/media/7/grab-best').flush({ mediaId: 7 }, { status: 202, statusText: 'Accepted' });
    await expect(promise).rejects.toThrow('grab-best: none');
    expect(toast.error).toHaveBeenCalledWith('media_detail.grab_best_none');
  });

  it('builds the proxied item search URL of a series and of a comic', async () => {
    await install(ROUTES);
    const episode = service.search('fliks.acme', target({ kind: 'series', level: 'item', itemId: 12 }));
    http.expectOne((r) => r.url === '/api/plugins/fliks.acme/7/items/12/releases').flush([]);
    await episode;
    const issue = service.search('fliks.acme', target({ kind: 'comic', level: 'item', itemId: 5, family: 'image' }));
    http.expectOne((r) => r.url === '/api/plugins/fliks.acme/7/items/5/releases').flush([]);
    await issue;
  });

  it('sends the trimmed q param only when given one', async () => {
    await install(ROUTES);
    const promise = service.search('fliks.acme', target(), '  1080p  ');
    const req = http.expectOne((r) => r.url === '/api/plugins/fliks.acme/7/releases');
    expect(req.request.params.get('q')).toBe('1080p');
    req.flush([]);
    await promise;
  });

  it('fires no request and rejects when no provider is installed', async () => {
    await install(undefined);
    await expect(service.search('fliks.acme', target())).rejects.toThrow();
  });

  it('fires no request and rejects for a kind or a level the plugin does not declare', async () => {
    await install({ byKind: { movie: ROUTES.byKind.movie } });
    await expect(service.search('fliks.acme', target({ kind: 'series', level: 'item', itemId: 3 }))).rejects.toThrow();
    await expect(service.search('fliks.acme', target({ kind: 'comic', level: 'work', family: 'image' }))).rejects.toThrow();
  });

  it('fires no request and rejects when the declared route has an unresolvable placeholder', async () => {
    await install({
      byKind: {
        ...ROUTES.byKind,
        series: { group: { search: '/:id/groups/:groupId/releases', grab: '/:id/groups/:groupId/:extra/grab' } },
      },
    });
    await expect(service.grab('fliks.acme', target({ kind: 'series', level: 'group', groupId: 3 }))).rejects.toThrow();
  });
});

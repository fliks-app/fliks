import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  TranslateLoader,
  provideTranslateService,
  type TranslationObject,
} from '@ngx-translate/core';
import { of } from 'rxjs';
import { errorInterceptor } from './error.interceptor';
import { ToastService } from '../services/toast.service';

// Mirrors the `errors.*` subset of public/i18n/en.json so assertions read the
// same generic copy production shows — not a value invented for the test.
const EN_ERRORS: TranslationObject = {
  errors: {
    network: 'Unable to reach the server',
    '404': 'Resource not found',
    '500': 'Internal server error',
    '503': 'Service temporarily unavailable',
    unknown: 'Error {{code}}',
  },
};

describe('errorInterceptor', () => {
  let http: HttpTestingController;
  let client: HttpClient;
  let toast: ToastService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        provideTranslateService({
          lang: 'en',
          fallbackLang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of(EN_ERRORS) } },
        }),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
    toast = TestBed.inject(ToastService);
  });

  afterEach(() => http.verify());

  /** Fires a GET and flushes the given response; the interceptor rethrows
   *  every error, so the request-site error handler is always a no-op. */
  function fireAndFlush(
    url: string,
    body: Record<string, unknown> | null,
    opts: { status: number; statusText?: string },
  ) {
    client.get(url).subscribe({ error: () => {} });
    http.expectOne(url).flush(body, { statusText: 'Error', ...opts });
  }

  it('shows the translated generic message for a framework 404 (Cannot GET ...), never the raw URL', () => {
    fireAndFlush(
      '/api/download-clients/queue',
      { statusCode: 404, message: 'Cannot GET /api/download-clients/queue', error: 'Not Found' },
      { status: 404 },
    );
    const messages = toast.toasts().map((t) => t.message);
    expect(messages).toEqual(['Resource not found']);
    expect(messages.join()).not.toContain('/api/download-clients');
  });

  it('still shows a real backend 404 message untouched', () => {
    fireAndFlush(
      '/api/media/999',
      { statusCode: 404, message: 'Media not found', error: 'Not Found' },
      { status: 404 },
    );
    expect(toast.toasts().map((t) => t.message)).toEqual(['Media not found']);
  });

  it('surfaces a 503 (an installed-but-unreachable plugin) instead of swallowing it', () => {
    fireAndFlush(
      '/api/download-clients/test-connection',
      { statusCode: 503, message: 'Download client unreachable', error: 'Service Unavailable' },
      { status: 503 },
    );
    expect(toast.toasts().map((t) => t.message)).toEqual(['Download client unreachable']);
  });

  it('still shows a bare 503 with no body message via the generic translation', () => {
    fireAndFlush('/api/download-clients/queue', null, { status: 503 });
    expect(toast.toasts().map((t) => t.message)).toEqual(['Service temporarily unavailable']);
  });

  it('keeps showing 500', () => {
    fireAndFlush('/api/whatever', { message: 'boom' }, { status: 500 });
    expect(toast.toasts().map((t) => t.message)).toEqual(['boom']);
  });

  it('stays silent on 408 (timeout)', () => {
    fireAndFlush('/api/whatever', { message: 'timeout' }, { status: 408 });
    expect(toast.toasts()).toEqual([]);
  });

  it('stays silent on 401 (auth guard owns the redirect)', () => {
    fireAndFlush('/api/whatever', { message: 'unauthorized' }, { status: 401 });
    expect(toast.toasts()).toEqual([]);
  });

  it('stays silent on a metadata GET 500 (degrades in place)', () => {
    fireAndFlush('/api/metadata/search?q=x', { message: 'upstream down' }, { status: 500 });
    expect(toast.toasts()).toEqual([]);
  });

  it('stays silent on the health probe regardless of status', () => {
    fireAndFlush('/api/system/health', { message: 'Cannot GET /api/system/health' }, { status: 404 });
    expect(toast.toasts()).toEqual([]);
  });

  it('stays silent on an i18n load failure', () => {
    fireAndFlush('/i18n/fr.json', { message: 'not found' }, { status: 404 });
    expect(toast.toasts()).toEqual([]);
  });
});

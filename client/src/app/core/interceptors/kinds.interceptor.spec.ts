import { beforeEach, describe, expect, it } from 'vitest';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { KIND_REGISTRY } from '../media-kinds';
import { ServerConfigService } from '../services/server-config.service';
import { kindsInterceptor } from './kinds.interceptor';

describe('kindsInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([kindsInterceptor])),
        provideHttpClientTesting(),
        { provide: ServerConfigService, useValue: { serverUrl: () => 'http://tv.lan:3000' } },
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });

  it('declares the registry kinds on the active server API', () => {
    http.get('/api/media').subscribe();
    const req = ctrl.expectOne('/api/media');
    expect(req.request.headers.get('X-Fliks-Kinds')).toBe(Object.keys(KIND_REGISTRY).join(','));
    req.flush([]);
  });

  it('leaves other hosts and non-API requests alone', () => {
    http.get('http://evil.example/api/media').subscribe();
    http.get('/i18n/fr.json').subscribe();
    expect(ctrl.expectOne('http://evil.example/api/media').request.headers.has('X-Fliks-Kinds')).toBe(false);
    expect(ctrl.expectOne('/i18n/fr.json').request.headers.has('X-Fliks-Kinds')).toBe(false);
  });
});

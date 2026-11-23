import { beforeEach, describe, expect, it } from 'vitest';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { ServerConfigService } from '../services/server-config.service';
import { clientInterceptor } from './client.interceptor';

describe('clientInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([clientInterceptor])),
        provideHttpClientTesting(),
        { provide: ServerConfigService, useValue: { serverUrl: () => 'http://tv.lan:3000' } },
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });

  it('names the build on the active server API', () => {
    http.get('/api/media').subscribe();
    const req = ctrl.expectOne('/api/media');
    expect(req.request.headers.get('X-Fliks-Client')).toMatch(new RegExp(`^(web|desktop|tizen|webos|android|ios)/${environment.version}$`));
    req.flush([]);
  });

  it('leaves other hosts and non-API requests alone', () => {
    http.get('http://evil.example/api/media').subscribe();
    http.get('/i18n/fr.json').subscribe();
    expect(ctrl.expectOne('http://evil.example/api/media').request.headers.has('X-Fliks-Client')).toBe(false);
    expect(ctrl.expectOne('/i18n/fr.json').request.headers.has('X-Fliks-Client')).toBe(false);
  });
});

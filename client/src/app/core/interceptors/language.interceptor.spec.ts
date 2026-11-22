import { beforeEach, describe, expect, it } from 'vitest';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { ServerConfigService } from '../services/server-config.service';
import { languageInterceptor } from './language.interceptor';

describe('languageInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([languageInterceptor])),
        provideHttpClientTesting(),
        { provide: ServerConfigService, useValue: { serverUrl: () => 'http://tv.lan:3000' } },
        { provide: TranslateService, useValue: { currentLang: () => 'fr' } },
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });

  it('declares the UI language on the active server API only', () => {
    http.get('/api/metadata/search').subscribe();
    http.get('http://evil.example/api/x').subscribe();
    expect(ctrl.expectOne('/api/metadata/search').request.headers.get('X-Fliks-Language')).toBe('fr');
    expect(ctrl.expectOne('http://evil.example/api/x').request.headers.has('X-Fliks-Language')).toBe(false);
  });
});

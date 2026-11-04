import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, expect, it } from 'vitest';
import { MetadataService } from './metadata.service';

describe('MetadataService.search', () => {
  function setup() {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
    });
    return { svc: TestBed.inject(MetadataService), http: TestBed.inject(HttpTestingController) };
  }

  it.each([
    ['movie', '/api/metadata/search/movie'],
    ['series', '/api/metadata/search/tv'],
    ['book', '/api/metadata/search/book'],
    ['comic', '/api/metadata/search/comic'],
  ] as const)('asks the %s search with the options as query params', async (kind, url) => {
    const { svc, http } = setup();
    const done = svc.search(kind, 'placeholder', { year: 2001, provider: 'tvdb', mediaId: 5 });
    const req = http.expectOne((r) => r.url === url);
    expect(req.request.params.get('q')).toBe('placeholder');
    expect(req.request.params.get('year')).toBe('2001');
    expect(req.request.params.get('provider')).toBe('tvdb');
    expect(req.request.params.get('mediaId')).toBe('5');
    req.flush([]);
    expect(await done).toEqual([]);
  });

  it('leaves unset options out', async () => {
    const { svc, http } = setup();
    const done = svc.search('book', '', { author: 'Author One', provider: undefined });
    const req = http.expectOne((r) => r.url === '/api/metadata/search/book');
    expect(req.request.params.keys().sort()).toEqual(['author']);
    req.flush([]);
    await done;
  });
});

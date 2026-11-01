import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, expect, it } from 'vitest';
import { BooksApiService } from './books-api.service';
import { collectionDetailFixture, bookSourcesFixture } from './books.fixtures';

describe('BooksApiService', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return { api: TestBed.inject(BooksApiService), http: TestBed.inject(HttpTestingController) };
  }

  it('reads a collection', async () => {
    const { api, http } = setup();
    const p = api.collection(10);
    http.expectOne('/api/collections/10').flush(collectionDetailFixture);
    expect(await p).toEqual(collectionDetailFixture);
  });

  it('drops undefined keys from a source delete', async () => {
    const { api, http } = setup();
    const p = api.deleteSource(1, { level: 'work', provider: 'openlibrary', value: 'OL1W' });
    const req = http.expectOne((r) => r.url === '/api/media/1/sources');
    expect(req.request.method).toBe('DELETE');
    expect(req.request.params.keys().sort()).toEqual(['level', 'provider', 'value']);
    req.flush(bookSourcesFixture);
    await p;
  });
});

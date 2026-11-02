import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchComponent } from './search';
import { MediaService } from '../../core/services/api/media.service';
import { AuthService } from '../../core/services/auth.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { bookSearchResultFixture, collectionSummaryFixture, personListItemFixture } from '../../core/services/api/books.fixtures';

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: Router, useValue: { navigate: vi.fn(), events: of() } },
      { provide: ActivatedRoute, useValue: { snapshot: { data: {}, paramMap: { get: () => null } } } },
      { provide: AuthService, useValue: { sharingDisabled: () => false, hasPermission: () => false } },
      { provide: ScrollMemoryService, useValue: { activate: vi.fn(), restore: vi.fn(), deactivate: vi.fn() } },
      { provide: MediaService, useValue: { getAll: vi.fn(async () => ({ data: [], total: 0 })) } },
    ],
  });
  TestBed.overrideComponent(SearchComponent, { set: { template: '', imports: [] } });
  const fixture = TestBed.createComponent(SearchComponent);
  const state = TestBed.inject(SearchStateService);
  state.contentType.set('book');
  state.externalEnabled.set(true);
  state.query.set('placeholder');
  return { fixture, state, http: TestBed.inject(HttpTestingController) };
}

describe('SearchComponent books', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('searches authors, series and the book providers', async () => {
    const { fixture, http } = setup();
    const search = (fixture.componentInstance as unknown as { runBookSearch(q: string): Promise<void> }).runBookSearch('placeholder');
    http.expectOne((r) => r.url === '/api/persons' && r.params.get('role') === 'author').flush([personListItemFixture]);
    http.expectOne((r) => r.url === '/api/collections' && r.params.get('kind') === 'book').flush([collectionSummaryFixture]);
    http.expectOne((r) => r.url === '/api/metadata/search/book' && r.params.get('q') === 'placeholder').flush([bookSearchResultFixture]);
    await search;
    expect(fixture.componentInstance.bookAuthors()).toEqual([personListItemFixture]);
    expect(fixture.componentInstance.bookSeries()).toEqual([collectionSummaryFixture]);
    expect(fixture.componentInstance.bookExternal()).toEqual([bookSearchResultFixture]);
  });

  it('skips the providers when external search is off', async () => {
    const { fixture, state, http } = setup();
    state.externalEnabled.set(false);
    const search = (fixture.componentInstance as unknown as { runBookSearch(q: string): Promise<void> }).runBookSearch('placeholder');
    http.expectOne((r) => r.url === '/api/persons').flush([]);
    http.expectOne((r) => r.url === '/api/collections').flush([]);
    await search;
    http.expectNone('/api/metadata/search/book');
    expect(fixture.componentInstance.bookExternal()).toEqual([]);
  });

  it('links a provider hit to its add preview, or to the book when owned', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    expect(c.bookLink(bookSearchResultFixture)).toEqual(['/add/book', 'openlibrary', 'OL1W']);
    expect(c.bookLink({ ...bookSearchResultFixture, mediaId: 7 })).toEqual(['/books', '7']);
  });
});

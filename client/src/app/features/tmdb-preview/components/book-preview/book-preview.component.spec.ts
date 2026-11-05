import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi, afterEach, describe, it, expect } from 'vitest';
import { BookPreviewComponent } from './book-preview.component';
import { bookPreviewFixture } from '../../../../testing/books.fixtures';
import { LibrariesApiService, LibrarySummary } from '../../../../core/services/api/libraries-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { ToastService } from '../../../../core/services/toast.service';
import { PREVIEW_HOST } from '../../preview-host';

const lib = (id: number, folders?: { id: number; name: string }[]) =>
  ({ id, name: `Library ${id}`, mediaTypes: ['book'], folders }) as unknown as LibrarySummary;

function setup(libraries: LibrarySummary[], canImport = true, allowed: string[] = canImport ? ['media.create'] : []) {
  const navigate = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: Router, useValue: { navigate } },
      { provide: LibrariesApiService, useValue: { listMine: async () => libraries } },
      { provide: AuthService, useValue: { hasPermission: (p: string) => allowed.includes(p) } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: PREVIEW_HOST, useValue: { setTitle: vi.fn(), setBackground: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(BookPreviewComponent);
  fixture.componentRef.setInput('provider', 'openlibrary');
  fixture.componentRef.setInput('externalId', 'OL1W');
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.expectOne('/api/metadata/openlibrary/book/OL1W').flush(bookPreviewFixture);
  return { fixture, http, navigate };
}

async function settle(fixture: ReturnType<typeof setup>['fixture']) {
  await new Promise((r) => setTimeout(r));
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

async function flushProfiles(fixture: ReturnType<typeof setup>['fixture'], http: HttpTestingController) {
  for (const r of http.match((q) => q.url === '/api/profiles/quality')) {
    r.flush(r.request.params.get('family') === 'text' ? [{ id: 7, name: 'Text' }] : []);
  }
  await settle(fixture);
}

describe('BookPreviewComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists the editions', async () => {
    const { fixture } = setup([lib(1)]);
    const el = await settle(fixture);
    expect(el.textContent).toContain('Publisher One');
    expect(el.querySelectorAll('li').length).toBe(bookPreviewFixture.editions.length);
  });

  it('shows the folder select only when the library has several folders', async () => {
    const one = setup([lib(1, [{ id: 5, name: 'a' }])]);
    expect((await settle(one.fixture)).querySelectorAll('app-library-folder-select select').length).toBe(0);
    TestBed.resetTestingModule();

    const many = setup([lib(1, [{ id: 5, name: 'a' }, { id: 6, name: 'b' }])]);
    expect((await settle(many.fixture)).querySelectorAll('app-library-folder-select select').length).toBe(1);
  });

  it('adds with the chosen library and folder, then opens the book', async () => {
    const { fixture, http, navigate } = setup([lib(1, [{ id: 5, name: 'a' }, { id: 6, name: 'b' }])]);
    await settle(fixture);
    await flushProfiles(fixture, http);
    const pending = fixture.componentInstance.add();
    const req = http.expectOne('/api/media/import');
    expect(req.request.body).toEqual({ type: 'book', provider: 'openlibrary', externalId: 'OL1W', libraryId: 1, folderId: 5,
      wants: [{ family: 'text', language: null, qualityProfileId: 7 }] });
    req.flush({ id: 42, type: 'book' });
    await pending;
    expect(navigate).toHaveBeenCalledWith(['/books', '42']);
  });

  it('adds with the wants edited in the editor', async () => {
    const { fixture, http } = setup([lib(1)]);
    const el = await settle(fixture);
    expect(el.querySelectorAll('[data-testid="want-row"]')).toHaveLength(1);
    await flushProfiles(fixture, http);
    (el.querySelector('[data-testid="wants-editor"] > button') as HTMLButtonElement).click();
    fixture.detectChanges();
    const pending = fixture.componentInstance.add();
    const req = http.expectOne('/api/media/import');
    expect(req.request.body.wants).toHaveLength(2);
    req.flush({ id: 42, type: 'book' });
    await pending;
  });

  it('blocks Add while a want has no profile', async () => {
    const { fixture, http } = setup([lib(1)]);
    const el = await settle(fixture);
    const add = () => el.querySelector('dialog .btn-primary') as HTMLButtonElement;
    expect(add().disabled).toBe(true);
    expect(el.querySelector('[data-testid="book-profile-missing"]')).not.toBeNull();
    await flushProfiles(fixture, http);
    expect(add().disabled).toBe(false);
  });

  it('offers no Add without the import permission', async () => {
    const { fixture } = setup([lib(1)], false);
    const el = await settle(fixture);
    expect(el.querySelector('[data-hero-actions] button')).toBeNull();
    expect(el.querySelector('dialog')).toBeNull();
  });

  it('requests the wished editions when the user cannot add', async () => {
    const { fixture, http } = setup([lib(1)], false, ['requests.create']);
    await settle(fixture);
    http
      .expectOne('/api/requests/title-state?mediaType=book&externalId=OL1W')
      .flush({ requested: true, requestedWants: [{ family: 'audio', language: 'en' }] });
    const el = await settle(fixture);
    expect(el.querySelector('[data-testid="book-already-requested"]')).not.toBeNull();
    await flushProfiles(fixture, http);
    const pending = fixture.componentInstance.request();
    const req = http.expectOne('/api/requests');
    expect(req.request.body).toEqual({
      mediaType: 'book',
      externalId: 'OL1W',
      title: bookPreviewFixture.title,
      libraryId: 1,
      wants: [{ family: 'text', language: null, qualityProfileId: 7 }],
    });
    req.flush({ id: 1 });
    await new Promise((r) => setTimeout(r));
    http.expectOne('/api/requests/title-state?mediaType=book&externalId=OL1W').flush({ requested: true });
    await pending;
  });
});

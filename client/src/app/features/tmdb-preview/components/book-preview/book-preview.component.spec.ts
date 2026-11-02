import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi, afterEach, describe, it, expect } from 'vitest';
import { BookPreviewComponent } from './book-preview.component';
import { bookPreviewFixture } from '../../../../core/services/api/books.fixtures';
import { LibrariesApiService, LibrarySummary } from '../../../../core/services/api/libraries-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { ToastService } from '../../../../core/services/toast.service';

const lib = (id: number, folders?: { id: number; name: string }[]) =>
  ({ id, name: `Library ${id}`, mediaTypes: ['book'], folders }) as unknown as LibrarySummary;

function setup(libraries: LibrarySummary[], canImport = true) {
  const navigate = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: Router, useValue: { navigate } },
      { provide: LibrariesApiService, useValue: { listMine: async () => libraries } },
      { provide: AuthService, useValue: { hasPermission: () => canImport } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
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
    const pending = fixture.componentInstance.add();
    const req = http.expectOne('/api/media/import');
    expect(req.request.body).toEqual({ type: 'book', provider: 'openlibrary', externalId: 'OL1W', libraryId: 1, folderId: 5,
      wants: [{ family: 'text', language: null }, { family: 'audio', language: null }] });
    req.flush({ id: 42, type: 'book' });
    await pending;
    expect(navigate).toHaveBeenCalledWith(['/books', '42']);
  });

  it('adds with the wants edited in the editor', async () => {
    const { fixture, http } = setup([lib(1)]);
    const el = await settle(fixture);
    const rows = el.querySelectorAll('[data-testid="want-row"]');
    expect(rows).toHaveLength(2);
    (rows[1].querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    const pending = fixture.componentInstance.add();
    const req = http.expectOne('/api/media/import');
    expect(req.request.body.wants).toEqual([{ family: 'text', language: null }]);
    req.flush({ id: 42, type: 'book' });
    await pending;
  });

  it('offers no Add without the import permission', async () => {
    const { fixture } = setup([lib(1)], false);
    expect((await settle(fixture)).querySelector('button')).toBeNull();
  });
});

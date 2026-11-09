import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { BookPreviewComponent } from './book-preview.component';
import { bookPreviewFixture } from '../../../../testing/books.fixtures';
import { LibrariesApiService, LibrarySummary } from '../../../../core/services/api/libraries-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { NavbarService } from '../../../../core/services/navbar.service';
import { DeviceService } from '../../../../core/services/device.service';
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
      { provide: NavbarService, useValue: { heroPaddingTop: () => null } },
      { provide: DeviceService, useValue: { isTv: () => false } },
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

describe('BookPreviewComponent', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    // jsdom has no dialog methods.
    HTMLDialogElement.prototype.close ??= function () {};
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('lists the editions', async () => {
    const { fixture } = setup([lib(1)]);
    const el = await settle(fixture);
    expect(el.textContent).toContain('Publisher One');
    expect(el.querySelectorAll('li').length).toBe(bookPreviewFixture.editions.length);
  });

  it('opens the add dialog on Add, and navigates to the book once added', async () => {
    const { fixture, navigate } = setup([lib(1)]);
    const el = await settle(fixture);
    expect(el.querySelector('app-add-dialog')).not.toBeNull();
    const cmp = fixture.componentInstance as unknown as { onAdded(r: { mode: string; mediaId: number | null }): void };
    cmp.onAdded({ mode: 'import', mediaId: 42 });
    expect(navigate).toHaveBeenCalledWith(['/books', '42']);
  });

  it('offers no Add without the import permission', async () => {
    const { fixture } = setup([lib(1)], false);
    const el = await settle(fixture);
    expect(el.querySelector('[data-hero-actions] button')).toBeNull();
    expect(el.querySelector('dialog')).toBeNull();
  });

  it('hands the editions already requested to the dialog for a user who cannot add', async () => {
    const { fixture, http } = setup([lib(1)], false, ['requests.create']);
    await settle(fixture);
    http
      .expectOne('/api/requests/title-state?mediaType=book&externalId=OL1W')
      .flush({ requested: true, requestedWants: [{ family: 'audio', language: 'en' }] });
    await settle(fixture);
    const cmp = fixture.componentInstance as unknown as { requested(): unknown[] };
    expect(cmp.requested()).toEqual([{ family: 'audio', language: 'en' }]);
  });
});

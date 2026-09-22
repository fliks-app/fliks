import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi, afterEach, describe, it, expect } from 'vitest';
import { TmdbPreviewComponent } from './tmdb-preview';
import { MetadataService, MetadataDetails } from '../../core/services/api/metadata.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { LibrariesApiService } from '../../core/services/api/libraries-api.service';
import { RequestsService, FliksRequestRow } from '../../core/services/api/requests.service';
import { ToastService } from '../../core/services/toast.service';
import { TvService } from '../../core/services/tv.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import { AuthService } from '../../core/services/auth.service';

const FAKE_DETAILS = { tmdbId: 1, title: 'Test Title', logoUrl: null } as MetadataDetails;

const FAKE_APPROVED = {
  id: 7,
  mediaType: 'movie',
  media: { id: 99 },
} as FliksRequestRow;

const FAKE_EDIT_ROW = {
  id: 5,
  qualityProfileId: 1,
  languageProfileId: 1,
  libraryId: 1,
} as FliksRequestRow;

/** Approving a request imports the title with a server-side await that can
 *  outlive the page (e.g. the user navigates back to Discover first). */
function createHarness() {
  const navigate = vi.fn();
  const getDetails = vi.fn(async () => FAKE_DETAILS);
  const approve = vi.fn(async () => FAKE_APPROVED);
  const update = vi.fn(async () => FAKE_EDIT_ROW);
  const decline = vi.fn(async () => FAKE_APPROVED);
  const list = vi.fn(async () => ({ data: [], total: 0 }));
  const toast = { success: vi.fn() };
  const navbar = { enterHeroPage: vi.fn(), leaveHeroPage: vi.fn() };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: { get: () => null } } },
      },
      { provide: Router, useValue: { url: '/discover', navigate } },
      { provide: MetadataService, useValue: { getDetails } },
      { provide: ProfilesService, useValue: {} },
      { provide: LibrariesApiService, useValue: {} },
      { provide: RequestsService, useValue: { approve, update, decline, list } },
      { provide: ToastService, useValue: toast },
      { provide: TvService, useValue: { isTv: () => false } },
      { provide: NavbarService, useValue: navbar },
      { provide: BackgroundService, useValue: { set: vi.fn(), release: vi.fn() } },
      { provide: AuthService, useValue: { hasPermission: () => false } },
      { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
    ],
  });

  TestBed.overrideComponent(TmdbPreviewComponent, { set: { template: '', imports: [] } });

  const fixture = TestBed.createComponent(TmdbPreviewComponent);

  return { fixture, navigate, approve, update, decline, list, toast, navbar };
}

describe('TmdbPreviewComponent.approveRequest', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not navigate once the component was destroyed while approving', async () => {
    const { fixture, navigate } = createHarness();
    fixture.detectChanges();

    const pending = fixture.componentInstance.approveRequest(7);
    fixture.destroy();
    await pending;

    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates to the imported media on a normal approval', async () => {
    const { fixture, navigate } = createHarness();
    fixture.detectChanges();

    await fixture.componentInstance.approveRequest(7);

    expect(navigate).toHaveBeenCalledWith(['/movies', 99]);
  });
});

describe('TmdbPreviewComponent.ngOnInit', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not enter the hero page once the component was destroyed while loading', async () => {
    const { fixture, navbar } = createHarness();

    const pending = fixture.componentInstance.ngOnInit();
    fixture.destroy();
    await pending;

    expect(navbar.enterHeroPage).not.toHaveBeenCalled();
  });
});

describe('TmdbPreviewComponent.saveEdit', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not toast success once the component was destroyed while saving', async () => {
    const { fixture, toast } = createHarness();
    fixture.detectChanges();
    fixture.componentInstance.editingRequest.set(FAKE_EDIT_ROW);

    const pending = fixture.componentInstance.saveEdit();
    fixture.destroy();
    await pending;

    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('TmdbPreviewComponent.submitDecline', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not refresh pending requests once the component was destroyed while declining', async () => {
    const { fixture, list } = createHarness();
    // media must be loaded first: refreshPendingRequests is a no-op without it.
    await fixture.componentInstance.ngOnInit();
    fixture.componentInstance.declineForId.set(5);

    const pending = fixture.componentInstance.submitDecline();
    fixture.destroy();
    await pending;

    expect(list).not.toHaveBeenCalled();
  });
});

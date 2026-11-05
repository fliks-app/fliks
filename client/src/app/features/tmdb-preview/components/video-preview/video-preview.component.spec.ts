import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer } from '@angular/platform-browser';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi, afterEach, describe, it, expect } from 'vitest';
import { VideoPreviewComponent } from './video-preview.component';
import { PREVIEW_HOST } from '../../preview-host';
import { MetadataService, MetadataDetails } from '../../../../core/services/api/metadata.service';
import { ProfilesService } from '../../../../core/services/api/profiles.service';
import { LibrariesApiService } from '../../../../core/services/api/libraries-api.service';
import { RequestsService, FliksRequestRow } from '../../../../core/services/api/requests.service';
import { ToastService } from '../../../../core/services/toast.service';
import { TvService } from '../../../../core/services/tv.service';
import { NavbarService } from '../../../../core/services/navbar.service';
import { AuthService } from '../../../../core/services/auth.service';

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
  const host = { setTitle: vi.fn(), setBackground: vi.fn() };
  const navbar = { markAsBackNavigation: vi.fn() };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: { get: () => null }, data: { kind: 'movie' } } },
      },
      { provide: Router, useValue: { url: '/discover', navigate } },
      { provide: MetadataService, useValue: { getDetails } },
      { provide: ProfilesService, useValue: {} },
      { provide: LibrariesApiService, useValue: {} },
      { provide: RequestsService, useValue: { approve, update, decline, list } },
      { provide: ToastService, useValue: toast },
      { provide: TvService, useValue: { isTv: () => false } },
      { provide: NavbarService, useValue: navbar },
      { provide: PREVIEW_HOST, useValue: host },
      { provide: AuthService, useValue: { hasPermission: () => false } },
      { provide: DomSanitizer, useValue: { bypassSecurityTrustResourceUrl: (u: string) => u } },
    ],
  });

  TestBed.overrideComponent(VideoPreviewComponent, { set: { template: '', imports: [] } });

  const fixture = TestBed.createComponent(VideoPreviewComponent);
  fixture.componentRef.setInput('provider', 'tmdb');
  fixture.componentRef.setInput('externalId', '1');

  return { fixture, navigate, approve, update, decline, list, toast, host };
}

describe('VideoPreviewComponent.approveRequest', () => {
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

    expect(navigate).toHaveBeenCalledWith(['/movies', '99'], { replaceUrl: true });
  });
});

describe('VideoPreviewComponent.ngOnInit', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not name the hero page once the component was destroyed while loading', async () => {
    const { fixture, host } = createHarness();

    const pending = fixture.componentInstance.ngOnInit();
    fixture.destroy();
    await pending;

    expect(host.setTitle).not.toHaveBeenCalled();
  });

  it('names the hero page after the title once it lands', async () => {
    const { fixture, host } = createHarness();

    await fixture.componentInstance.ngOnInit();

    expect(host.setTitle).toHaveBeenCalledWith('Test Title', null);
  });
});

describe('VideoPreviewComponent.saveEdit', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not toast success once the component was destroyed while saving', async () => {
    const { fixture, toast } = createHarness();
    fixture.detectChanges();
    fixture.componentInstance.edit.row.set(FAKE_EDIT_ROW);

    const pending = fixture.componentInstance.saveEdit();
    fixture.destroy();
    await pending;

    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('VideoPreviewComponent.submitDecline', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not refresh pending requests once the component was destroyed while declining', async () => {
    const { fixture, list } = createHarness();
    // media must be loaded first: refreshPendingRequests is a no-op without it.
    await fixture.componentInstance.ngOnInit();
    fixture.componentInstance.decline.forId.set(5);

    const pending = fixture.componentInstance.submitDecline();
    fixture.destroy();
    await pending;

    expect(list).not.toHaveBeenCalled();
  });
});

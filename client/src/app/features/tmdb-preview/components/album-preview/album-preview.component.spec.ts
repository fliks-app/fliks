import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlbumPreviewComponent } from './album-preview.component';
import { LibrariesApiService } from '../../../../core/services/api/libraries-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { NavbarService } from '../../../../core/services/navbar.service';
import { DeviceService } from '../../../../core/services/device.service';
import { ServerVersionService } from '../../../../core/services/server-version.service';
import { ToastService } from '../../../../core/services/toast.service';
import { PREVIEW_HOST } from '../../preview-host';

const preview = (o: object = {}) => ({
  provider: 'musicbrainz', externalId: 'g1', title: 'Alpha', year: 1999, posterUrl: null,
  artists: [{ name: 'Ana', creditedName: null, joinPhrase: null, externalId: 'a1' }],
  release: { externalId: 'r1', title: 'Alpha', country: 'FR', releaseDate: '1999-05-01' },
  tracks: [
    { recordingId: 'x1', discNumber: 1, position: 1, number: 1, title: 'One', durationMs: 100000 },
    { recordingId: 'x2', discNumber: 2, position: 2, number: 1, title: 'Two', durationMs: 50000 },
  ],
  trackCount: 2, durationMs: 150000, existingMediaId: null, ...o,
});

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      provideRouter([]),
      { provide: LibrariesApiService, useValue: { listMine: async () => [] } },
      { provide: AuthService, useValue: { hasPermission: (p: string) => p === 'media.create' } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: NavbarService, useValue: { heroPaddingTop: () => null } },
      { provide: DeviceService, useValue: { isTv: () => false } },
      { provide: ServerVersionService, useValue: { supports: () => true, supportsWhenKnown: async () => true } },
      { provide: PREVIEW_HOST, useValue: { setTitle: vi.fn(), setBackground: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(AlbumPreviewComponent);
  fixture.componentRef.setInput('provider', 'musicbrainz');
  fixture.componentRef.setInput('externalId', 'g1');
  fixture.componentRef.setInput('seed', { title: 'Alpha', posterUrl: null });
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

async function settle(fixture: ReturnType<typeof setup>['fixture']) {
  await new Promise((r) => setTimeout(r));
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('AlbumPreviewComponent', () => {
  beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }));
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('shows a skeleton, then the tracklist with disc headers', async () => {
    const { fixture, http } = setup();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="tracklist-skeleton"]')).not.toBeNull();
    http.expectOne('/api/metadata/musicbrainz/album/g1').flush(preview());
    const el = await settle(fixture);
    expect(el.querySelectorAll('[data-testid="preview-track"]').length).toBe(2);
    expect(el.querySelectorAll('[data-testid="tracklist"] h3').length).toBe(2);
    expect(el.querySelector('[data-testid="tracklist-skeleton"]')).toBeNull();
  });

  it('offers the library link for an owned album and a retry on failure', async () => {
    const { fixture, http } = setup();
    http.expectOne('/api/metadata/musicbrainz/album/g1').flush('boom', { status: 503, statusText: 'x' });
    const el = await settle(fixture);
    expect(el.querySelector('[data-testid="preview-failed"]')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('[data-testid="preview-failed"] button')!.click();
    http.expectOne('/api/metadata/musicbrainz/album/g1').flush(preview({ existingMediaId: 5 }));
    await settle(fixture);
    expect(el.querySelector('a[href="/albums/5"]')).not.toBeNull();
  });
});

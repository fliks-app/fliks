import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../core/services/auth.service';
import { LibrariesApiService } from '../../core/services/api/libraries-api.service';
import { bookSpecProviders } from '../media-detail/book/book-test-setup';
import { ArtistPageComponent } from './artist-page.component';

describe('ArtistPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('groups owned albums by type and lists the missing ones apart', async () => {
    TestBed.configureTestingModule({
      providers: bookSpecProviders(
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: '4' })) } },
        { provide: AuthService, useValue: { hasPermission: () => false, user: () => null, sessionEpoch: () => 0, isAuthenticated: () => false } },
        { provide: LibrariesApiService, useValue: { listMine: async () => [] } },
      ),
    });
    const fixture = TestBed.createComponent(ArtistPageComponent);
    fixture.detectChanges();
    const album = { mediaId: 1, externalId: null, title: 'A', year: 2000, primaryType: 'Album', secondaryTypes: [], posterUrl: null, owned: true, monitored: false, trackCount: 1, ownedTrackCount: 1 };
    TestBed.inject(HttpTestingController).expectOne('/api/persons/4/discography').flush({
      artist: { id: 4, name: 'Band', sortName: null, disambiguation: null, artistType: 'Group', biography: 'Bio', imageUrl: null, following: false },
      albums: [album, { ...album, mediaId: null, externalId: 'x', title: 'M', owned: false }, { ...album, mediaId: 2, primaryType: 'Single' }],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="artist-name"]')?.textContent).toBe('Band');
    expect(el.querySelectorAll('[data-testid="release-group"]').length).toBe(2);
    expect(el.querySelectorAll('[data-testid="missing-group"] app-media-card').length).toBe(1);
  });
});

import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/services/auth.service';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { LibrariesApiService } from '../../core/services/api/libraries-api.service';
import { bookSpecProviders } from '../media-detail/book/book-test-setup';
import { ArtistPageComponent } from './artist-page.component';

describe('ArtistPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  function setup(perms: string[] = []) {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const playTracks = vi.fn();
    TestBed.configureTestingModule({
      providers: bookSpecProviders(
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: '4' })) } },
        { provide: AuthService, useValue: { hasPermission: (p: string) => perms.includes(p), user: () => null, sessionEpoch: () => 0, isAuthenticated: () => false } },
        { provide: LibrariesApiService, useValue: { listMine: async () => [] } },
        { provide: AudioPlayerService, useValue: { playTracks } },
      ),
    });
    const fixture = TestBed.createComponent(ArtistPageComponent);
    fixture.detectChanges();
    return { fixture, playTracks, http: TestBed.inject(HttpTestingController) };
  }

  const artist = { id: 4, name: 'Band', sortName: null, disambiguation: null, artistType: 'Group', biography: 'Bio', imageUrl: null, following: false };
  const album = { mediaId: 1, externalId: null, title: 'A', year: 2000, primaryType: 'Album', secondaryTypes: [], posterUrl: null, owned: true, monitored: false, trackCount: 1, ownedTrackCount: 1 };
  const track = { itemId: 7, mediaId: 1, hasFile: true, title: 'Hit', albumTitle: 'A', posterUrl: null, durationSeconds: 60, artists: [], gain: null, peak: null };

  it('filters the discography by chip, owned and missing together', async () => {
    const { fixture, http } = setup();
    http.expectOne('/api/persons/4/discography').flush({
      artist,
      albums: [album, { ...album, mediaId: null, externalId: 'x', title: 'M', owned: false }, { ...album, mediaId: 2, title: 'S', primaryType: 'Single' }],
      partial: false,
      popular: [],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="person-name"]')?.textContent).toBe('Band');
    expect(el.querySelectorAll('[data-testid="discography"] app-media-card').length).toBe(2);
    expect(el.querySelector('[data-testid="discography"] app-media-card[badge="missing"]')).not.toBeNull();
    const chips = el.querySelectorAll<HTMLButtonElement>('[data-testid="discography-tabs"] button');
    expect(chips.length).toBe(2);
    chips[1]!.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-testid="discography"] app-media-card').length).toBe(1);
    expect(el.querySelector('[data-testid="discography-partial"]')).toBeNull();
  });

  it('plays an owned popular track and offers the missing one', async () => {
    const { fixture, http, playTracks } = setup(['media.create']);
    http.expectOne('/api/persons/4/discography').flush({
      artist,
      albums: [],
      partial: false,
      popular: [
        { recordingId: 'r1', title: 'Hit', durationMs: 1000, listenCount: 9, albumExternalId: 'g1', albumTitle: 'A', coverUrl: null, track },
        { recordingId: 'r2', title: 'Other', durationMs: 1000, listenCount: 5, albumExternalId: 'g2', albumTitle: 'B', coverUrl: null, track: null },
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const rows = el.querySelectorAll('[data-testid="popular-track"]');
    expect(rows.length).toBe(2);
    rows[0]!.querySelector<HTMLButtonElement>('button')!.click();
    expect(playTracks).toHaveBeenCalledOnce();
    const add = vi.spyOn(fixture.componentInstance['addDialog']()!, 'add').mockResolvedValue(undefined as never);
    el.querySelector<HTMLButtonElement>('[data-testid="add-track"]')!.click();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'g2', recording: { externalId: 'r2', albumExternalId: 'g2' } }));
  });

  it('says the discography failed instead of no albums, and retries', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    TestBed.configureTestingModule({
      providers: bookSpecProviders(
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: '4' })) } },
        { provide: AuthService, useValue: { hasPermission: () => false, user: () => null, sessionEpoch: () => 0, isAuthenticated: () => false } },
        { provide: LibrariesApiService, useValue: { listMine: async () => [] } },
      ),
    });
    history.replaceState({ person: { id: 4, name: 'Handed', avatarUrl: null } }, '');
    const fixture = TestBed.createComponent(ArtistPageComponent);
    fixture.detectChanges();
    history.replaceState(null, '');
    const http = TestBed.inject(HttpTestingController);
    const early = fixture.nativeElement as HTMLElement;
    expect(early.querySelector('[data-testid="discography-skeleton"]')).not.toBeNull();
    expect(early.querySelector('[data-testid="person-name"]')?.textContent).toBe('Handed');
    http.expectOne('/api/persons/4/discography').flush({ artist, albums: [], partial: true, popular: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="discography-partial"]')).not.toBeNull();
    expect(el.textContent).not.toContain('music.no_albums');
    el.querySelector<HTMLButtonElement>('[data-testid="discography-partial"] button')!.click();
    http.expectOne('/api/persons/4/discography').flush({ artist, albums: [], partial: false, popular: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="discography-partial"]')).toBeNull();
  });
});

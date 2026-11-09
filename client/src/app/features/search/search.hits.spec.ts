import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchComponent } from './search';
import { MusicApiService } from '../../core/services/api/music-api.service';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import type { ArtistHit, SearchHit } from '../../core/services/api/metadata.service';
import { AuthService } from '../../core/services/auth.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { SearchStateService } from '../../core/services/search-state.service';

const hit = (extra: Partial<SearchHit> = {}): SearchHit =>
  ({ provider: 'tmdb', externalId: '1', mediaType: 'movie', title: 'T', year: 2000, posterUrl: null, existingMediaId: null, tmdbId: 1, ...extra }) as SearchHit;

function setup(perms: string[] = ['media.create']) {
  const navigate = vi.fn();
  const resolveArtist = vi.fn(async () => ({ id: 77 }));
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: Router, useValue: { navigate, events: of() } },
      { provide: ActivatedRoute, useValue: { snapshot: { data: {}, paramMap: { get: () => null } } } },
      { provide: AuthService, useValue: { sharingDisabled: () => false, hasPermission: (p: string) => perms.includes(p) } },
      { provide: ScrollMemoryService, useValue: { activate: vi.fn(), restore: vi.fn(), deactivateIf: vi.fn() } },
      { provide: MusicApiService, useValue: { resolveArtist } },
      { provide: AudioPlayerService, useValue: {} },
    ],
  });
  TestBed.overrideComponent(SearchComponent, { set: { template: '', imports: [] } });
  const fixture = TestBed.createComponent(SearchComponent);
  return { c: fixture.componentInstance, state: TestBed.inject(SearchStateService), navigate, resolveArtist };
}

describe('SearchComponent hits', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('says what the library holds: owned, wanted, missing, else the request of the caller', () => {
    const { c } = setup();
    expect(c.cardStatus(hit({ state: 'owned' }))).toBe('library');
    expect(c.cardStatus(hit({ state: 'wanted' }))).toBe('wanted');
    expect(c.cardStatus(hit({ state: 'missing' }))).toBe('missing');
    expect(c.cardStatus(hit({ requestStatus: 'pending' }))).toBe('pending');
    expect(c.cardStatus(hit({ requestStatus: 'declined' }))).toBe('declined');
    expect(c.cardStatus(hit({ requestStatus: 'available' }))).toBe('library');
    expect(c.cardStatus(hit())).toBeNull();
  });

  it('offers Add to someone who can add and Request to someone who cannot, nothing for a held or asked title', () => {
    expect(setup().c.hitActions(hit())[0]?.labelKey).toBe('discover.add_to_library');
    TestBed.resetTestingModule();
    expect(setup(['requests.create']).c.hitActions(hit())[0]?.labelKey).toBe('discover.request');
    TestBed.resetTestingModule();
    const { c } = setup();
    expect(c.hitActions(hit({ existingMediaId: 4 }))).toEqual([]);
    expect(c.hitActions(hit({ requestStatus: 'pending' }))).toEqual([]);
    TestBed.resetTestingModule();
    expect(setup([]).c.hitActions(hit())).toEqual([]);
  });

  it('links a hit to its add preview, or to the library page of the title it holds', () => {
    const { c } = setup();
    expect(c.externalLink(hit({ provider: 'tvdb', externalId: '9' }))).toEqual(['/add/movie', 'tvdb', '9']);
    expect(c.externalLink(hit({ mediaType: 'album', provider: 'musicbrainz', externalId: 'g' }))).toEqual(['/add/album', 'musicbrainz', 'g']);
    expect(c.externalLink(hit({ existingMediaId: 4, mediaType: 'book' }))).toEqual(['/books', '4']);
  });

  it('opens a provider artist through the person it resolves, once, then straight for a known one', async () => {
    const { c, navigate, resolveArtist } = setup();
    const open = (a: ArtistHit) => (c as unknown as { openArtist(a: ArtistHit): Promise<void> }).openArtist(a);
    const a = { provider: 'musicbrainz', externalId: 'x', name: 'N', sortName: null, personId: null } as ArtistHit;
    await open(a);
    expect(resolveArtist).toHaveBeenCalledWith({ provider: 'musicbrainz', externalId: 'x', name: 'N', sortName: null });
    expect(navigate).toHaveBeenCalledWith(['/artists', 77]);
    await open({ ...a, personId: 5 });
    expect(resolveArtist).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenLastCalledWith(['/artists', 5]);
  });
});

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
import type { ArtistHit, RecordingHit, SearchHit } from '../../core/services/api/metadata.service';
import { MusicDownloadsService } from '../../core/services/music-downloads.service';
import { AuthService } from '../../core/services/auth.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { SearchStateService } from '../../core/services/search-state.service';

const hit = (extra: Partial<SearchHit> = {}): SearchHit =>
  ({ provider: 'tmdb', externalId: '1', mediaType: 'movie', title: 'T', year: 2000, posterUrl: null, existingMediaId: null, tmdbId: 1, ...extra }) as SearchHit;

function setup(perms: string[] = ['media.create']) {
  const navigate = vi.fn();
  const resolveArtist = vi.fn(async () => ({ id: 77 }));
  const playTracks = vi.fn(async () => undefined);
  const albumTracks = vi.fn(async () => [{ itemId: 3 }, { itemId: 4 }]);
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
      { provide: AudioPlayerService, useValue: { playTracks } },
      { provide: MusicDownloadsService, useValue: { albumTracks } },
    ],
  });
  TestBed.overrideComponent(SearchComponent, { set: { template: '', imports: [] } });
  const fixture = TestBed.createComponent(SearchComponent);
  return { c: fixture.componentInstance, state: TestBed.inject(SearchStateService), navigate, resolveArtist, playTracks, albumTracks };
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

  const rec = (id: string, album: SearchHit, extra: Partial<RecordingHit> = {}) =>
    ({ provider: 'musicbrainz', externalId: id, title: id, artists: ['A'], durationMs: null, album, existingMediaId: null, state: null, trackId: null, ...extra }) as RecordingHit;
  type View = { music(): { tracks: { state: string; key: string }[] }; addItem(i: object): void; onAdded(r: object): void; onCancelled(): void; openItem(i: object): Promise<void> };

  it('shows a track pending at once, then back to add when the add is cancelled', () => {
    const { c, state } = setup();
    state.query.set('x');
    state.recordingHits.set([rec('r', hit({ mediaType: 'album' }))]);
    const v = c as unknown as View;
    expect(v.music().tracks[0]!.state).toBe('add');
    v.addItem(v.music().tracks[0]!);
    expect(v.music().tracks[0]!.state).toBe('pending');
    v.onCancelled();
    expect(v.music().tracks[0]!.state).toBe('add');
  });

  it('flips a track to wanted once it is added', () => {
    const { c, state } = setup();
    state.query.set('x');
    state.recordingHits.set([rec('r', hit({ mediaType: 'album' }))]);
    const v = c as unknown as View;
    v.addItem(v.music().tracks[0]!);
    v.onAdded({ mode: 'import', mediaId: 31, recordings: ['r'] });
    expect(state.recordingHits()[0]).toMatchObject({ existingMediaId: 31, state: 'wanted' });
    expect(v.music().tracks[0]!.state).toBe('pending');
  });

  it('marks a track requested for a caller who cannot add', () => {
    const { c, state } = setup(['requests.create']);
    state.query.set('x');
    state.recordingHits.set([rec('r', hit({ mediaType: 'album' }))]);
    const v = c as unknown as View;
    v.addItem(v.music().tracks[0]!);
    v.onAdded({ mode: 'request', mediaId: null, recordings: ['r'] });
    expect(state.recordingHits()[0]!.requestStatus).toBe('pending');
  });

  it('flips every track of an album added as a whole', () => {
    const { c, state } = setup();
    state.query.set('x');
    const album = hit({ mediaType: 'album', provider: 'musicbrainz', externalId: 'g' });
    state.albumHits.set([album]);
    state.recordingHits.set([rec('a', album), rec('b', album)]);
    const v = c as unknown as View;
    v.addItem(v.music().tracks[0]!);
    v.onAdded({ mode: 'import', mediaId: 32 });
    expect(state.recordingHits().map((r) => r.existingMediaId)).toEqual([32, 32]);
    expect(state.albumHits()[0]).toMatchObject({ existingMediaId: 32, state: 'wanted' });
  });

  it('opens an owned track by playing its album from that track, else the album page or the add preview', async () => {
    const { c, state, navigate, playTracks, albumTracks } = setup();
    state.query.set('x');
    const album = hit({ mediaType: 'album', provider: 'musicbrainz', externalId: 'g' });
    state.recordingHits.set([
      rec('o', album, { existingMediaId: 9, trackId: 4, state: 'owned' }),
      rec('n', album, { release: { externalId: 'rel', title: 'T' } }),
    ]);
    const v = c as unknown as View;
    await v.openItem(v.music().tracks[0]!);
    expect(albumTracks).toHaveBeenCalledWith(9);
    expect(playTracks).toHaveBeenCalledWith([{ itemId: 3 }, { itemId: 4 }], 1);
    await v.openItem(v.music().tracks[1]!);
    expect(navigate).toHaveBeenCalledWith(['/add/album', 'musicbrainz', 'rel'], { queryParams: { track: 'n' } });
  });

  it('opens a provider artist through the person it resolves, once, then straight for a known one', async () => {
    const { c, state, navigate, resolveArtist } = setup();
    state.query.set('x');
    const a = { provider: 'musicbrainz', externalId: 'x', name: 'N', sortName: null, personId: null } as ArtistHit;
    state.artistHits.set([a, { ...a, externalId: 'z', personId: 5 }]);
    const v = c as unknown as View & { music(): { artists: object[]; tracks: [] } };
    const artists = (c as unknown as { music(): { artists: object[] } }).music().artists;
    await v.openItem(artists[0]!);
    expect(resolveArtist).toHaveBeenCalledWith({ provider: 'musicbrainz', externalId: 'x' });
    expect(navigate).toHaveBeenCalledWith(['/artists', 77]);
    await v.openItem(artists[1]!);
    expect(resolveArtist).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenLastCalledWith(['/artists', 5]);
  });

  it('shows a first page of the books and albums of the providers, then all on Show more', () => {
    const { c } = setup();
    const view = c as unknown as { visible(r: number[], s: string): number[]; showMore(s: string): void };
    const rows = Array.from({ length: 30 }, (_, i) => i);
    expect(view.visible(rows, 'albums')).toHaveLength(12);
    view.showMore('albums');
    expect(view.visible(rows, 'albums')).toHaveLength(30);
    expect(view.visible(rows, 'books')).toHaveLength(12);
  });
});

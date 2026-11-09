import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddDialogComponent } from './add-dialog';
import type { AddRequest, AddResult } from './add-plan';
import { BooksApiService } from '../../../core/services/api/books-api.service';
import { LibrariesApiService, type LibrarySummary } from '../../../core/services/api/libraries-api.service';
import { MetadataService } from '../../../core/services/api/metadata.service';
import { MusicApiService } from '../../../core/services/api/music-api.service';
import { ProfilesService } from '../../../core/services/api/profiles.service';
import { RequestsService } from '../../../core/services/api/requests.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';

const lib = (id: number, types: string[], folders: number[] = [10], q: number | null = null): LibrarySummary =>
  ({
    id,
    name: `lib${id}`,
    icon: null,
    color: null,
    mediaTypes: types,
    defaultQualityProfileId: q,
    defaultLanguageProfileId: null,
    folders: folders.map((f) => ({ id: f, name: `f${f}` })),
  }) as unknown as LibrarySummary;

function setup(libraries: LibrarySummary[], perms: string[] = ['media.create']) {
  const calls: Record<string, unknown[]> = { import: [], request: [], book: [], album: [], want: [] };
  const toast = { success: vi.fn(), error: vi.fn() };
  const show = vi.fn();
  HTMLDialogElement.prototype.showModal = show;
  HTMLDialogElement.prototype.close = () => undefined;
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: LibrariesApiService, useValue: { listMine: async () => libraries } },
      {
        provide: ProfilesService,
        useValue: {
          getQualityProfiles: async (family = 'video') => [{ id: family === 'video' ? 7 : family === 'text' ? 8 : 9, name: family }],
          getLanguageProfiles: async () => [{ id: 3, name: 'L' }],
        },
      },
      {
        provide: MetadataService,
        useValue: {
          importMedia: async (b: unknown) => (calls['import']!.push(b), { id: 41, type: 'movie' }),
          getSeasonStubs: async () => [{ seasonNumber: 0, episodeCount: 1 }, { seasonNumber: 1, episodeCount: 8 }],
        },
      },
      { provide: BooksApiService, useValue: { import: async (b: unknown) => (calls['book']!.push(b), { id: 42 }) } },
      {
        provide: MusicApiService,
        useValue: {
          importAlbum: async (b: unknown) => (calls['album']!.push(b), { id: 43 }),
          wantRecording: async (b: unknown) => (calls['want']!.push(b), { mediaId: 44, itemId: 5 }),
        },
      },
      { provide: RequestsService, useValue: { create: async (b: unknown) => (calls['request']!.push(b), { mediaId: null }) } },
      { provide: AuthService, useValue: { hasPermission: (p: string) => perms.includes(p) } },
      { provide: ToastService, useValue: toast },
    ],
  });
  const fixture = TestBed.createComponent(AddDialogComponent);
  const done: AddResult[] = [];
  fixture.componentInstance.done.subscribe((r) => done.push(r));
  fixture.detectChanges();
  return { cmp: fixture.componentInstance, calls, done, show, toast };
}

const movie: AddRequest = { kind: 'movie', provider: 'tmdb', externalId: '603', title: 'T' };

describe('AddDialogComponent', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => TestBed.resetTestingModule());

  it('adds a movie straight away when one library takes it, with the library defaults', async () => {
    const { cmp, calls, done, show, toast } = setup([lib(1, ['movie'], [10, 11], 5)]);
    await cmp.add(movie);
    expect(show).not.toHaveBeenCalled();
    expect(calls['import']).toEqual([
      { type: 'movie', provider: 'tmdb', externalId: '603', qualityProfileId: 5, languageProfileId: 3, libraryId: 1, folderId: 10 },
    ]);
    expect(toast.success).toHaveBeenCalledOnce();
    expect(done).toEqual([{ mode: 'import', mediaId: 41 }]);
  });

  it('opens the dialog when several libraries take the kind, and preselects the one chosen last time', async () => {
    const libs = [lib(1, ['movie']), lib(2, ['movie']), lib(3, ['book'])];
    localStorage.setItem('fliks-add-library-movie', '2');
    const { cmp, calls, show } = setup(libs);
    await cmp.add(movie);
    expect(show).toHaveBeenCalledOnce();
    expect(calls['import']).toEqual([]);
    await (cmp as unknown as { submit(): Promise<void> }).submit();
    expect((calls['import']![0] as { libraryId: number }).libraryId).toBe(2);
    expect(localStorage.getItem('fliks-add-library-movie')).toBe('2');
  });

  it('keeps the remembered library as a preselection only', async () => {
    localStorage.setItem('fliks-add-library-movie', '9');
    const { cmp, calls } = setup([lib(1, ['movie']), lib(2, ['movie'])]);
    await cmp.add(movie);
    await (cmp as unknown as { submit(): Promise<void> }).submit();
    expect((calls['import']![0] as { libraryId: number }).libraryId).toBe(1);
  });

  it('always asks for a series, then monitors the ticked seasons without the specials', async () => {
    const { cmp, calls, show } = setup([lib(1, ['series'])]);
    await cmp.add({ ...movie, kind: 'series' });
    await new Promise((r) => setTimeout(r));
    expect(show).toHaveBeenCalledOnce();
    await (cmp as unknown as { submit(): Promise<void> }).submit();
    expect((calls['import']![0] as { monitoredSeasons: number[] }).monitoredSeasons).toEqual([1]);
  });

  it('asks the question when no library takes the kind and cannot submit', async () => {
    const { cmp, show } = setup([lib(1, ['book'])]);
    await cmp.add(movie);
    expect(show).toHaveBeenCalledOnce();
    expect((cmp as unknown as { canSubmit(): boolean }).canSubmit()).toBe(false);
  });

  it('requests, instead of adding, for a caller who cannot add', async () => {
    const { cmp, calls, done } = setup([lib(1, ['movie'])], ['requests.create']);
    await cmp.add(movie);
    expect(calls['import']).toEqual([]);
    expect(calls['request']).toEqual([
      { mediaType: 'movie', tmdbId: 603, title: 'T', qualityProfileId: 7, languageProfileId: 3, libraryId: 1 },
    ]);
    expect(done[0]!.mode).toBe('request');
  });

  it('adds a book with a text want on the first text profile', async () => {
    const { cmp, calls } = setup([lib(1, ['book'])]);
    await cmp.add({ kind: 'book', provider: 'openlibrary', externalId: 'OL1W', title: 'B' });
    expect(calls['book']).toEqual([
      { type: 'book', provider: 'openlibrary', externalId: 'OL1W', wants: [{ family: 'text', language: null, qualityProfileId: 8 }], libraryId: 1 },
    ]);
  });

  it('asks for a book when the page says it shows the editions', async () => {
    const { cmp, show } = setup([lib(1, ['book'])]);
    await cmp.add({ kind: 'book', provider: 'openlibrary', externalId: 'OL1W', title: 'B', alwaysAsk: true });
    expect(show).toHaveBeenCalledOnce();
  });

  it('adds an album, or wants one recording of it, through the music api', async () => {
    const { cmp, calls, done } = setup([lib(1, ['album'])]);
    await cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A' });
    await cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A', recording: { externalId: 'r1', albumExternalId: 'g1' } });
    expect(calls['album']).toEqual([{ provider: 'musicbrainz', externalId: 'g1', libraryId: 1 }]);
    expect(calls['want']).toEqual([{ provider: 'musicbrainz', externalId: 'r1', albumExternalId: 'g1', libraryId: 1 }]);
    expect(done.map((d) => d.mediaId)).toEqual([43, 44]);
  });

  it('requests an album with its audio want', async () => {
    const { cmp, calls } = setup([lib(1, ['album'])], ['requests.create']);
    await cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A' });
    expect(calls['request']).toEqual([
      { mediaType: 'album', externalId: 'g1', title: 'A', wants: [{ family: 'audio', language: null, qualityProfileId: 9 }], libraryId: 1 },
    ]);
  });
});

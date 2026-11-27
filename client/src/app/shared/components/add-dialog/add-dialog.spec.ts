import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddDialogComponent } from './add-dialog';
import type { AddRequest, AddResult } from './add-plan';
import { BooksApiService } from '../../../core/services/api/books-api.service';
import { MusicApiService } from '../../../core/services/api/music-api.service';
import { LibrariesApiService, type LibrarySummary } from '../../../core/services/api/libraries-api.service';
import { MetadataService } from '../../../core/services/api/metadata.service';
import { ProfilesService } from '../../../core/services/api/profiles.service';
import { RequestsService, type FliksRequestRow, type RequestAllowance } from '../../../core/services/api/requests.service';
import { PushService } from '../../../core/services/push.service';
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

type Opts = { allowance?: RequestAllowance | null; auto?: string[]; status?: string; seasons?: number[]; oldServer?: boolean };

function setup(libraries: LibrarySummary[], perms: string[] = ['media.create'], o: Opts = {}) {
  const calls: Record<string, unknown[]> = { request: [], import: [], book: [], album: [], want: [] };
  const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  const ask = vi.fn();
  const show = vi.fn();
  const reload = vi.fn(async () => undefined);
  const auto = new Set(o.auto ?? (perms.includes('media.create') ? ['movie', 'series', 'book', 'album'] : []));
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
          getSeasonStubs: async () => (o.seasons ?? [0, 1]).map((n) => ({ seasonNumber: n, episodeCount: 8 })),
          importMedia: async (b: unknown) => (calls['import']!.push(b), { id: 41 }),
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
      {
        provide: RequestsService,
        useValue: {
          autoKinds: signal(auto),
          addsByImport: signal(!!o.oldServer && perms.includes('media.create')),
          requestsFollowNewSeasons: signal(!o.oldServer),
          reloadAutoKinds: reload,
          allowance: async () => o.allowance ?? null,
          create: async (b: unknown) => (calls['request']!.push(b), { mediaId: 41, status: o.status ?? (auto.size ? 'approved' : 'pending'), absorbed: [] }),
        },
      },
      { provide: AuthService, useValue: { hasPermission: (p: string) => perms.includes(p) } },
      { provide: ToastService, useValue: toast },
      { provide: PushService, useValue: { askInContext: ask } },
    ],
  });
  const fixture = TestBed.createComponent(AddDialogComponent);
  const done: AddResult[] = [];
  fixture.componentInstance.done.subscribe((r) => done.push(r));
  fixture.detectChanges();
  return { cmp: fixture.componentInstance, fixture, calls, done, show, toast, ask, reload };
}

type Inner = {
  submit(): Promise<void>;
  followNewSeasons(): boolean;
  toggleSeason(n: number): void;
  toggleFollowNewSeasons(): void;
  allowance(): { blocked: boolean } | null;
  canSubmit(): boolean;
};
const inner = (c: AddDialogComponent) => c as unknown as Inner;

const movie: AddRequest = { kind: 'movie', provider: 'tmdb', externalId: '603', title: 'T' };

describe('AddDialogComponent', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => TestBed.resetTestingModule());

  it('adds a movie straight away through a request when one library takes it, with the library defaults', async () => {
    const { cmp, calls, done, show, toast, ask } = setup([lib(1, ['movie'], [10, 11], 5)]);
    await cmp.add(movie);
    expect(show).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(calls['request']).toEqual([
      { mediaType: 'movie', tmdbId: 603, title: 'T', qualityProfileId: 5, languageProfileId: 3, libraryId: 1, folderId: 10 },
    ]);
    expect(toast.success).toHaveBeenCalledWith('discover.request_approved');
    expect(done).toEqual([{ status: 'approved', mediaId: 41 }]);
  });

  it('opens the dialog when several libraries take the kind, and preselects the one chosen last time', async () => {
    const libs = [lib(1, ['movie']), lib(2, ['movie']), lib(3, ['book'])];
    localStorage.setItem('fliks-add-library-movie', '2');
    const { cmp, calls, show } = setup(libs);
    await cmp.add(movie);
    expect(show).toHaveBeenCalledOnce();
    expect(calls['request']).toEqual([]);
    await inner(cmp).submit();
    expect((calls['request']![0] as { libraryId: number }).libraryId).toBe(2);
    expect(localStorage.getItem('fliks-add-library-movie')).toBe('2');
  });

  it('shows the remaining requests and blocks the button at zero', async () => {
    const libs = [lib(1, ['movie']), lib(2, ['movie'])];
    const left = { movie: { limit: 5, used: 3, periodDays: 7, nextFreeAt: null } };
    const a = setup(libs, ['requests.create'], { allowance: left });
    await a.cmp.add(movie);
    expect(inner(a.cmp).allowance()?.blocked).toBe(false);
    expect(inner(a.cmp).canSubmit()).toBe(true);
    TestBed.resetTestingModule();
    const soon = new Date(Date.now() + 1.5 * 86_400_000).toISOString();
    const b = setup(libs, ['requests.create'], { allowance: { movie: { limit: 5, used: 5, periodDays: 7, nextFreeAt: soon } } });
    await b.cmp.add(movie);
    expect(inner(b.cmp).allowance()?.blocked).toBe(true);
    expect(inner(b.cmp).canSubmit()).toBe(false);
  });

  it('keeps the remembered library as a preselection only', async () => {
    localStorage.setItem('fliks-add-library-movie', '9');
    const { cmp, calls } = setup([lib(1, ['movie']), lib(2, ['movie'])]);
    await cmp.add(movie);
    await inner(cmp).submit();
    expect((calls['request']![0] as { libraryId: number }).libraryId).toBe(1);
  });

  it('always asks for a series, and every regular season ticked asks for the whole series', async () => {
    const { cmp, calls, show } = setup([lib(1, ['series'])]);
    await cmp.add({ ...movie, kind: 'series' });
    await new Promise((r) => setTimeout(r));
    expect(show).toHaveBeenCalledOnce();
    await inner(cmp).submit();
    const body = calls['request']![0] as { seasons?: number[]; monitorNewSeasons: boolean };
    expect(body.seasons).toBeUndefined();
    expect(body.monitorNewSeasons).toBe(true);
  });

  it('sends the picked seasons when not every regular one is ticked', async () => {
    const { cmp, calls } = setup([lib(1, ['series'])], ['media.create'], { seasons: [0, 1, 2] });
    await cmp.add({ ...movie, kind: 'series' });
    await new Promise((r) => setTimeout(r));
    inner(cmp).toggleSeason(2);
    await inner(cmp).submit();
    expect((calls['request']![0] as { seasons: number[] }).seasons).toEqual([1]);
  });

  it('presets follow-new-seasons on when the latest season is picked, off when it is unticked, and sends the choice', async () => {
    const { cmp, calls } = setup([lib(1, ['series'])]);
    await cmp.add({ ...movie, kind: 'series' });
    await new Promise((r) => setTimeout(r));
    const c = inner(cmp);
    expect(c.followNewSeasons()).toBe(true);
    c.toggleSeason(1);
    c.toggleSeason(0);
    expect(c.followNewSeasons()).toBe(false);
    c.toggleFollowNewSeasons();
    expect(c.followNewSeasons()).toBe(true);
    await c.submit();
    expect((calls['request']![0] as { monitorNewSeasons: boolean }).monitorNewSeasons).toBe(true);
  });

  it('sends follow-new-seasons on a member request too, but not for a series that follows them already', async () => {
    const a = setup([lib(1, ['series'])], ['requests.create']);
    await a.cmp.add({ ...movie, kind: 'series', preselectedSeasons: [1] });
    await new Promise((r) => setTimeout(r));
    await inner(a.cmp).submit();
    expect((a.calls['request']![0] as { monitorNewSeasons: boolean }).monitorNewSeasons).toBe(true);
    TestBed.resetTestingModule();
    const b = setup([lib(1, ['series'])], ['requests.create']);
    await b.cmp.add({ ...movie, kind: 'series', preselectedSeasons: [1], followsNewSeasons: true });
    await new Promise((r) => setTimeout(r));
    await inner(b.cmp).submit();
    expect(b.calls['request']![0]).not.toHaveProperty('monitorNewSeasons');
  });

  it('starts from the pending row it will approve, and asks even when one library takes the title', async () => {
    const pending = { id: 5, libraryId: 2, qualityProfileId: 11, languageProfileId: 12, seasons: null, monitorNewSeasons: false } as unknown as FliksRequestRow;
    const { cmp, calls, show } = setup([lib(1, ['movie']), lib(2, ['movie'])]);
    await cmp.add({ ...movie, pending, requesterCount: 2 });
    expect(show).toHaveBeenCalledOnce();
    await inner(cmp).submit();
    expect(calls['request']![0]).toMatchObject({ libraryId: 2, qualityProfileId: 11, languageProfileId: 12 });
  });

  it('asks the question when no library takes the kind and cannot submit', async () => {
    const { cmp, show } = setup([lib(1, ['book'])]);
    await cmp.add(movie);
    expect(show).toHaveBeenCalledOnce();
    expect(inner(cmp).canSubmit()).toBe(false);
  });

  it('requests for a caller whose create waits for approval, without profiles', async () => {
    const { cmp, calls, done, ask, toast } = setup([lib(1, ['movie'])], ['requests.create']);
    await cmp.add(movie);
    expect(ask).toHaveBeenCalledWith('request');
    expect(calls['request']).toEqual([{ mediaType: 'movie', tmdbId: 603, title: 'T', libraryId: 1 }]);
    expect(toast.success).toHaveBeenCalledWith('discover.request_success');
    expect(done[0]!.status).toBe('pending');
  });

  it('says an add ended pending and reloads which kinds are approved at once', async () => {
    const { cmp, toast, reload } = setup([lib(1, ['movie'])], ['media.create'], { status: 'pending' });
    await cmp.add(movie);
    expect(toast.info).toHaveBeenCalledWith('discover.request_sent_for_approval');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('shows a member no folder or profile picker, and a manager the folder picker', async () => {
    const libs = [lib(1, ['movie']), lib(2, ['movie'])];
    const member = setup(libs, ['requests.create']);
    await member.cmp.add(movie);
    member.fixture.detectChanges();
    const el = member.fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('select')).toHaveLength(1);
    expect(el.querySelector('app-library-folder-select')).toBeNull();
    TestBed.resetTestingModule();
    const manager = setup(libs, ['requests.create', 'requests.manage']);
    await manager.cmp.add(movie);
    manager.fixture.detectChanges();
    expect((manager.fixture.nativeElement as HTMLElement).querySelector('app-library-folder-select')).not.toBeNull();
  });

  it('adds a book with a text want on the first text profile', async () => {
    const { cmp, calls } = setup([lib(1, ['book'])]);
    await cmp.add({ kind: 'book', provider: 'openlibrary', externalId: 'OL1W', title: 'B' });
    expect(calls['request']).toEqual([
      { mediaType: 'book', externalId: 'OL1W', title: 'B', wants: [{ family: 'text', language: null, qualityProfileId: 8 }], libraryId: 1 },
    ]);
  });

  it('asks for a book when the page says it shows the editions', async () => {
    const { cmp, show } = setup([lib(1, ['book'])]);
    await cmp.add({ kind: 'book', provider: 'openlibrary', externalId: 'OL1W', title: 'B', alwaysAsk: true });
    expect(show).toHaveBeenCalledOnce();
  });

  it('adds an album without a question when one audio library takes it', async () => {
    const { cmp, calls, show, done } = setup([lib(1, ['album'])]);
    await cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A' });
    expect(show).not.toHaveBeenCalled();
    expect(calls['request']).toEqual([
      { mediaType: 'album', externalId: 'g1', title: 'A', wants: [{ family: 'audio', language: null, qualityProfileId: 9 }], libraryId: 1 },
    ]);
    expect(done.map((d) => d.mediaId)).toEqual([41]);
  });

  it('asks for an album only with several libraries and none remembered', async () => {
    const libs = [lib(1, ['album']), lib(2, ['album'])];
    const first = setup(libs);
    await first.cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A' });
    expect(first.show).toHaveBeenCalledOnce();
    TestBed.resetTestingModule();
    localStorage.setItem('fliks-add-library-album', '2');
    const second = setup(libs);
    await second.cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A' });
    expect(second.show).not.toHaveBeenCalled();
    expect((second.calls['request']![0] as { libraryId: number }).libraryId).toBe(2);
  });

  it('asks for one track of an album as an album request with that recording', async () => {
    const { cmp, calls, done } = setup([lib(1, ['album'])], ['requests.create']);
    await cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A', recording: { externalId: 'r1', albumExternalId: 'g1' } });
    expect(calls['request']).toEqual([
      { mediaType: 'album', externalId: 'g1', title: 'A', wants: [{ family: 'audio', language: null, qualityProfileId: 9 }], recordings: ['r1'], libraryId: 1 },
    ]);
    expect(done[0]!.recordings).toEqual(['r1']);
  });

  it('starts each add from the defaults of its own kind', async () => {
    const { cmp, calls } = setup([lib(1, ['book', 'album'])]);
    await cmp.add({ kind: 'book', provider: 'p', externalId: 'b1', title: 'B' });
    await cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A' });
    expect((calls['request']![1] as { wants: unknown[] }).wants).toEqual([{ family: 'audio', language: null, qualityProfileId: 9 }]);
  });

  it('imports directly for an adder on a server older than auto-approval', async () => {
    const { cmp, calls, done, toast } = setup([lib(1, ['movie', 'book', 'album'], [10], 5)], ['media.create'], { oldServer: true });
    await cmp.add(movie);
    await cmp.add({ kind: 'book', provider: 'p', externalId: 'b1', title: 'B' });
    await cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A' });
    await cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A', recording: { externalId: 'r1', albumExternalId: 'g1' } });
    expect(calls['request']).toEqual([]);
    expect(calls['import']).toEqual([{ type: 'movie', provider: 'tmdb', externalId: '603', qualityProfileId: 5, languageProfileId: 3, libraryId: 1 }]);
    expect(calls['book']).toHaveLength(1);
    expect(calls['album']).toHaveLength(1);
    expect(calls['want']).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith('discover.import_success');
    expect(done[0]).toEqual({ status: 'approved', mediaId: 41 });
  });

  it('requests without follow-new-seasons on a server older than auto-approval', async () => {
    const { cmp, calls } = setup([lib(1, ['series'])], ['requests.create'], { oldServer: true });
    await cmp.add({ ...movie, kind: 'series', preselectedSeasons: [1] });
    await new Promise((r) => setTimeout(r));
    await inner(cmp).submit();
    expect(calls['request']![0]).not.toHaveProperty('monitorNewSeasons');
  });

  it('ignores an add while another one loads', async () => {
    const { cmp, calls } = setup([lib(1, ['album'])]);
    const first = cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g1', title: 'A' });
    expect(cmp.idle).toBe(false);
    await cmp.add({ kind: 'album', provider: 'musicbrainz', externalId: 'g2', title: 'B' });
    await first;
    expect(calls['request']).toHaveLength(1);
    expect(cmp.idle).toBe(true);
  });
});

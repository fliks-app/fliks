import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchRunner } from './search-runner';
import { SearchStateService } from '../../core/services/search-state.service';
import type { SearchHit } from '../../core/services/api/metadata.service';

const hit = (id: string, extra: Partial<SearchHit> = {}): SearchHit =>
  ({ provider: 'tmdb', externalId: id, mediaType: 'movie', title: id, year: null, posterUrl: null, existingMediaId: null, ...extra }) as SearchHit;

/** A promise settled by the test, which also learns the signal it was asked with. */
function deferred<T>(signal?: AbortSignal) {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject, signal };
}

function setup() {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const state = TestBed.inject(SearchStateService);
  const asked: Record<string, ReturnType<typeof deferred<any>>[]> = {};
  const ask = <T>(name: string, signal?: AbortSignal) => {
    const d = deferred<T>(signal);
    (asked[name] ??= []).push(d);
    return d.promise;
  };
  const getAll = vi.fn((p: unknown, o: unknown, s?: AbortSignal) => ask<{ data: unknown[] }>('media', s));
  const runner = new SearchRunner({
    state,
    media: { getAll } as never,
    metadata: {
      search: (k: string, _q: string, _o: unknown, s?: AbortSignal) => ask(k, s),
      searchArtists: (_q: string, _o: unknown, s?: AbortSignal) => ask('artist', s),
      searchRecordings: (_q: string, _o: unknown, s?: AbortSignal) => ask('recording', s),
    } as never,
    music: { tracks: (_q: unknown, s?: AbortSignal) => ask('tracks', s), people: (_r: string, _q: unknown, s?: AbortSignal) => ask('artists', s) } as never,
    books: { persons: (_q: unknown, s?: AbortSignal) => ask('authors', s), collections: (_q: unknown, s?: AbortSignal) => ask('series', s) } as never,
  });
  return { state, runner, asked, getAll };
}

describe('SearchRunner', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('starts the library and the provider calls of the All chip together', () => {
    const { runner, asked } = setup();
    runner.run('matrix', 'all', { external: true, mediaParams: {} });
    expect(Object.keys(asked).sort()).toEqual(['album', 'artist', 'artists', 'book', 'media', 'movie', 'recording', 'series', 'tracks']);
  });

  it('lets each section land on its own while the others are pending', async () => {
    const { runner, asked, state } = setup();
    runner.run('matrix', 'all', { external: true, mediaParams: {} });
    asked['movie']![0]!.resolve([hit('1')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.movieHits()).toHaveLength(1);
    expect(state.pending().has('movie')).toBe(false);
    expect(state.pending().has('book')).toBe(true);
    expect(state.localLoading()).toBe(true);
  });

  it('cancels the calls of the query before and drops what they answer late', async () => {
    const { runner, asked, state } = setup();
    runner.run('ma', 'movie', { external: true, mediaParams: {} });
    const first = asked['movie']![0]!;
    runner.run('mat', 'movie', { external: true, mediaParams: {} });
    expect(first.signal!.aborted).toBe(true);
    expect(asked['movie']![1]!.signal!.aborted).toBe(false);
    first.resolve([hit('old')]);
    asked['movie']![1]!.resolve([hit('new')]);
    await new Promise((r) => setTimeout(r));
    expect(state.movieHits().map((h) => h.externalId)).toEqual(['new']);
  });

  it('asks the providers from two characters and never when external search is off', () => {
    const one = setup();
    one.runner.run('a', 'all', { external: true, mediaParams: {} });
    expect(Object.keys(one.asked).sort()).toEqual(['artists', 'media', 'tracks']);
    TestBed.resetTestingModule();
    const off = setup();
    off.runner.run('matrix', 'movie', { external: false, mediaParams: {} });
    expect(Object.keys(off.asked)).toEqual(['media']);
  });

  it('asks the library once, from the network, with the filters', () => {
    const { runner, getAll } = setup();
    runner.run('matrix', 'movie', { external: false, mediaParams: { type: 'movie', yearMin: 1999 } });
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll.mock.calls[0]!.slice(0, 2)).toEqual([{ type: 'movie', yearMin: 1999, q: 'matrix', limit: 20 }, { force: true }]);
  });

  it('marks a failed source and keeps the others', async () => {
    const { runner, asked, state } = setup();
    runner.run('matrix', 'book', { external: true, mediaParams: {} });
    asked['book']![0]!.reject(new Error('503'));
    asked['authors']![0]!.resolve([{ id: 1 }]);
    await new Promise((r) => setTimeout(r));
    expect(state.failed().has('book')).toBe(true);
    expect(state.externalFailed()).toBe(true);
    expect(state.localAuthors()).toEqual([{ id: 1 }]);
    expect(state.pending().has('book')).toBe(false);
  });

  it('empties the sources the new chip does not ask', async () => {
    const { runner, asked, state } = setup();
    runner.run('matrix', 'all', { external: true, mediaParams: {} });
    asked['book']![0]!.resolve([hit('b', { mediaType: 'book' })]);
    await new Promise((r) => setTimeout(r));
    expect(state.bookHits()).toHaveLength(1);
    runner.run('matrix', 'movie', { external: true, mediaParams: {} });
    expect(state.bookHits()).toEqual([]);
  });

  it('re-runs the library alone after a filter change', async () => {
    const { runner, asked } = setup();
    runner.run('matrix', 'movie', { external: true, mediaParams: {} });
    const movie = asked['movie']![0]!;
    runner.runMedia('matrix', { yearMin: 2000 });
    expect(asked['media']).toHaveLength(2);
    expect(asked['media']![0]!.signal!.aborted).toBe(true);
    expect(movie.signal!.aborted).toBe(false);
  });
});

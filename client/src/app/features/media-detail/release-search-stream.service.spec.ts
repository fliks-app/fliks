import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ReleaseSearchStreamService, type IndexerRosterEntry } from './release-search-stream.service';
import { SseService } from '../../core/services/sse.service';
import type { MovieRelease } from './media-detail-release-picker.service';

const PLUGIN_ID = 'acme.acquire';

function release(title: string, score: Partial<Pick<MovieRelease, 'rank' | 'customFormatScore'>> = {}): MovieRelease {
  return { title, downloadUrl: `magnet:${title}`, sourceId: 1, sourceName: 'ix', ...score } as MovieRelease;
}

function setup() {
  const lastEvent = signal<Record<string, unknown> | null>(null);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SseService, useValue: { lastEvent } },
    ],
  });
  const service = TestBed.inject(ReleaseSearchStreamService);
  const releases = signal<MovieRelease[]>([]);
  const indexers = signal<IndexerRosterEntry[]>([]);
  /** Delivers one event and lets the effect that reads it run. */
  const deliver = async (type: string, payload: unknown) => {
    lastEvent.set({ type, payload });
    TestBed.tick();
    await Promise.resolve();
  };
  return { service, releases, indexers, deliver };
}

/** Runs a search whose HTTP answer resolves only when the test says so. */
function deferredFetch() {
  let resolve!: (rows: MovieRelease[]) => void;
  const answered = new Promise<MovieRelease[]>((r) => (resolve = r));
  let seenSearchId: string | undefined;
  return {
    fetch: (searchId: string) => {
      seenSearchId = searchId;
      return answered;
    },
    finish: (rows: MovieRelease[]) => resolve(rows),
    searchId: () => seenSearchId!,
  };
}

const acme = (fetch: (searchId: string) => Promise<MovieRelease[]>) => ({ pluginId: PLUGIN_ID, name: 'Acme', fetch });

describe('ReleaseSearchStreamService', () => {
  it('mints a search id and hands it to the request, so the server knows who to push to', async () => {
    const { service, releases, indexers } = setup();
    const f = deferredFetch();
    const run = service.run([acme(f.fetch)], { releases, indexers });
    expect(f.searchId()).toBeTruthy();
    f.finish([]);
    await run;
  });

  it('applies a partial: the roster and the whole re-ranked list both land', async () => {
    const { service, releases, indexers, deliver } = setup();
    const f = deferredFetch();
    const run = service.run([acme(f.fetch)], { releases, indexers });

    await deliver(`plugin.${PLUGIN_ID}.search.partial`, {
      searchId: f.searchId(),
      indexers: [{ id: 1, name: 'alpha', state: 'done' }],
      releases: [release('a'), release('b')],
    });

    expect(indexers().map((i) => i.name)).toEqual(['alpha']);
    expect(releases().map((r) => r.title)).toEqual(['a', 'b']);
    f.finish([]);
    await run;
  });

  it('a roster-only event updates the tabs and leaves the list alone', async () => {
    const { service, releases, indexers, deliver } = setup();
    const f = deferredFetch();
    const run = service.run([acme(f.fetch)], { releases, indexers });
    releases.set([release('a')]);

    await deliver(`plugin.${PLUGIN_ID}.search.state`, {
      searchId: f.searchId(),
      indexers: [{ id: 1, name: 'alpha', state: 'pending' }],
    });

    expect(indexers()[0]?.state).toBe('pending');
    // A state event must not blank the list the viewer is already reading.
    expect(releases().map((r) => r.title)).toEqual(['a']);
    f.finish([]);
    await run;
  });

  it('VERDICT: another search on the same account is ignored — two open modals must not cross', async () => {
    const { service, releases, indexers, deliver } = setup();
    const f = deferredFetch();
    const run = service.run([acme(f.fetch)], { releases, indexers });

    await deliver(`plugin.${PLUGIN_ID}.search.partial`, {
      searchId: 'someone-elses-search',
      indexers: [{ id: 9, name: 'wrong', state: 'done' }],
      releases: [release('wrong')],
    });

    expect(releases()).toEqual([]);
    expect(indexers()).toEqual([]);
    f.finish([]);
    await run;
  });

  it('VERDICT: events stop being applied once the search has answered', async () => {
    const { service, releases, indexers, deliver } = setup();
    const f = deferredFetch();
    const run = service.run([acme(f.fetch)], { releases, indexers });
    f.finish([release('final')]);
    await run;

    await deliver(`plugin.${PLUGIN_ID}.search.partial`, {
      searchId: f.searchId(),
      releases: [release('late')],
    });

    // A late partial must not overwrite the answer this search already returned.
    expect(releases()).toEqual([]);
  });

  it('VERDICT: an indexer left pending when the answer lands stops spinning', async () => {
    const { service, releases, indexers, deliver } = setup();
    const f = deferredFetch();
    const run = service.run([acme(f.fetch)], { releases, indexers });

    await deliver(`plugin.${PLUGIN_ID}.search.state`, {
      searchId: f.searchId(),
      indexers: [
        { id: 1, name: 'alpha', state: 'done' },
        { id: 2, name: 'beta', state: 'pending' },
        { id: 3, name: 'gamma', state: 'failed' },
      ],
    });
    f.finish([]);
    await run;

    expect(indexers().map((i) => i.state)).toEqual(['done', 'done', 'failed']);
  });

  it('ignores another plugin’s events entirely', async () => {
    const { service, releases, indexers, deliver } = setup();
    const f = deferredFetch();
    const run = service.run([acme(f.fetch)], { releases, indexers });

    await deliver('plugin.other.plugin.search.partial', {
      searchId: f.searchId(),
      releases: [release('x')],
    });

    expect(releases()).toEqual([]);
    f.finish([]);
    await run;
  });

  it('VERDICT: an older overlapping search no longer writes into the shared sinks', async () => {
    const { service, releases, indexers, deliver } = setup();
    const first = deferredFetch();
    const second = deferredFetch();
    const run1 = service.run([acme(first.fetch)], { releases, indexers });
    const run2 = service.run([acme(second.fetch)], { releases, indexers });

    await deliver(`plugin.${PLUGIN_ID}.search.partial`, {
      searchId: first.searchId(),
      releases: [release('old')],
    });
    expect(releases()).toEqual([]);

    await deliver(`plugin.${PLUGIN_ID}.search.state`, {
      searchId: second.searchId(),
      indexers: [{ id: 1, name: 'alpha', state: 'pending' }],
    });
    first.finish([]);
    await run1;
    expect(indexers()[0]?.state).toBe('pending');

    second.finish([]);
    await run2;
    expect(indexers()[0]?.state).toBe('done');
  });

  it('merges the rosters and releases of two providers, stamping each release with its provider', async () => {
    const { service, releases, indexers, deliver } = setup();
    const a = deferredFetch();
    const b = deferredFetch();
    const run = service.run(
      [acme(a.fetch), { pluginId: 'acme.other', name: 'Other', fetch: b.fetch }],
      { releases, indexers },
    );

    await deliver('plugin.acme.other.search.partial', {
      searchId: b.searchId(),
      indexers: [{ id: 1, name: 'acct', state: 'done' }],
      releases: [release('b1')],
    });
    await deliver(`plugin.${PLUGIN_ID}.search.partial`, {
      searchId: a.searchId(),
      indexers: [{ id: 1, name: 'alpha', state: 'pending' }],
      releases: [release('a1')],
    });

    expect(indexers().map((i) => [i.pluginId, i.name])).toEqual([[PLUGIN_ID, 'alpha'], ['acme.other', 'acct']]);
    expect(releases().map((r) => [r.pluginId, r.title])).toEqual([[PLUGIN_ID, 'a1'], ['acme.other', 'b1']]);
    a.finish([release('a1')]);
    b.finish([release('b1')]);
    expect((await run).map((r) => r.pluginId)).toEqual([PLUGIN_ID, 'acme.other']);
    expect(indexers().map((i) => i.state)).toEqual(['done', 'done']);
  });

  it('orders the merged list by rank then custom-format score, a tie keeping provider order', async () => {
    const { service, releases, indexers, deliver } = setup();
    const a = deferredFetch();
    const b = deferredFetch();
    const fromA = [release('a-low', { rank: 1 }), release('a-tie', { rank: 5, customFormatScore: 10 }), release('a-top', { rank: 5, customFormatScore: 50 })];
    const fromB = [release('b-tie', { rank: 5, customFormatScore: 10 }), release('b-best', { rank: 9 })];
    const run = service.run([acme(a.fetch), { pluginId: 'acme.other', name: 'Other', fetch: b.fetch }], { releases, indexers });
    const expected = ['b-best', 'a-top', 'a-tie', 'b-tie', 'a-low'];

    await deliver(`plugin.${PLUGIN_ID}.search.partial`, { searchId: a.searchId(), releases: fromA });
    await deliver('plugin.acme.other.search.partial', { searchId: b.searchId(), releases: fromB });
    expect(releases().map((r) => r.title)).toEqual(expected);

    a.finish(fromA);
    b.finish(fromB);
    expect((await run).map((r) => r.title)).toEqual(expected);
  });

  it('answers with the providers that succeeded when one fails, and throws only when all do', async () => {
    const { service, releases, indexers } = setup();
    const ok = deferredFetch();
    const run = service.run(
      [acme(ok.fetch), { pluginId: 'acme.other', name: 'Other', fetch: () => Promise.reject(new Error('down')) }],
      { releases, indexers },
    );
    ok.finish([release('a')]);
    expect((await run).map((r) => r.title)).toEqual(['a']);

    const failing = (pluginId: string) => ({ pluginId, name: pluginId, fetch: () => Promise.reject(new Error('down')) });
    await expect(service.run([failing('x'), failing('y')], { releases, indexers })).rejects.toThrow('down');
  });
});

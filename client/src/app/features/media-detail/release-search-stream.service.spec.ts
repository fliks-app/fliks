import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ReleaseSearchStreamService, type IndexerRosterEntry } from './release-search-stream.service';
import { SseService } from '../../core/services/sse.service';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { MovieRelease } from './media-detail-release-picker.service';

const PLUGIN_ID = 'acme.acquire';

function release(title: string): MovieRelease {
  return { title, downloadUrl: `magnet:${title}`, sourceId: 1, sourceName: 'ix' } as MovieRelease;
}

function setup(pluginId: string | null = PLUGIN_ID) {
  const lastEvent = signal<Record<string, unknown> | null>(null);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SseService, useValue: { lastEvent } },
      {
        provide: PluginUiRegistryService,
        useValue: { releasePicker: () => (pluginId ? { pluginId, routes: {} } : null) },
      },
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

describe('ReleaseSearchStreamService', () => {
  it('mints a search id and hands it to the request, so the server knows who to push to', async () => {
    const { service, releases, indexers } = setup();
    const f = deferredFetch();
    const run = service.run(f.fetch, { releases, indexers });
    expect(f.searchId()).toBeTruthy();
    f.finish([]);
    await run;
  });

  it('applies a partial: the roster and the whole re-ranked list both land', async () => {
    const { service, releases, indexers, deliver } = setup();
    const f = deferredFetch();
    const run = service.run(f.fetch, { releases, indexers });

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
    const run = service.run(f.fetch, { releases, indexers });
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
    const run = service.run(f.fetch, { releases, indexers });

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
    const run = service.run(f.fetch, { releases, indexers });
    f.finish([release('final')]);
    await run;

    await deliver(`plugin.${PLUGIN_ID}.search.partial`, {
      searchId: f.searchId(),
      releases: [release('late')],
    });

    // A late partial must not overwrite the answer this search already returned.
    expect(releases()).toEqual([]);
  });

  it('ignores another plugin’s events entirely', async () => {
    const { service, releases, indexers, deliver } = setup();
    const f = deferredFetch();
    const run = service.run(f.fetch, { releases, indexers });

    await deliver('plugin.other.plugin.search.partial', {
      searchId: f.searchId(),
      releases: [release('x')],
    });

    expect(releases()).toEqual([]);
    f.finish([]);
    await run;
  });

  it('still returns the answer when no plugin contributes a release picker', async () => {
    const { service, releases, indexers } = setup(null);
    const f = deferredFetch();
    const run = service.run(f.fetch, { releases, indexers });
    f.finish([release('a')]);
    expect((await run).map((r) => r.title)).toEqual(['a']);
  });
});

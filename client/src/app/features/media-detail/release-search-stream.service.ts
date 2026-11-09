import { Injectable, Injector, WritableSignal, effect, inject, untracked } from '@angular/core';
import { SseService } from '../../core/services/sse.service';
import { MovieRelease } from './media-detail-release-picker.service';

export type IndexerSearchState = 'pending' | 'done' | 'skipped' | 'failed';

export interface IndexerRosterEntry {
  id: number | string;
  name: string;
  state: IndexerSearchState;
  /** Stamped by the stream: the provider the source belongs to. */
  pluginId?: string;
  pluginName?: string;
}

export interface ReleaseSearchSinks {
  releases: WritableSignal<MovieRelease[]>;
  indexers: WritableSignal<IndexerRosterEntry[]>;
}

/** One provider's share of a search; `fetch` is its HTTP search, answering with its releases. */
export interface ProviderSearch {
  pluginId: string;
  name: string;
  fetch: (searchId: string) => Promise<MovieRelease[]>;
}

/** Tab key of a source: sources of two providers may share an id. */
export function sourceKey(pluginId: string | undefined, sourceId: number | string): string {
  return `${pluginId ?? ''}:${sourceId}`;
}

/** Correlation token, not a credential (the server scopes delivery to the account); no `crypto.randomUUID`, absent on plain-HTTP LAN origins. */
function searchToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Run extends ProviderSearch {
  searchId: string;
  releases: MovieRelease[];
  roster: IndexerRosterEntry[];
}

/** Runs one release search over every given provider, merging the partial results each pushes while its sources answer (in provider order).
 *  Each `search.partial` is the complete re-ranked list of its provider, so a skipped intermediate event loses nothing; the HTTP answer stays authoritative. */
@Injectable({ providedIn: 'root' })
export class ReleaseSearchStreamService {
  private readonly sse = inject(SseService);
  private readonly injector = inject(Injector);
  /** Latest search per sinks: an older run still in flight must not write into them. */
  private readonly latest = new WeakMap<object, string>();

  async run(searches: ProviderSearch[], sinks: ReleaseSearchSinks): Promise<MovieRelease[]> {
    const token = searchToken();
    this.latest.set(sinks.releases, token);
    const runs: Run[] = searches.map((s) => ({ ...s, searchId: searchToken(), releases: [], roster: [] }));
    const live = () => this.latest.get(sinks.releases) === token;
    const publishReleases = () => sinks.releases.set(runs.flatMap((r) => r.releases));
    const publishRoster = () => sinks.indexers.set(runs.flatMap((r) => r.roster));
    const stop = this.listen(runs, live, publishRoster, publishReleases);
    try {
      const answers = await Promise.allSettled(
        runs.map(async (r) => {
          r.releases = stamp(r.pluginId, await r.fetch(r.searchId));
          return r.releases;
        }),
      );
      const failed = answers.find((a): a is PromiseRejectedResult => a.status === 'rejected');
      if (failed && answers.every((a) => a.status === 'rejected')) throw failed.reason;
      return runs.flatMap((r) => r.releases);
    } finally {
      stop();
      // The answer ends the search: a source still pending never got its completion event, and its tab would spin forever.
      if (live()) {
        for (const r of runs) r.roster = r.roster.map((ix) => (ix.state === 'pending' ? { ...ix, state: 'done' } : ix));
        untracked(publishRoster);
      }
    }
  }

  private listen(runs: Run[], live: () => boolean, publishRoster: () => void, publishReleases: () => void): () => void {
    const ref = effect(
      () => {
        const event = this.sse.lastEvent();
        if (!event) return;
        const run = runs.find((r) => event.type.startsWith(`plugin.${r.pluginId}.search.`));
        if (!run) return;
        const payload = event['payload'] as
          | { searchId?: string; indexers?: IndexerRosterEntry[]; releases?: MovieRelease[] }
          | undefined;
        if (!payload || payload.searchId !== run.searchId || !live()) return;
        untracked(() => {
          if (payload.indexers) {
            run.roster = payload.indexers.map((ix) => ({ ...ix, pluginId: run.pluginId, pluginName: run.name }));
            publishRoster();
          }
          if (payload.releases) {
            run.releases = stamp(run.pluginId, payload.releases);
            publishReleases();
          }
        });
      },
      { injector: this.injector },
    );
    return () => ref.destroy();
  }
}

function stamp(pluginId: string, releases: MovieRelease[]): MovieRelease[] {
  return releases.map((r) => ({ ...r, pluginId }));
}

import { Injectable, Injector, WritableSignal, effect, inject, untracked } from '@angular/core';
import { SseService } from '../../core/services/sse.service';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import { MovieRelease } from './media-detail-release-picker.service';

export type IndexerSearchState = 'pending' | 'done' | 'skipped' | 'failed';

export interface IndexerRosterEntry {
  id: number;
  name: string;
  state: IndexerSearchState;
}

export interface ReleaseSearchSinks {
  releases: WritableSignal<MovieRelease[]>;
  indexers: WritableSignal<IndexerRosterEntry[]>;
}

/** Correlation token, not a credential — the server scopes delivery to the account. Built
 *  without `crypto.randomUUID`, which is unavailable on the plain-HTTP LAN origins a
 *  self-hosted install is routinely reached on. */
function searchToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Runs one release search and applies the partial results the plugin pushes while its
 * indexers answer.
 *
 * Each `search.partial` carries the complete list re-ranked by the server, so a coalesced
 * signal update that skips an intermediate event loses nothing: the newest emission is
 * always the most complete one. The HTTP answer remains the authority, and with no event
 * stream at all this degrades to exactly the previous behaviour — one list, at the end.
 */
@Injectable({ providedIn: 'root' })
export class ReleaseSearchStreamService {
  private readonly sse = inject(SseService);
  private readonly registry = inject(PluginUiRegistryService);
  private readonly injector = inject(Injector);

  async run(
    fetch: (searchId: string) => Promise<MovieRelease[]>,
    sinks: ReleaseSearchSinks,
  ): Promise<MovieRelease[]> {
    const searchId = searchToken();
    const stop = this.listen(searchId, sinks);
    try {
      return await fetch(searchId);
    } finally {
      stop();
      // The answer ends the search: an indexer still pending never got its completion
      // event, and its tab would spin forever.
      sinks.indexers.update((roster) =>
        roster.map((ix) => (ix.state === 'pending' ? { ...ix, state: 'done' } : ix)),
      );
    }
  }

  /** The plugin id comes from whichever plugin contributes the release picker, so no
   *  plugin identity is spelled out here. */
  private listen(searchId: string, sinks: ReleaseSearchSinks): () => void {
    const pluginId = this.registry.releasePicker()?.pluginId;
    if (!pluginId) return () => undefined;
    const prefix = `plugin.${pluginId}.search.`;

    const ref = effect(
      () => {
        const event = this.sse.lastEvent();
        if (!event?.type.startsWith(prefix)) return;
        const payload = event['payload'] as
          | { searchId?: string; indexers?: IndexerRosterEntry[]; releases?: MovieRelease[] }
          | undefined;
        if (!payload || payload.searchId !== searchId) return;
        untracked(() => {
          if (payload.indexers) sinks.indexers.set(payload.indexers);
          if (payload.releases) sinks.releases.set(payload.releases);
        });
      },
      { injector: this.injector },
    );

    return () => ref.destroy();
  }
}

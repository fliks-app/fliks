import { Injectable, signal, computed, effect } from '@angular/core';
import { Media } from './api/media.service';
import { MetadataSearchResult } from './api/metadata.service';

const EXTERNAL_KEY = 'fliks-search-external';

@Injectable({ providedIn: 'root' })
export class SearchStateService {
  readonly query = signal('');
  readonly filter = signal<'all' | 'movie' | 'series'>('all');
  readonly externalEnabled = signal(localStorage.getItem(EXTERNAL_KEY) !== 'false');

  private readonly persistExternal = effect(() => {
    localStorage.setItem(EXTERNAL_KEY, String(this.externalEnabled()));
  });
  readonly localResults = signal<Media[]>([]);
  readonly localLoading = signal(false);
  readonly externalResults = signal<MetadataSearchResult[]>([]);
  readonly externalLoading = signal(false);
  readonly hasQuery = computed(() => this.query().trim().length > 0);

  /** External results filtered to exclude items already in local results */
  readonly filteredExternalResults = computed(() => {
    const localTmdbIds = new Set(this.localResults().map(m => m.tmdbId));
    return this.externalResults().filter(r => !localTmdbIds.has(r.tmdbId));
  });

  clear() {
    this.query.set('');
    this.localResults.set([]);
    this.externalResults.set([]);
    this.localLoading.set(false);
    this.externalLoading.set(false);
  }
}

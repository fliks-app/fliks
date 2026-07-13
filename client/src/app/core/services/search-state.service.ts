import { Injectable, signal, computed, effect } from '@angular/core';
import { Media } from './api/media.service';
import { MetadataSearchResult } from './api/metadata.service';
import { SocialUser } from './api/social-api.service';

const EXTERNAL_KEY = 'fliks-search-external';

@Injectable({ providedIn: 'root' })
export class SearchStateService {
  readonly query = signal('');
  readonly filter = signal<'all' | 'movie' | 'series' | 'people'>('all');
  readonly externalEnabled = signal(localStorage.getItem(EXTERNAL_KEY) !== 'false');

  private readonly persistExternal = effect(() => {
    localStorage.setItem(EXTERNAL_KEY, String(this.externalEnabled()));
  });
  readonly localResults = signal<Media[]>([]);
  readonly localLoading = signal(false);
  readonly externalResults = signal<MetadataSearchResult[]>([]);
  readonly externalLoading = signal(false);
  readonly peopleResults = signal<SocialUser[]>([]);
  readonly peopleLoading = signal(false);
  readonly hasQuery = computed(() => this.query().trim().length > 0);
  /** Counter incremented whenever a caller (e.g. the bottom-dock
   *  search button) asks the search page to refocus its input.
   *  Search page watches this in an effect — using a counter (not a
   *  boolean) so back-to-back requests both fire. */
  readonly focusRequestId = signal(0);

  requestFocus(): void {
    this.focusRequestId.update((n) => n + 1);
  }

  /** External results filtered to exclude items already in local results */
  readonly filteredExternalResults = computed(() => {
    const localTmdbIds = new Set(this.localResults().map(m => m.tmdbId));
    return this.externalResults().filter(r => !localTmdbIds.has(r.tmdbId));
  });

  clear() {
    this.query.set('');
    this.localResults.set([]);
    this.externalResults.set([]);
    this.peopleResults.set([]);
    this.localLoading.set(false);
    this.externalLoading.set(false);
    this.peopleLoading.set(false);
  }
}

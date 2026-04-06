import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnDestroy,
  AfterViewInit,
  ElementRef,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService } from '../../core/services/api/media.service';
import {
  MetadataService,
  MetadataSearchResult,
} from '../../core/services/api/metadata.service';
import { AuthService } from '../../core/services/auth.service';
import { RequestsService, FliksRequestStatus } from '../../core/services/api/requests.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { MediaType } from '../../core/enums/media-type.enum';
import { MediaCardComponent } from '../../shared/components/media-card';
import { DiscoverCardComponent, CardStatus } from '../../shared/components/discover-card/discover-card.component';
import { LucideSearch, LucideX, LucideSettings } from '@lucide/angular';

@Component({
  selector: 'app-search',
  imports: [FormsModule, TranslateModule, MediaCardComponent, DiscoverCardComponent, LucideSearch, LucideX, LucideSettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './search.html',
})
export class SearchComponent implements AfterViewInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly metadata = inject(MetadataService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly requestsApi = inject(RequestsService);
  readonly state = inject(SearchStateService);

  readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  readonly requestedTmdbIds = signal<Map<number, FliksRequestStatus>>(new Map());

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  ngAfterViewInit() {
    // Focus only if no existing query (first visit)
    if (!this.state.hasQuery()) {
      setTimeout(() => this.searchInput()?.nativeElement.focus(), 100);
    }
  }

  ngOnDestroy() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  async loadRequestedIds() {
    if (this.auth.hasPermission('requests.create') && !this.auth.hasPermission('media.create')) {
      try {
        const res = await this.requestsApi.list({ limit: 200 });
        this.requestedTmdbIds.set(new Map(res.data.map(r => [r.tmdbId, r.status])));
      } catch { /* ignore */ }
    }
  }

  onQueryInput(value: string) {
    this.state.query.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (value.trim()) {
      this.searchTimer = setTimeout(() => this.runSearch(), 350);
    } else {
      this.state.localResults.set([]);
      this.state.externalResults.set([]);
      this.state.localLoading.set(false);
      this.state.externalLoading.set(false);
    }
  }

  setFilter(f: 'all' | 'movie' | 'series') {
    this.state.filter.set(f);
    if (this.state.query().trim()) {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.runSearch();
    }
  }

  toggleExternal() {
    this.state.externalEnabled.update(v => !v);
    if (this.state.externalEnabled()) {
      // Re-run search to fetch external results
      if (this.state.query().trim()) {
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.runSearch();
      }
    } else {
      this.state.externalResults.set([]);
      this.state.externalLoading.set(false);
    }
  }

  clearQuery() {
    this.state.clear();
    this.searchInput()?.nativeElement.focus();
  }

  private async runSearch() {
    const q = this.state.query().trim();
    if (!q) return;

    const filter = this.state.filter();
    const type: MediaType | undefined = filter === 'all' ? undefined : filter;

    // Search local library first
    this.state.localLoading.set(true);
    try {
      const res = await this.mediaService.getAll({ q, type, limit: 20, sortBy: 'title' });
      this.state.localResults.set(res.data);
    } catch {
      this.state.localResults.set([]);
    } finally {
      this.state.localLoading.set(false);
    }

    // Then search external providers (if enabled)
    if (!this.state.externalEnabled()) return;
    this.state.externalLoading.set(true);
    try {
      let rows: MetadataSearchResult[];
      if (filter === 'movie') {
        rows = await this.metadata.searchMovie(q);
      } else if (filter === 'series') {
        rows = await this.metadata.searchTv(q);
      } else {
        const [movies, tv] = await Promise.all([
          this.metadata.searchMovie(q),
          this.metadata.searchTv(q),
        ]);
        rows = [...movies, ...tv].sort((a, b) => b.rating - a.rating);
      }
      this.state.externalResults.set(rows);
      this.loadRequestedIds();
    } catch {
      this.state.externalResults.set([]);
    } finally {
      this.state.externalLoading.set(false);
    }
  }

  cardStatus(row: MetadataSearchResult): CardStatus {
    if (row.existingMediaId) return 'library';
    const reqStatus = this.requestedTmdbIds().get(row.tmdbId);
    if (!reqStatus) return null;
    if (reqStatus === 'declined' || reqStatus === 'failed') return 'declined';
    if (reqStatus === 'available') return 'library';
    return 'pending';
  }

  onExternalCardClick(row: MetadataSearchResult) {
    if (row.existingMediaId) {
      const prefix = row.existingMediaType === 'series' ? '/series' : '/movies';
      void this.router.navigate([prefix, row.existingMediaId]);
    } else {
      const prefix = row.mediaType === 'series' ? '/add/tv' : '/add/movie';
      void this.router.navigate([prefix, row.tmdbId]);
    }
  }
}

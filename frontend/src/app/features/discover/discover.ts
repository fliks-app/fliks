import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  OnDestroy,
  OnInit,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import {
  MetadataService,
  MetadataSearchResult,
} from '../../core/services/api/metadata.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { RootFoldersApiService, RootFolder } from '../../core/services/api/root-folders-api.service';
import { RequestsService, SuitarrRequestStatus } from '../../core/services/api/requests.service';
import { ToastService } from '../../core/services/toast.service';
import { MediaType } from '../../core/enums/media-type.enum';
import { DiscoverCardComponent, CardStatus } from './components/discover-card/discover-card.component';
import { RequestModalComponent } from './components/request-modal/request-modal.component';

@Component({
  selector: 'app-discover',
  imports: [FormsModule, TranslateModule, DiscoverCardComponent, RequestModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './discover.html',
})
export class DiscoverComponent implements OnInit, OnDestroy {
  private readonly metadata = inject(MetadataService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly rootFoldersApi = inject(RootFoldersApiService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private readonly requestsApi = inject(RequestsService);
  private readonly toast = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly qualityProfiles = signal<{ id: number; name: string }[]>([]);
  readonly selectedQualityProfileId = signal<number | null>(null);

  readonly rootFolders = signal<RootFolder[]>([]);
  readonly selectedRootFolderId = signal<number | null>(null);

  readonly tab = signal<MediaType>('movie');
  readonly discoverMode = signal<'search' | 'trending' | 'popular' | 'upcoming'>('trending');
  readonly discoverResults = signal<MetadataSearchResult[]>([]);
  readonly discoverLoading = signal(false);
  readonly query = signal('');
  readonly results = signal<MetadataSearchResult[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly importingTmdbId = signal<number | null>(null);

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly canImport = computed(() => this.auth.hasPermission('media.create'));
  readonly canRequest = computed(() => !this.canImport() && this.auth.hasPermission('requests.create'));
  readonly requestedTmdbIds = signal<Map<number, SuitarrRequestStatus>>(new Map());

  // Request modal
  private readonly requestModal = viewChild(RequestModalComponent);
  readonly languageProfiles = signal<{ id: number; name: string }[]>([]);
  readonly requestRootFolders = signal<RootFolder[]>([]);

  async ngOnInit() {
    const promises: Promise<void>[] = [];

    if (this.canImport()) {
      promises.push(
        Promise.all([
          this.profilesApi.getQualityProfiles(),
          this.rootFoldersApi.list(),
        ]).then(([profiles, folders]) => {
          this.qualityProfiles.set(profiles.map((p) => ({ id: p.id, name: p.name })));
          if (profiles.length && this.selectedQualityProfileId() == null) {
            this.selectedQualityProfileId.set(profiles[0].id);
          }
          this.rootFolders.set(folders);
          if (folders.length && this.selectedRootFolderId() == null) {
            this.selectedRootFolderId.set(folders[0].id);
          }
        }),
      );
    }

    if (this.canRequest()) {
      promises.push(
        Promise.all([
          this.profilesApi.getQualityProfiles(),
          this.profilesApi.getLanguageProfiles(),
          this.requestsApi.list({ limit: 100 }),
          this.rootFoldersApi.list(),
        ]).then(([qp, lp, res, folders]) => {
          this.qualityProfiles.set(qp.map((p) => ({ id: p.id, name: p.name })));
          this.languageProfiles.set(lp.map((p) => ({ id: p.id, name: p.name })));
          this.requestedTmdbIds.set(new Map(res.data.map((r) => [r.tmdbId, r.status])));
          this.requestRootFolders.set(folders);
        }),
      );
    }

    await Promise.all(promises);
    this.loadDiscover();
  }

  ngOnDestroy() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  setTab(t: MediaType) {
    this.tab.set(t);
    this.results.set([]);
    this.error.set('');
    if (this.discoverMode() === 'search') {
      this.scheduleSearch();
    } else {
      this.loadDiscover();
    }
  }

  onQueryInput(value: string) {
    this.query.set(value);
    if (value.trim()) {
      this.discoverMode.set('search');
      this.scheduleSearch();
    } else {
      this.discoverMode.set('trending');
      this.results.set([]);
      this.loading.set(false);
      this.loadDiscover();
    }
  }

  async loadDiscover() {
    const mode = this.discoverMode();
    if (mode === 'search') return;
    this.discoverLoading.set(true);
    this.error.set('');
    try {
      const isMovie = this.tab() === 'movie';
      let rows: MetadataSearchResult[];
      switch (mode) {
        case 'trending':
          rows = await (isMovie ? this.metadata.getTrendingMovies() : this.metadata.getTrendingTv());
          break;
        case 'popular':
          rows = await (isMovie ? this.metadata.getPopularMovies() : this.metadata.getPopularTv());
          break;
        case 'upcoming':
          rows = await (isMovie ? this.metadata.getUpcomingMovies() : this.metadata.getUpcomingTv());
          break;
      }
      this.discoverResults.set(rows);
    } catch {
      this.discoverResults.set([]);
      this.error.set(this.translate.instant('discover.search_error'));
    } finally {
      this.discoverLoading.set(false);
    }
  }

  private scheduleSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.runSearch(), 380);
  }

  searchNow() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.runSearch();
  }

  private async runSearch() {
    const q = this.query().trim();
    if (!q) {
      this.results.set([]);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.error.set('');
    try {
      const rows = await (this.tab() === 'movie'
        ? this.metadata.searchMovie(q)
        : this.metadata.searchTv(q));
      this.results.set(rows);
    } catch {
      this.results.set([]);
      this.error.set(this.translate.instant('discover.search_error'));
    } finally {
      this.loading.set(false);
    }
  }

  cardStatus(row: MetadataSearchResult): CardStatus {
    if (row.existingMediaId && !this.requestedTmdbIds().has(row.tmdbId)) return 'library';
    const reqStatus = this.requestedTmdbIds().get(row.tmdbId);
    if (!reqStatus) return null;
    if (reqStatus === 'declined' || reqStatus === 'failed') return 'declined';
    if (reqStatus === 'available') return 'library';
    return 'pending';
  }

  onCardClick(row: MetadataSearchResult) {
    if (row.existingMediaId) {
      const prefix = row.existingMediaType === 'series' ? '/series' : '/movies';
      void this.router.navigate([prefix, row.existingMediaId]);
    } else {
      const prefix = this.tab() === 'series' ? '/add/tv' : '/add/movie';
      void this.router.navigate([prefix, row.tmdbId]);
    }
  }

  onRequested() {
    this.requestedTmdbIds.update((m) => {
      const next = new Map(m);
      // Refresh would be better, but for now just mark as pending
      return next;
    });
  }
}

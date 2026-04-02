import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DecimalPipe, NgClass } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import {
  MetadataService,
  MetadataSearchResult,
} from '../../core/services/api/metadata.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { RootFoldersApiService, RootFolder } from '../../core/services/api/root-folders-api.service';
import { RequestsService } from '../../core/services/api/requests.service';
import { ToastService } from '../../core/services/toast.service';

type DiscoverTab = 'movie' | 'series';

@Component({
  selector: 'app-discover',
  imports: [FormsModule, DecimalPipe, NgClass, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './discover.html',
})
export class DiscoverComponent implements OnInit, OnDestroy {
  private readonly metadata = inject(MetadataService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly rootFoldersApi = inject(RootFoldersApiService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  readonly auth = inject(AuthService);

  readonly qualityProfiles = signal<{ id: number; name: string }[]>([]);
  readonly selectedQualityProfileId = signal<number | null>(null);

  readonly rootFolders = signal<RootFolder[]>([]);
  readonly selectedRootFolderId = signal<number | null>(null);

  readonly tab = signal<DiscoverTab>('movie');
  readonly discoverMode = signal<'search' | 'trending' | 'popular' | 'upcoming'>('trending');
  readonly discoverResults = signal<MetadataSearchResult[]>([]);
  readonly discoverLoading = signal(false);
  readonly query = signal('');
  readonly results = signal<MetadataSearchResult[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly importingTmdbId = signal<number | null>(null);

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly requestsApi = inject(RequestsService);
  private readonly toast = inject(ToastService);

  readonly canImport = computed(() => this.auth.hasPermission('media.create'));
  readonly canRequest = computed(() => !this.canImport() && this.auth.hasPermission('requests.create'));
  readonly requestingTmdbId = signal<number | null>(null);
  readonly requestedTmdbIds = signal<Set<number>>(new Set());

  // Request modal
  readonly languageProfiles = signal<{ id: number; name: string }[]>([]);
  readonly requestModalRow = signal<MetadataSearchResult | null>(null);
  readonly requestQualityProfileId = signal<number | null>(null);
  readonly requestLanguageProfileId = signal<number | null>(null);

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
        ]).then(([qp, lp, res]) => {
          this.qualityProfiles.set(qp.map((p) => ({ id: p.id, name: p.name })));
          this.languageProfiles.set(lp.map((p) => ({ id: p.id, name: p.name })));
          this.requestedTmdbIds.set(new Set(res.data.map((r) => r.tmdbId)));
        }),
      );
    }

    await Promise.all(promises);
    this.loadDiscover();
  }

  ngOnDestroy() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  setTab(t: DiscoverTab) {
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

  onCardClick(row: MetadataSearchResult) {
    if (row.existingMediaId) {
      const prefix = row.existingMediaType === 'series' ? '/series' : '/movies';
      void this.router.navigate([prefix, row.existingMediaId]);
    } else {
      const prefix = this.tab() === 'series' ? '/add/tv' : '/add/movie';
      void this.router.navigate([prefix, row.tmdbId]);
    }
  }

  async importResult(event: Event, row: MetadataSearchResult) {
    event.stopPropagation();
    if (!this.canImport() || row.existingMediaId) return;
    const type = this.tab();
    this.importingTmdbId.set(row.tmdbId);
    this.error.set('');
    const qp = this.selectedQualityProfileId();
    const rf = this.selectedRootFolderId();
    try {
      const media = await this.metadata.importFromTmdb(
        type,
        row.tmdbId,
        qp ?? undefined,
        rf ?? undefined,
      );
      this.toast.success(this.translate.instant('discover.import_success'));
      const path = media.type === 'movie' ? '/movies' : '/series';
      void this.router.navigate([path, media.id]);
    } catch (err: unknown) {
      const httpErr = err as { status?: number; error?: { message?: string } };
      const status = httpErr?.status;
      if (status === 400) {
        this.error.set(
          httpErr.error?.message ??
            this.translate.instant('discover.tmdb_not_configured'),
        );
      } else if (status === 403) {
        this.error.set(this.translate.instant('discover.forbidden'));
      } else {
        this.error.set(this.translate.instant('discover.import_error'));
      }
    } finally {
      this.importingTmdbId.set(null);
    }
  }

  openRequestModal(event: Event, row: MetadataSearchResult) {
    event.stopPropagation();
    if (!this.canRequest() || row.existingMediaId || this.requestedTmdbIds().has(row.tmdbId)) return;
    this.requestQualityProfileId.set(this.qualityProfiles()[0]?.id ?? null);
    this.requestLanguageProfileId.set(this.languageProfiles()[0]?.id ?? null);
    this.requestModalRow.set(row);
  }

  closeRequestModal() {
    this.requestModalRow.set(null);
  }

  async confirmRequest() {
    const row = this.requestModalRow();
    if (!row) return;
    this.requestingTmdbId.set(row.tmdbId);
    try {
      await this.requestsApi.create({
        mediaType: this.tab(),
        tmdbId: row.tmdbId,
        title: row.title,
        qualityProfileId: this.requestQualityProfileId() ?? undefined,
        languageProfileId: this.requestLanguageProfileId() ?? undefined,
      });
      row.existingMediaId = -1;
      this.requestedTmdbIds.update((s) => new Set(s).add(row.tmdbId));
      this.toast.success(this.translate.instant('discover.request_success'));
      this.closeRequestModal();
    } catch {
      // error toast handled by the global error interceptor
    } finally {
      this.requestingTmdbId.set(null);
    }
  }
}

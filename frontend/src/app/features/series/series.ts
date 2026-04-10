import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  Injector,
  OnInit,
  OnDestroy,
  ElementRef,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService, Media } from '../../core/services/api/media.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { ProfilesService, QualityProfile } from '../../core/services/api/profiles.service';
import { MediaCardComponent } from '../../shared/components/media-card';
import { computeMediaBarStatus, computeMediaBarPercent } from '../../shared/utils/media-status.util';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { InfiniteScrollList } from '../../shared/utils/infinite-scroll-list';
import { LucideSearch, LucideSlidersHorizontal } from '@lucide/angular';

const ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

@Component({
  selector: 'app-series',
  imports: [MediaCardComponent, FormsModule, TranslateModule, LucideSearch, LucideSlidersHorizontal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './series.html',
})
export class SeriesComponent implements OnInit, OnDestroy {
  readonly computeBarStatus = computeMediaBarStatus;
  readonly computeBarPercent = computeMediaBarPercent;
  private readonly mediaService = inject(MediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly profilesService = inject(ProfilesService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly injector = inject(Injector);
  private readonly scrollKey = 'series';

  readonly list = new InfiniteScrollList<Media>();
  readonly watchedIds = signal<Set<number>>(new Set());
  readonly loading = signal(false);
  readonly searchQuery = signal('');
  readonly sortBy = signal('title');
  readonly filterMonitored = signal<'' | 'true' | 'false'>('');
  readonly filterStatus = signal('');

  readonly monitoredCount = computed(() => this.list.all().filter((m) => m.monitored).length);
  readonly totalEpisodes = computed(() =>
    this.list.all().reduce((sum, m) => sum + (m.episodeStats?.totalEpisodes ?? 0), 0),
  );
  readonly downloadedEpisodes = computed(() =>
    this.list.all().reduce((sum, m) => sum + (m.episodeStats?.downloadedEpisodes ?? 0), 0),
  );

  readonly alphabet = ALPHABET;
  readonly filtersOpen = signal(false);
  readonly hasActiveFilters = computed(() => this.filterMonitored() !== '' || this.filterStatus() !== '' || this.sortBy() !== 'title');

  @ViewChild('sentinel') set sentinelRef(ref: ElementRef<HTMLElement> | undefined) {
    this.list.observeSentinel(ref);
  }

  // Bulk editing
  readonly selectedIds = signal<Set<number>>(new Set());
  readonly bulkMode = signal(false);
  readonly bulkSaving = signal(false);
  readonly bulkQualityProfileId = signal<number | null>(null);
  readonly bulkMonitored = signal<'' | 'true' | 'false'>('');
  readonly qualityProfiles = signal<QualityProfile[]>([]);

  ngOnInit() {
    const qp = this.route.snapshot.queryParamMap;
    const stored = this.loadFilters();
    this.searchQuery.set(qp.get('q') ?? stored['q'] ?? '');
    this.filterMonitored.set((qp.get('monitored') ?? stored['monitored'] ?? '') as '' | 'true' | 'false');
    this.filterStatus.set(qp.get('status') ?? stored['status'] ?? '');
    this.sortBy.set(qp.get('sortBy') ?? stored['sortBy'] ?? 'title');

    this.scrollMemory.activate(this.scrollKey);
    this.list.trackScroll('series');
    this.syncQueryParams();
    this.load().then(() => this.scrollMemory.restore(this.scrollKey, this.injector));
    this.profilesService.getQualityProfiles().then((p) => this.qualityProfiles.set(p));
  }

  ngOnDestroy() {
    this.scrollMemory.deactivate();
    this.list.destroy();
  }

  scrollToLetter(letter: string) {
    this.list.scrollToLetter(letter, (m) => m.title, 'series');
  }

  onSearch(query: string) {
    this.searchQuery.set(query);
    this.syncQueryParams();
    this.load();
  }

  onFilterChange() {
    this.syncQueryParams();
    this.load();
  }

  toggleSelect(id: number) {
    this.selectedIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  selectAll() {
    this.selectedIds.set(new Set(this.list.all().map((m) => m.id)));
  }

  deselectAll() {
    this.selectedIds.set(new Set());
  }

  toggleBulkMode() {
    this.bulkMode.update((v) => !v);
    if (!this.bulkMode()) {
      this.selectedIds.set(new Set());
      this.bulkQualityProfileId.set(null);
      this.bulkMonitored.set('');
    }
  }

  async applyBulk() {
    const ids = [...this.selectedIds()];
    if (!ids.length) return;

    const body: Parameters<MediaService['bulkUpdate']>[0] = { ids };
    if (this.bulkQualityProfileId() !== null) {
      body.qualityProfileId = this.bulkQualityProfileId()!;
    }
    if (this.bulkMonitored() !== '') {
      body.monitored = this.bulkMonitored() === 'true';
    }

    this.bulkSaving.set(true);
    try {
      await this.mediaService.bulkUpdate(body);
      this.selectedIds.set(new Set());
      this.bulkQualityProfileId.set(null);
      this.bulkMonitored.set('');
      this.bulkMode.set(false);
      await this.load();
    } finally {
      this.bulkSaving.set(false);
    }
  }

  private syncQueryParams() {
    const params: Record<string, string> = {};
    if (this.searchQuery()) params['q'] = this.searchQuery();
    if (this.filterMonitored()) params['monitored'] = this.filterMonitored();
    if (this.filterStatus()) params['status'] = this.filterStatus();
    if (this.sortBy() !== 'title') params['sortBy'] = this.sortBy();
    void this.router.navigate([], { queryParams: params, replaceUrl: true });
    this.saveFilters();
  }

  private readonly storageKey = 'fliks.filters.series';

  private saveFilters() {
    const data: Record<string, string> = {};
    if (this.searchQuery()) data['q'] = this.searchQuery();
    if (this.filterMonitored()) data['monitored'] = this.filterMonitored();
    if (this.filterStatus()) data['status'] = this.filterStatus();
    if (this.sortBy() !== 'title') data['sortBy'] = this.sortBy();
    localStorage.setItem(this.storageKey, JSON.stringify(data));
  }

  private loadFilters(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(this.storageKey) ?? '{}');
    } catch {
      return {};
    }
  }

  async refreshWatchedIds() {
    try {
      const ids = await this.streamingApi.getWatchedMediaIds();
      this.watchedIds.set(new Set(ids));
    } catch {
      /* ignore */
    }
  }

  private async load() {
    this.loading.set(true);
    const monitored = this.filterMonitored();
    try {
      const fs = this.filterStatus();
      const [res, watchedIds] = await Promise.all([
        this.mediaService.getAll({
          type: 'series',
          q: this.searchQuery() || undefined,
          sortBy: this.sortBy(),
          monitored: monitored ? monitored === 'true' : undefined,
          missing: fs === 'missing' ? true : fs === 'downloaded' ? false : undefined,
          cutoffUnmet: fs === 'cutoffUnmet' ? true : undefined,
          limit: 0,
        }),
        this.streamingApi.getWatchedMediaIds().catch(() => [] as number[]),
      ]);
      this.list.setItems(res.data, (m) => m.title);
      this.watchedIds.set(new Set(watchedIds));
    } finally {
      this.loading.set(false);
    }
  }
}

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
  afterNextRender,
  effect,
} from '@angular/core';
import { ActivatedRoute, NavigationStart, Router } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MediaService, Media } from '../../core/services/api/media.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { ProfilesService, QualityProfile } from '../../core/services/api/profiles.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { FocusMemoryService } from '../../core/services/focus-memory.service';
import { NavbarService } from '../../core/services/navbar.service';
import { TvService } from '../../core/services/tv.service';
import { InfiniteScrollList } from '../../shared/utils/infinite-scroll-list';
import { LucideSearch, LucideSlidersHorizontal } from '@lucide/angular';

const ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

@Component({
  selector: 'app-library',
  imports: [MediaCardComponent, FormsModule, TranslateModule, LucideSearch, LucideSlidersHorizontal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library.html',
})
export class LibraryComponent implements OnInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly profilesService = inject(ProfilesService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly focusMemory = inject(FocusMemoryService);
  private readonly navbar = inject(NavbarService);
  private readonly tv = inject(TvService);
  private readonly injector = inject(Injector);
  private readonly translate = inject(TranslateService);
  private arrivedViaBack = false;
  private navStartSub?: Subscription;

  /** Resolved library (null while loading or if not found). */
  readonly library = signal<LibrarySummary | null>(null);
  readonly libraryName = signal('');

  readonly list = new InfiniteScrollList<Media>();
  readonly watchedIds = signal<Set<number>>(new Set());
  readonly loading = signal(false);
  readonly searchQuery = signal('');
  readonly sortBy = signal('title');
  readonly filterMonitored = signal<'' | 'true' | 'false'>('');
  readonly filterStatus = signal('');

  readonly monitoredCount = computed(() => this.list.all().filter((m) => m.monitored).length);
  readonly movieFileCount = computed(() =>
    this.list.all().filter((m) => m.type === 'movie' && (m.files?.length ?? 0) > 0).length,
  );
  readonly totalMovies = computed(() =>
    this.list.all().filter((m) => m.type === 'movie').length,
  );
  readonly totalSeries = computed(() =>
    this.list.all().filter((m) => m.type === 'series').length,
  );
  readonly totalEpisodes = computed(() =>
    this.list.all().reduce((sum, m) => sum + (m.episodeStats?.totalEpisodes ?? 0), 0),
  );
  readonly downloadedEpisodes = computed(() =>
    this.list.all().reduce((sum, m) => sum + (m.episodeStats?.downloadedEpisodes ?? 0), 0),
  );
  readonly hasMovies = computed(() => this.totalMovies() > 0);
  readonly hasSeries = computed(() => this.totalSeries() > 0);

  readonly alphabet = ALPHABET;
  readonly filtersOpen = signal(false);
  readonly hasActiveFilters = computed(() =>
    this.filterMonitored() !== '' || this.filterStatus() !== '' || this.sortBy() !== 'title',
  );

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

  private allLibraries: LibrarySummary[] = [];

  /** Re-load when route param changes (e.g. clicking another library in sidebar). */
  private readonly paramEffect = effect(() => {
    // Angular signal-based route params aren't available yet in 21.x for
    // lazy routes, so we subscribe manually in ngOnInit below.
  }, { allowSignalWrites: true });

  ngOnInit() {
    this.arrivedViaBack = this.navbar.lastWasBack();
    if (this.tv.isTv()) {
      this.navStartSub = this.router.events
        .pipe(filter((e): e is NavigationStart => e instanceof NavigationStart))
        .subscribe(() => {
          const active = document.activeElement as HTMLElement | null;
          const container = active?.closest<HTMLElement>('[data-library-focus]');
          const sel = container?.dataset['libraryFocus'];
          const lib = this.library();
          if (sel && lib) this.focusMemory.save(`library-${lib.id}`, sel);
        });
    }
    // Subscribe to route param changes (handles initial load + sidebar nav).
    this.route.params.subscribe(async (params) => {
      const rawName = params['libraryName'] as string;
      if (!rawName) return;
      const name = decodeURIComponent(rawName);
      this.libraryName.set(name);

      // Resolve library by name
      if (!this.allLibraries.length) {
        this.allLibraries = await this.librariesApi.listMine();
      }

      // Handle legacy redirects (__default_movies__ / __default_series__)
      if (name === '__default_movies__' || name === '__default_series__') {
        const flag = name === '__default_movies__' ? 'isDefaultForMovies' : 'isDefaultForSeries';
        const defaultLib = this.allLibraries.find((l) => l[flag]) ?? this.allLibraries[0];
        if (defaultLib) {
          void this.router.navigate(
            ['/libraries', encodeURIComponent(defaultLib.name)],
            { replaceUrl: true },
          );
        }
        return;
      }

      const lib = this.allLibraries.find((l) => l.name === name);
      this.library.set(lib ?? null);
      if (!lib) return;

      this.navbar.setPageTitle(lib.name);

      // Restore filters
      const scrollKey = `library-${lib.id}`;
      const qp = this.route.snapshot.queryParamMap;
      const stored = this.loadFilters(lib.name);
      this.searchQuery.set(qp.get('q') ?? stored['q'] ?? '');
      this.filterMonitored.set(
        (qp.get('monitored') ?? stored['monitored'] ?? '') as '' | 'true' | 'false',
      );
      this.filterStatus.set(qp.get('status') ?? stored['status'] ?? '');
      this.sortBy.set(qp.get('sortBy') ?? stored['sortBy'] ?? 'title');

      this.scrollMemory.activate(scrollKey);
      this.list.trackScroll('media');
      this.syncQueryParams();
      await this.load(lib.id);
      this.scrollMemory.restore(scrollKey, this.injector);
      if (this.tv.isTv()) {
        afterNextRender(() => this.applyDefaultFocus(lib.id), { injector: this.injector });
      }
    });
  }

  ngOnDestroy() {
    this.scrollMemory.deactivate();
    this.list.destroy();
    this.navbar.clearPageTitle();
    this.navStartSub?.unsubscribe();
  }

  private applyDefaultFocus(libraryId: number) {
    const root = document.querySelector<HTMLElement>('app-library') ?? document.body;
    const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex="0"]';
    if (this.arrivedViaBack) {
      const saved = this.focusMemory.retrieve(`library-${libraryId}`);
      const container = saved
        ? root.querySelector<HTMLElement>(`[data-library-focus="${CSS.escape(saved)}"]`)
        : null;
      const target = container?.matches(FOCUSABLE)
        ? container
        : container?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
      if (target) {
        target.focus({ preventScroll: false });
        return;
      }
    }
    // Default: first card in the grid.
    const firstCard = root.querySelector<HTMLElement>('[data-library-focus^="media:"]');
    const target = firstCard?.matches(FOCUSABLE)
      ? firstCard
      : firstCard?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: false });
  }

  scrollToLetter(letter: string) {
    this.list.scrollToLetter(letter, (m) => m.title, 'media');
  }

  onSearch(query: string) {
    this.searchQuery.set(query);
    this.syncQueryParams();
    this.load(this.library()?.id);
  }

  onFilterChange() {
    this.syncQueryParams();
    this.load(this.library()?.id);
  }

  toggleSelect(id: number) {
    this.selectedIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Lazy-load quality profiles on first selection (for bulk edit panel).
    if (!this.qualityProfiles().length) {
      this.profilesService.getQualityProfiles().then((p) => this.qualityProfiles.set(p)).catch(() => {});
    }
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
      await this.load(this.library()?.id);
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

  private get storageKey(): string {
    return `fliks.filters.library.${this.libraryName()}`;
  }

  private saveFilters() {
    const data: Record<string, string> = {};
    if (this.searchQuery()) data['q'] = this.searchQuery();
    if (this.filterMonitored()) data['monitored'] = this.filterMonitored();
    if (this.filterStatus()) data['status'] = this.filterStatus();
    if (this.sortBy() !== 'title') data['sortBy'] = this.sortBy();
    localStorage.setItem(this.storageKey, JSON.stringify(data));
  }

  private loadFilters(name: string): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(`fliks.filters.library.${name}`) ?? '{}');
    } catch {
      return {};
    }
  }

  private async load(libraryId?: number) {
    if (!libraryId) return;
    this.loading.set(true);
    const monitored = this.filterMonitored();
    try {
      const fs = this.filterStatus();
      const [res, watchedIds] = await Promise.all([
        this.mediaService.getAll({
          libraryId,
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

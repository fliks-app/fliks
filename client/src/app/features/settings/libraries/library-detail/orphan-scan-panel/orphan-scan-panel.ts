import {
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UpperCasePipe } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideCheck, LucideChevronsDownUp, LucideChevronsUpDown } from '@lucide/angular';
import { MediaType } from '../../../../../core/enums/media-type.enum';
import { PaginationComponent } from '../../../../../shared/components/pagination/pagination';
import { ResolveUrlPipe } from '../../../../../core/pipes/resolve-url.pipe';
import { ToastService } from '../../../../../core/services/toast.service';
import { SseService } from '../../../../../core/services/sse.service';
import { serverMessage } from '../../../../../core/utils/server-message';
import {
  MetadataService,
  MetadataSearchResult,
  searchResultKey,
} from '../../../../../core/services/api/metadata.service';
import {
  ImportsApiService,
  OrphanGroup,
  OrphanScanResult,
  RelinkOrphansBody,
  TransferMethod,
} from '../../../../../core/services/api/imports-api.service';

const PAGE_SIZE = 20;
const SEARCH_CONCURRENCY = 8;
/** Each unit copies/moves real files server-side; unlike a metadata search, unbounded
 *  fan-out here means dozens of full videos copying at once. */
const AUTO_IMPORT_CONCURRENCY = 3;

interface GroupVM {
  group: OrphanGroup;
  query: string;
  year: number | null;
  results: MetadataSearchResult[];
  searching: boolean;
  searched: boolean;
  pick: MetadataSearchResult | null;
  fromNfo: boolean;
  linking: boolean;
  done: boolean;
  error: string;
  collapsed: boolean;
}

@Component({
  selector: 'app-orphan-scan-panel',
  imports: [
    FormsModule,
    UpperCasePipe,
    TranslatePipe,
    ResolveUrlPipe,
    LucideCheck,
    LucideChevronsDownUp,
    LucideChevronsUpDown,
    PaginationComponent,
  ],
  templateUrl: './orphan-scan-panel.html',
  host: { class: 'flex flex-col min-h-0 flex-1' },
})
export class OrphanScanPanelComponent {
  private readonly importsApi = inject(ImportsApiService);
  private readonly metadata = inject(MetadataService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly sse = inject(SseService);

  /** Collect picks without linking — the library does not exist yet. */
  readonly deferLink = input(false);
  /** The scanned folder is outside the library: copy or move each title into it. */
  readonly transfer = input<TransferMethod | null>(null);

  private libraryId = 0;
  /** Set only by `scanPath`: caps how far the server's series-folder lookup climbs. */
  private scanRoot: string | undefined;
  private searchSeq = 0;
  /** Latest search per group, so a slower earlier one can't overwrite it. */
  private readonly latestSearch = new Map<number, number>();
  /** Bumped on every `load()`: guards a scan still in flight (library switched mid-scan)
   *  from patching results into the groups of a scan that replaced it. */
  private scanGeneration = 0;
  readonly anyLinked = signal(false);

  /** Nothing to render before the first scan runs. */
  readonly started = signal(false);
  readonly scanning = signal(false);
  readonly scanError = signal('');
  readonly scannedFiles = signal(0);
  readonly orphanCount = signal(0);
  readonly groups = signal<GroupVM[]>([]);

  /** Live file counter pushed by the server walk, so a multi-minute scan of a
   *  NAS folder isn't a bare spinner. */
  readonly scanProgress = computed(() => this.sse.activeProgress().get('OrphanScan') ?? null);

  readonly page = signal(1);
  readonly autoImporting = signal(false);
  /** Move + rename files into the naming layout instead of linking in place. */
  readonly reorganize = signal(true);

  readonly pendingGroups = computed(() =>
    this.groups().filter((g) => !g.done && !g.linking),
  );

  readonly hasLinkable = computed(() =>
    this.groups().some((g) => !g.done),
  );

  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.groups().length / PAGE_SIZE)),
  );

  /** Current page, each entry keeping its absolute index into `groups()`. */
  readonly pagedGroups = computed(() => {
    const start = (this.page() - 1) * PAGE_SIZE;
    return this.groups()
      .map((vm, i) => ({ vm, i }))
      .slice(start, start + PAGE_SIZE);
  });

  readonly allExpanded = computed(
    () => this.groups().length > 0 && this.groups().every((g) => !g.collapsed),
  );

  toggleCollapse(index: number) {
    this.patch(index, { collapsed: !this.groups()[index].collapsed });
  }

  toggleAll() {
    const collapse = this.allExpanded();
    this.groups.update((list) =>
      list.map((g) => ({ ...g, collapsed: collapse })),
    );
  }

  async scanLibrary(libraryId: number) {
    this.libraryId = libraryId;
    this.scanRoot = undefined;
    await this.load(() => this.importsApi.scanOrphans(libraryId));
  }

  /** Scan a bare folder, for a library not created yet (0) or one it imports into. */
  async scanPath(
    path: string,
    mediaTypes: MediaType[],
    provider: string | null,
    libraryId = 0,
  ) {
    this.libraryId = libraryId;
    this.scanRoot = path;
    await this.load(() =>
      this.importsApi.previewOrphans({ path, mediaTypes, preferredProvider: provider }),
    );
  }

  private async load(scan: () => Promise<OrphanScanResult>) {
    const generation = ++this.scanGeneration;
    this.latestSearch.clear();
    this.started.set(true);
    this.anyLinked.set(false);
    this.scanError.set('');
    this.groups.set([]);
    this.scannedFiles.set(0);
    this.orphanCount.set(0);

    this.page.set(1);

    this.scanning.set(true);
    try {
      const res = await scan();
      if (generation !== this.scanGeneration) return;
      this.scannedFiles.set(res.scannedFiles);
      this.orphanCount.set(res.orphanCount);
      this.groups.set(
        res.groups.map((group) => ({
          group,
          query: group.guessTitle ?? group.folderName,
          year: group.guessYear,
          results: [],
          searching: false,
          searched: false,
          pick: null,
          fromNfo: false,
          linking: false,
          done: false,
          error: '',
          collapsed: false,
        })),
      );
    } catch (err: unknown) {
      if (generation !== this.scanGeneration) return;
      this.scanError.set(this.failure('scan', err));
    } finally {
      if (generation === this.scanGeneration) this.scanning.set(false);
    }
    if (generation === this.scanGeneration) await this.searchPage();
  }

  async goToPage(page: number) {
    if (page < 1 || page > this.pageCount() || page === this.page()) return;
    this.page.set(page);
    await this.searchPage();
  }

  /** Search the groups shown on the current page that have no results yet. */
  private async searchPage() {
    await Promise.all(
      this.pagedGroups()
        .filter(({ vm }) => !vm.searched && !vm.searching)
        .map(({ i }) => this.search(i)),
    );
  }

  /** Search every listed group not yet searched, capped at SEARCH_CONCURRENCY concurrent requests. */
  private async searchBatched(indices: number[]) {
    const unsearched = indices.filter((i) => !this.groups()[i].searched);
    for (let s = 0; s < unsearched.length; s += SEARCH_CONCURRENCY) {
      await Promise.all(
        unsearched.slice(s, s + SEARCH_CONCURRENCY).map((i) => this.search(i)),
      );
    }
  }

  /**
   * Queue every detected group for import into a library that now exists.
   * A group the admin left untouched takes the provider's first result; a
   * group with no pick (no match, or explicitly deselected) is added unmatched.
   * A group whose search errored is left alone (still visible with its alert)
   * rather than queued unmatched. Returns once the batch is queued: the
   * server imports in the background.
   */
  async importAll(libraryId: number): Promise<{ queued: number; unmatched: number; failed: number }> {
    const pending = this.groups()
      .map((g, i) => (g.done ? -1 : i))
      .filter((i) => i >= 0);
    await this.searchBatched(pending);

    const items: RelinkOrphansBody[] = [];
    let unmatched = 0;
    let failed = 0;
    for (const i of pending) {
      const vm = this.groups()[i];
      if (vm.error) {
        failed++;
        continue;
      }
      items.push(this.relinkBody(libraryId, vm, vm.pick));
      if (!vm.pick) unmatched++;
    }
    if (items.length) await this.importsApi.relinkOrphansBatch(items);
    return { queued: items.length, unmatched, failed };
  }

  private relinkBody(
    libraryId: number,
    vm: GroupVM,
    pick: MetadataSearchResult | null,
  ): RelinkOrphansBody {
    const group = vm.group;
    return {
      libraryId,
      type: group.mediaType,
      ...(pick
        ? {
            externalId:
              pick.provider === 'tvdb' && pick.tvdbId != null
                ? String(pick.tvdbId)
                : String(pick.tmdbId),
            provider: pick.provider,
          }
        : {
            title: vm.query.trim() || group.guessTitle || group.folderName,
            year: vm.year ?? undefined,
          }),
      folderName: group.folderName,
      // A root-level movie has no folder to move into; the server refuses it anyway.
      reorganize: pick && group.folderName !== '' ? this.reorganize() : false,
      transfer: this.transfer() ?? undefined,
      scanRoot: this.scanRoot,
      files: group.files.map((f) => ({
        filePath: f.filePath,
        seasonNumber: f.seasonNumber ?? undefined,
        episodeNumber: f.episodeNumber ?? undefined,
        episodeEnd: f.episodeEnd ?? undefined,
      })),
    };
  }

  /** The server's own reason plus the status, so a bare 500 or a dropped request is still
   *  identifiable; the raw error stays in the console. */
  private failure(context: string, err: unknown): string {
    console.error(`[orphan-scan] ${context} failed:`, err);
    const message = serverMessage(
      err,
      this.translate,
      'settings.libraries.scan_error',
    );
    const status = (err as { status?: number })?.status;
    return status ? `${message} (HTTP ${status})` : message;
  }

  private patch(index: number, partial: Partial<GroupVM>) {
    this.groups.update((list) =>
      list.map((g, i) => (i === index ? { ...g, ...partial } : g)),
    );
  }

  /** The results and pick belong to the old name: the group needs a new search. */
  edit(index: number, partial: Partial<Pick<GroupVM, 'query' | 'year'>>) {
    this.latestSearch.delete(index);
    this.patch(index, {
      ...partial,
      results: [],
      pick: null,
      fromNfo: false,
      searched: false,
      searching: false,
    });
  }

  async search(index: number) {
    const vm = this.groups()[index];
    if (!vm) return;
    const query = vm.query.trim();
    if (!query) return;
    const generation = this.scanGeneration;
    const seq = ++this.searchSeq;
    this.latestSearch.set(index, seq);
    this.patch(index, { searching: true, error: '' });
    // A reply from a scan a newer `load()` replaced must not patch the new groups.
    const stale = () => generation !== this.scanGeneration || this.latestSearch.get(index) !== seq;
    try {
      const provider = vm.group.suggestedProvider;
      const results =
        vm.group.mediaType === 'series'
          ? await this.metadata.searchTv(query, vm.year ?? undefined, provider)
          : await this.metadata.searchMovie(query, vm.year ?? undefined, provider);
      if (stale()) return;

      // Auto-select the match referenced by the .nfo id, if any.
      const nfo = vm.group.nfo;
      const auto = nfo
        ? results.find(
            (r) =>
              (nfo.tmdbId != null && r.tmdbId === nfo.tmdbId) ||
              (nfo.tvdbId != null && r.tvdbId === nfo.tvdbId),
          )
        : undefined;
      // Import-all takes the first result when nothing is picked, so pick it
      // here: the row the import will use is the row the user sees selected.
      this.patch(index, {
        results,
        searching: false,
        searched: true,
        pick: auto ?? results[0] ?? null,
        fromNfo: !!auto,
      });
    } catch (err: unknown) {
      if (stale()) return;
      this.patch(index, {
        searching: false,
        searched: true,
        error: this.failure(`search "${query}"`, err),
      });
    }
  }

  readonly key = searchResultKey;

  isPicked(pick: MetadataSearchResult | null, result: MetadataSearchResult): boolean {
    return !!pick && searchResultKey(pick) === searchResultKey(result);
  }

  pick(index: number, result: MetadataSearchResult) {
    const current = this.groups()[index]?.pick ?? null;
    const same = this.isPicked(current, result);
    this.patch(index, { pick: same ? null : result, fromNfo: false });
  }

  /** The "add as is" pseudo-option: always sets an unmatched pick, no toggle. */
  pickUnmatched(index: number) {
    this.patch(index, { pick: null, fromNfo: false });
  }

  /** Why the reorganize toggle is ignored for this group's link button, or '' when it applies. */
  reorganizeTooltip(vm: GroupVM): string {
    if (this.transfer() || !this.reorganize()) return '';
    if (!vm.pick) return this.translate.instant('settings.libraries.scan_reorganize_needs_match');
    if (vm.group.folderName === '') {
      return this.translate.instant('settings.libraries.scan_reorganize_needs_folder');
    }
    return '';
  }

  async link(index: number) {
    const vm = this.groups()[index];
    if (!vm || vm.linking || vm.done) return;
    // A reply from a link a newer `load()` replaced must not patch the new groups.
    const generation = this.scanGeneration;
    this.patch(index, { linking: true, error: '' });
    try {
      const res = await this.importsApi.relinkOrphans(
        this.relinkBody(this.libraryId, vm, vm.pick),
      );
      if (generation !== this.scanGeneration) return;
      if (res.linked > 0) {
        this.anyLinked.set(true);
        this.patch(index, { linking: false, done: true });
        this.toast.success(
          this.translate.instant(
            this.transfer() ? 'import_disk.imported' : 'settings.libraries.scan_linked',
            { count: res.linked },
          ),
        );
      } else if (res.alreadyPresent > 0 && !res.errors.length) {
        // Every file already sits at its destination: a no-op re-run, not a failure.
        this.patch(index, { linking: false, done: true });
        this.toast.info(
          this.translate.instant('settings.libraries.scan_already_present', {
            count: res.alreadyPresent,
          }),
        );
      } else {
        // Nothing linked — typically a duplicate of a file already attached
        // to the media. Surface it on the group instead of marking it done.
        this.patch(index, {
          linking: false,
          error:
            res.errors[0] ??
            this.translate.instant('settings.libraries.scan_nothing_linked'),
        });
      }
    } catch (err: unknown) {
      if (generation !== this.scanGeneration) return;
      this.patch(index, {
        linking: false,
        error: this.failure(`link "${vm.group.folderName}"`, err),
      });
    }
  }

  async linkAll() {
    const indices = this.groups()
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => !g.done && !g.linking)
      .map(({ i }) => i);
    await this.searchBatched(indices);
    for (const i of indices) {
      if (this.groups()[i].error) continue;
      await this.link(i);
    }
  }

  /**
   * Pick the most accurate match for every remaining group and link it.
   * "Most accurate" = best year + title score; ties keep the provider's own
   * relevance order (earliest result wins).
   */
  async autoImportAll() {
    this.autoImporting.set(true);
    try {
      const indices = this.groups().map((_, i) => i);
      for (let s = 0; s < indices.length; s += AUTO_IMPORT_CONCURRENCY) {
        await Promise.all(
          indices.slice(s, s + AUTO_IMPORT_CONCURRENCY).map((i) => this.autoLinkOne(i)),
        );
      }
    } finally {
      this.autoImporting.set(false);
    }
  }

  private async autoLinkOne(index: number) {
    const vm = this.groups()[index];
    if (vm.done || vm.linking) return;
    if (!vm.searched) await this.search(index);
    if (this.groups()[index].error) return;
    // No provider match: still add it, unmatched, rather than leave it behind.
    const best = this.bestMatch(this.groups()[index]);
    this.patch(index, { pick: best });
    await this.link(index);
  }

  private bestMatch(vm: GroupVM): MetadataSearchResult | null {
    if (!vm.results.length) return null;
    const norm = (s: string | null | undefined) =>
      (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const query = norm(vm.query);
    let best: MetadataSearchResult | null = null;
    let bestScore = -Infinity;
    vm.results.forEach((r, idx) => {
      let score = 0;
      if (vm.year != null && r.year === vm.year) score += 100;
      const title = norm(r.title);
      if (query && title === query) score += 50;
      else if (query && (title.startsWith(query) || query.startsWith(title)))
        score += 20;
      // Keep provider relevance as the tie-breaker (earlier = better).
      score -= idx * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    });
    return best;
  }
}

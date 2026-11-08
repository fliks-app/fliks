import {
  Component,
  computed,
  inject,
  input,
  output,
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
  SearchHit,
  searchResultKey,
} from '../../../../../core/services/api/metadata.service';
import {
  ImportsApiService,
  OrphanFileId,
  OrphanGroup,
  OrphanScanResult,
  RelinkOrphansBody,
  TransferMethod,
} from '../../../../../core/services/api/imports-api.service';
import { KIND_REGISTRY } from '../../../../../core/media-kinds';

const PAGE_SIZE = 20;
const SEARCH_CONCURRENCY = 8;

/** The ISBN or ASIN the files of a book name: the settle identifies the book from it. */
export function bookFileId(group: OrphanGroup): OrphanFileId | undefined {
  return group.fileIds.find((f) => f.provider === 'isbn' || f.provider === 'asin');
}

/** A book is identified from its file at settle, with a confidence floor, unless a hit is picked. */
function identifiesFromFile(group: OrphanGroup): boolean {
  return group.mediaType === 'book';
}

/** Whether a search hit is the title one of the file ids names. */
function namesHit(ids: OrphanFileId[], hit: SearchHit): boolean {
  return ids.some(
    (f) =>
      (f.provider === hit.provider && f.externalId === hit.externalId) ||
      (f.provider === 'tmdb' && String(hit.tmdbId) === f.externalId) ||
      (f.provider === 'tvdb' && String(hit.tvdbId) === f.externalId) ||
      (f.provider === 'imdb' && hit.imdbId === f.externalId),
  );
}

/** Its search failed and its file can't identify it: linking now would add it unmatched. */
function unsearchable(vm: GroupVM): boolean {
  return vm.searchFailed && !vm.fromFile;
}

interface GroupVM {
  group: OrphanGroup;
  query: string;
  /** Books only: narrows the search. */
  author: string;
  year: number | null;
  results: SearchHit[];
  searching: boolean;
  searched: boolean;
  pick: SearchHit | null;
  /** The pick is the title a file id names, or none: the settle identifies it from the file. */
  fromFile: boolean;
  linking: boolean;
  done: boolean;
  /** The user chose the selected row: an import keeps it instead of choosing again. */
  chosen: boolean;
  /** Every provider failed: shown as no result, never linked unmatched from here. */
  searchFailed: boolean;
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
  protected readonly kinds = KIND_REGISTRY;
  private readonly importsApi = inject(ImportsApiService);
  private readonly metadata = inject(MetadataService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly sse = inject(SseService);

  /** Collect picks without linking — the library does not exist yet. */
  readonly deferLink = input(false);
  /** The scanned folder is outside the library: copy or move each title into it. */
  readonly transfer = input<TransferMethod | null>(null);
  /** The remaining groups were handed to the server, which imports them in the background. */
  readonly queued = output<void>();

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
  protected readonly groupLabelKeys: Record<MediaType, string> = {
    movie: 'settings.libraries.scan_group_movie',
    series: 'settings.libraries.scan_group_series',
    book: 'kinds.book',
    comic: 'kinds.comic',
    album: 'kinds.album',
  };
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
    // A click that ends a text selection in the title is not a toggle.
    if (document.getSelection()?.isCollapsed === false) return;
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
          author: group.guessAuthors?.[0] ?? '',
          year: group.guessYear,
          results: [],
          searching: false,
          searched: false,
          pick: null,
          fromFile: identifiesFromFile(group),
          linking: false,
          done: false,
          chosen: false,
          searchFailed: false,
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
    const generation = this.scanGeneration;
    const unsearched = indices.filter((i) => !this.groups()[i].searched);
    for (let s = 0; s < unsearched.length; s += SEARCH_CONCURRENCY) {
      if (generation !== this.scanGeneration) return;
      await Promise.all(
        unsearched.slice(s, s + SEARCH_CONCURRENCY).map((i) => this.search(i)),
      );
    }
  }

  /** Hands every remaining group to the server batch without searching here; returns how many. */
  importAll(libraryId: number): Promise<number> {
    return this.queueAll(libraryId);
  }

  private relinkBody(
    libraryId: number,
    vm: GroupVM,
    pick: Pick<SearchHit, 'externalId' | 'provider'> | null,
  ): RelinkOrphansBody {
    const group = vm.group;
    return {
      libraryId,
      type: group.mediaType,
      ...(pick
        ? {
            externalId: pick.externalId,
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
      folderId: group.folderId,
      files: KIND_REGISTRY[group.mediaType].hasSeasons ? undefined : group.files.map((f) => ({
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
    const { status, statusText } = (err ?? {}) as { status?: number; statusText?: string };
    if (status) return `${message} (HTTP ${status})`;
    if (statusText) return `${message} (${statusText})`;
    return err instanceof Error ? `${message} (${err.message})` : message;
  }

  private patch(index: number, partial: Partial<GroupVM>) {
    this.groups.update((list) =>
      list.map((g, i) => (i === index ? { ...g, ...partial } : g)),
    );
  }

  /** The results and pick belong to the old name: the group needs a new search. */
  edit(index: number, partial: Partial<Pick<GroupVM, 'query' | 'author' | 'year'>>) {
    this.latestSearch.delete(index);
    this.patch(index, {
      ...partial,
      results: [],
      pick: null,
      fromFile: identifiesFromFile(this.groups()[index].group),
      chosen: false,
      searchFailed: false,
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
    this.patch(index, { searching: true, searchFailed: false, error: '' });
    // A reply from a scan a newer `load()` replaced must not patch the new groups.
    const stale = () => generation !== this.scanGeneration || this.latestSearch.get(index) !== seq;
    try {
      const provider = vm.group.suggestedProvider;
      const author = vm.group.mediaType === 'book' ? vm.author.trim() || undefined : undefined;
      const results = await this.metadata.search(vm.group.mediaType, query, { year: vm.year ?? undefined, provider, author });
      if (stale()) return;

      // Auto-select the match a file id names; a book is identified from its file.
      const auto = results.find((r) => namesHit(vm.group.fileIds, r));
      const fromFile = !!auto || identifiesFromFile(vm.group);
      // The row the user sees selected is the row an import uses.
      this.patch(index, {
        results,
        searching: false,
        searched: true,
        pick: auto ?? (fromFile ? null : (results[0] ?? null)),
        fromFile,
        chosen: false,
      });
    } catch (err: unknown) {
      if (stale()) return;
      this.failure(`search "${query}"`, err);
      this.patch(index, {
        results: [],
        pick: null,
        chosen: false,
        searching: false,
        searched: true,
        searchFailed: true,
      });
    }
  }

  readonly key = searchResultKey;
  protected readonly bookFileId = bookFileId;

  /** The cover the group's first file carries, if it has one. */
  protected bookCover(group: OrphanGroup): string {
    return `/api/imports/orphans/cover?path=${encodeURIComponent(group.files[0].filePath)}`;
  }

  isPicked(pick: SearchHit | null, result: SearchHit): boolean {
    return !!pick && searchResultKey(pick) === searchResultKey(result);
  }

  pick(index: number, result: SearchHit) {
    const current = this.groups()[index]?.pick ?? null;
    const same = this.isPicked(current, result);
    this.patch(index, { pick: same ? null : result, fromFile: false, chosen: true });
  }

  /** The "add as is" pseudo-option: always sets an unmatched pick, no toggle. */
  pickUnmatched(index: number) {
    this.patch(index, {
      pick: null,
      fromFile: identifiesFromFile(this.groups()[index].group),
      chosen: true,
    });
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

  /** The number of files linked; `quiet` leaves the toast to the caller. */
  async link(index: number, quiet = false): Promise<number> {
    const vm = this.groups()[index];
    if (!vm || vm.linking || vm.done) return 0;
    // A reply from a link a newer `load()` replaced must not patch the new groups.
    const generation = this.scanGeneration;
    this.patch(index, { linking: true, error: '' });
    try {
      const res = await this.importsApi.relinkOrphans(
        this.relinkBody(this.libraryId, vm, vm.pick),
      );
      // The server linked it either way: the library still needs its refresh.
      if (res.linked > 0) this.anyLinked.set(true);
      if (generation !== this.scanGeneration) return res.linked;
      if (res.linked > 0) {
        this.patch(index, { linking: false, done: true });
        if (!quiet) this.toastLinked(res.linked);
      } else if (res.alreadyPresent > 0 && !res.errors.length) {
        // Every file already sits at its destination: a no-op re-run, not a failure.
        this.patch(index, { linking: false, done: true });
        if (!quiet) this.toast.info(
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
      return res.linked;
    } catch (err: unknown) {
      if (generation !== this.scanGeneration) return 0;
      this.patch(index, {
        linking: false,
        error: this.failure(`link "${vm.group.folderName}"`, err),
      });
      return 0;
    }
  }

  private toastLinked(count: number) {
    this.toast.success(
      this.translate.instant(
        this.transfer() ? 'import_disk.imported' : 'settings.libraries.scan_linked',
        { count },
      ),
    );
  }

  async linkAll() {
    const generation = this.scanGeneration;
    const indices = this.groups()
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => !g.done && !g.linking)
      .map(({ i }) => i);
    await this.searchBatched(indices);
    let linked = 0;
    for (const i of indices) {
      // Indices point into this scan's groups, not a newer one's.
      if (generation !== this.scanGeneration) return;
      if (this.groups()[i].error || unsearchable(this.groups()[i])) continue;
      linked += await this.link(i, true);
    }
    if (linked > 0) this.toastLinked(linked);
  }

  async autoImportAll() {
    if (this.autoImporting()) return;
    this.autoImporting.set(true);
    try {
      const count = await this.queueAll(this.libraryId);
      if (!count) return;
      this.toast.info(this.translate.instant('settings.libraries.scan_auto_queued', { count }));
      this.queued.emit();
    } catch (err: unknown) {
      this.toast.error(this.failure('auto import', err));
    } finally {
      this.autoImporting.set(false);
    }
  }

  /** One server batch for every group not linked yet: the row shown selected, the file's id or the
   *  book's file decide; a group never searched is searched by the server, which takes its best hit. */
  private async queueAll(libraryId: number): Promise<number> {
    const queued = this.groups()
      .map((vm, i) => ({ vm, i }))
      .filter(({ vm }) => !vm.done && !vm.linking);
    if (!queued.length) return 0;
    await this.importsApi.relinkOrphansBatch(queued.map(({ vm }) => this.batchBody(libraryId, vm)));
    this.anyLinked.set(true);
    for (const { i } of queued) this.patch(i, { done: true });
    return queued.length;
  }

  private batchBody(libraryId: number, vm: GroupVM): RelinkOrphansBody {
    if (vm.chosen || vm.fromFile || vm.pick) return this.relinkBody(libraryId, vm, vm.pick);
    const fileId = vm.group.fileIds.find((f) => f.provider === vm.group.suggestedProvider);
    if (fileId) return this.relinkBody(libraryId, vm, fileId);
    return {
      ...this.relinkBody(libraryId, vm, null),
      provider: vm.group.suggestedProvider,
      auto: true,
      reorganize: vm.group.folderName !== '' ? this.reorganize() : false,
    };
  }
}

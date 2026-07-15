import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UpperCasePipe } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideChevronsDownUp, LucideChevronsUpDown } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../../../core/pipes/resolve-url.pipe';
import { ToastService } from '../../../../../core/services/toast.service';
import {
  MetadataService,
  MetadataSearchResult,
} from '../../../../../core/services/api/metadata.service';
import {
  ImportsApiService,
  OrphanGroup,
} from '../../../../../core/services/api/imports-api.service';
import { ModalHeaderComponent } from '../../../../../shared/components/modal-header';

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
  selector: 'app-orphan-scan-modal',
  imports: [
    FormsModule,
    UpperCasePipe,
    TranslateModule,
    ResolveUrlPipe,
    LucideChevronsDownUp,
    LucideChevronsUpDown,
    ModalHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './orphan-scan-modal.html',
})
export class OrphanScanModalComponent {
  private readonly importsApi = inject(ImportsApiService);
  private readonly metadata = inject(MetadataService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly linked = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  private libraryId = 0;
  private anyLinked = false;

  readonly scanning = signal(false);
  readonly scanError = signal('');
  readonly scannedFiles = signal(0);
  readonly orphanCount = signal(0);
  readonly looseCount = signal(0);
  readonly groups = signal<GroupVM[]>([]);

  readonly autoImporting = signal(false);
  /** Move + rename files into the naming layout instead of linking in place. */
  readonly reorganize = signal(true);

  readonly pendingGroups = computed(() =>
    this.groups().filter((g) => !g.done && g.pick && !g.linking),
  );

  readonly hasLinkable = computed(() =>
    this.groups().some((g) => !g.done),
  );

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

  async open(libraryId: number) {
    this.libraryId = libraryId;
    this.anyLinked = false;
    this.scanError.set('');
    this.groups.set([]);
    this.scannedFiles.set(0);
    this.orphanCount.set(0);
    this.looseCount.set(0);
    this.dialogEl()?.nativeElement.showModal();

    this.scanning.set(true);
    try {
      const res = await this.importsApi.scanOrphans(libraryId);
      this.scannedFiles.set(res.scannedFiles);
      this.orphanCount.set(res.orphanCount);
      this.looseCount.set(res.looseFiles.length);
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
      // Kick off an initial search for every group so the admin can pick fast.
      await Promise.all(this.groups().map((_, i) => this.search(i)));
    } catch {
      this.scanError.set(this.translate.instant('settings.libraries.scan_error'));
    } finally {
      this.scanning.set(false);
    }
  }

  close() {
    this.dialogEl()?.nativeElement.close();
    if (this.anyLinked) this.linked.emit();
  }

  private patch(index: number, partial: Partial<GroupVM>) {
    this.groups.update((list) =>
      list.map((g, i) => (i === index ? { ...g, ...partial } : g)),
    );
  }

  async search(index: number) {
    const vm = this.groups()[index];
    if (!vm) return;
    const query = vm.query.trim();
    if (!query) return;
    this.patch(index, { searching: true, error: '' });
    try {
      const provider = vm.group.suggestedProvider;
      const results =
        vm.group.mediaType === 'series'
          ? await this.metadata.searchTv(query, vm.year ?? undefined, provider)
          : await this.metadata.searchMovie(query, vm.year ?? undefined, provider);

      // Auto-select the match referenced by the .nfo id, if any.
      const nfo = vm.group.nfo;
      const auto = nfo
        ? results.find(
            (r) =>
              (nfo.tmdbId != null && r.tmdbId === nfo.tmdbId) ||
              (nfo.tvdbId != null && r.tvdbId === nfo.tvdbId),
          )
        : undefined;
      this.patch(index, {
        results,
        searching: false,
        searched: true,
        pick: auto ?? null,
        fromNfo: !!auto,
      });
    } catch {
      this.patch(index, {
        searching: false,
        searched: true,
        error: this.translate.instant('settings.libraries.scan_error'),
      });
    }
  }

  pick(index: number, result: MetadataSearchResult) {
    this.patch(index, { pick: result, fromNfo: false });
  }

  async link(index: number) {
    const vm = this.groups()[index];
    if (!vm?.pick || vm.linking || vm.done) return;
    const pick = vm.pick;
    this.patch(index, { linking: true, error: '' });
    try {
      const externalId =
        pick.provider === 'tvdb' && pick.tvdbId != null
          ? String(pick.tvdbId)
          : String(pick.tmdbId);
      const res = await this.importsApi.relinkOrphans({
        libraryId: this.libraryId,
        type: vm.group.mediaType,
        externalId,
        provider: pick.provider,
        folderName: vm.group.folderName,
        reorganize: this.reorganize(),
        files: vm.group.files.map((f) => ({
          filePath: f.filePath,
          seasonNumber: f.seasonNumber ?? undefined,
          episodeNumber: f.episodeNumber ?? undefined,
          episodeEnd: f.episodeEnd ?? undefined,
        })),
      });
      if (res.linked > 0) {
        this.anyLinked = true;
        this.patch(index, { linking: false, done: true });
        this.toast.success(
          this.translate.instant('settings.libraries.scan_linked', {
            count: res.linked,
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
      const httpErr = err as { error?: { message?: string } };
      this.patch(index, {
        linking: false,
        error:
          httpErr.error?.message ??
          this.translate.instant('settings.libraries.scan_error'),
      });
    }
  }

  async linkAll() {
    const indices = this.groups()
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => !g.done && g.pick && !g.linking)
      .map(({ i }) => i);
    for (const i of indices) {
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
      // Each group resolves independently — search, pick, link run
      // concurrently so the whole batch isn't gated on the slowest item.
      await Promise.all(this.groups().map((_, i) => this.autoLinkOne(i)));
    } finally {
      this.autoImporting.set(false);
    }
  }

  private async autoLinkOne(index: number) {
    const vm = this.groups()[index];
    if (vm.done || vm.linking) return;
    if (!vm.searched) await this.search(index);
    const best = this.bestMatch(this.groups()[index]);
    if (!best) return;
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

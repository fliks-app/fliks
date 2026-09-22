import { Component, ElementRef, OnInit, inject, signal, computed, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ToastService } from '../../../../core/services/toast.service';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import {
  LiveTvApiService,
  AdminChannel,
  AdminSource,
  BulkChannelSelection,
} from '../../../../core/services/api/livetv-api.service';
import { PaginationComponent } from '../../../../shared/components/pagination/pagination';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { EnabledSwitchComponent } from '../../../../shared/components/enabled-switch';

const PAGE_SIZE = 25;
/** Above this row count, a bulk-by-filter action asks for confirmation first. */
const BULK_CONFIRM_THRESHOLD = 50;
/** One request big enough to cover a real lineup for duplicate detection. */
const DUPLICATE_SCAN_PAGE_SIZE = 2000;

interface DuplicateGroup {
  key: string;
  rows: AdminChannel[];
}

/** Case/diacritics/punctuation-insensitive key so "CNN HD" and "CNN-HD" group together. */
function normalizeChannelName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

@Component({
  selector: 'app-live-tv-channels',
  imports: [
    FormsModule,
    TranslatePipe,
    PaginationComponent,
    ModalHeaderComponent,
    ModalFooterComponent,
    TvSelectDirective,
    EnabledSwitchComponent,
  ],
  templateUrl: './live-tv-channels.html',
})
export class LiveTvChannelsComponent implements OnInit {
  private readonly api = inject(LiveTvApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');
  private readonly mergeDialog = viewChild<ElementRef<HTMLDialogElement>>('mergeDialog');

  readonly sources = signal<AdminSource[]>([]);
  readonly rows = signal<AdminChannel[]>([]);
  readonly groups = signal<{ name: string; count: number }[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / PAGE_SIZE)));
  readonly loading = signal(true);

  readonly query = signal('');
  readonly groupFilter = signal('');
  readonly sourceFilter = signal<number | null>(null);
  readonly enabledFilter = signal<'' | 'true' | 'false'>('');

  readonly selectedIds = signal<ReadonlySet<number>>(new Set());
  readonly togglingId = signal<number | null>(null);
  readonly bulkBusy = signal(false);
  readonly bulkScope = signal<'selection' | 'all'>('selection');
  readonly bulkGroupName = signal('');
  readonly bulkStartNumber = signal<number | null>(null);
  readonly mergeTargetId = signal<number | null>(null);
  readonly mergeCandidates = signal<AdminChannel[]>([]);
  /** Set when the merge dialog was opened from a duplicate group, so a
   *  successful merge can drop that group from the list without a re-scan. */
  private mergingDuplicateKey: string | null = null;

  readonly allSelected = computed(() => this.rows().length > 0 && this.rows().every((r) => this.selectedIds().has(r.id)));
  readonly selectedRows = computed(() => this.rows().filter((r) => this.selectedIds().has(r.id)));
  /** The active/inactive filter has no equivalent in the bulk selection DTO. */
  readonly bulkAllDisabled = computed(() => this.enabledFilter() !== '');
  readonly bulkTargetCount = computed(() => (this.bulkScope() === 'all' ? this.total() : this.selectedRows().length));
  readonly showBulkBar = computed(() => this.selectedRows().length > 0 || this.bulkScope() === 'all');

  readonly editingRow = signal<AdminChannel | null>(null);
  readonly editName = signal('');
  readonly editNumber = signal(0);
  readonly editGroup = signal('');
  readonly editEnabled = signal(true);
  readonly editGuideId = signal('');
  readonly editShiftMinutes = signal(0);
  readonly saving = signal(false);

  readonly duplicatesLoading = signal(false);
  readonly showDuplicates = signal(false);
  readonly duplicateGroups = signal<DuplicateGroup[]>([]);

  ngOnInit(): void {
    void this.api.listSources().then((s) => this.sources.set(s)).catch(() => {});
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await this.api.listAdminChannels({
        sourceId: this.sourceFilter() ?? undefined,
        group: this.groupFilter() || undefined,
        enabled: this.enabledFilter() === '' ? undefined : this.enabledFilter() === 'true',
        query: this.query() || undefined,
        page: this.page(),
        pageSize: PAGE_SIZE,
      });
      // Defaulted: a payload missing a list must not take the whole page down
      // through the computeds that read it.
      this.rows.set(res.items ?? []);
      this.total.set(res.total ?? 0);
      this.groups.set(res.groups ?? []);
    } catch {
      // handled by the global error interceptor
    } finally {
      this.loading.set(false);
    }
  }

  onFilterChange(): void {
    this.page.set(1);
    this.clearSelection();
    void this.load();
  }

  onGroupPick(name: string): void {
    this.groupFilter.set(this.groupFilter() === name ? '' : name);
    this.onFilterChange();
  }

  async goToPage(page: number): Promise<void> {
    if (page < 1 || page > this.totalPages()) return;
    this.page.set(page);
    this.clearSelection();
    await this.load();
  }

  toggleSelected(id: number): void {
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  toggleAllSelected(): void {
    const all = this.allSelected();
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      for (const row of this.rows()) {
        if (all) next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
    this.bulkScope.set('selection');
  }

  /** Reveals the bulk bar in "all matching filters" scope without picking any row. */
  bulkByFilter(): void {
    if (this.bulkAllDisabled() || this.total() === 0) return;
    this.bulkScope.set('all');
  }

  private buildSelection(): BulkChannelSelection {
    if (this.bulkScope() === 'all') {
      return {
        group: this.groupFilter() || undefined,
        sourceId: this.sourceFilter() ?? undefined,
        namePattern: this.query() || undefined,
      };
    }
    return { channelIds: [...this.selectedIds()] };
  }

  private async runBulk(patch: { enabled?: boolean; groupName?: string; startNumber?: number }): Promise<void> {
    const count = this.bulkTargetCount();
    if (count === 0) return;
    if (count > BULK_CONFIRM_THRESHOLD) {
      const ok = await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('liveTv.admin.channels.bulk_confirm_large', { count }),
        variant: 'warning',
      });
      if (!ok) return;
    }
    this.bulkBusy.set(true);
    try {
      await this.api.bulkUpdateChannels({ selection: this.buildSelection(), ...patch });
      this.toast.success(this.translate.instant('bulk.done', { count }));
      this.clearSelection();
      await this.load();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.bulkBusy.set(false);
    }
  }

  bulkEnable(): void {
    void this.runBulk({ enabled: true });
  }

  bulkDisable(): void {
    void this.runBulk({ enabled: false });
  }

  applyBulkGroup(): void {
    const name = this.bulkGroupName().trim();
    if (!name) return;
    void this.runBulk({ groupName: name });
  }

  applyBulkRenumber(): void {
    const start = this.bulkStartNumber();
    if (start == null) return;
    void this.runBulk({ startNumber: start });
  }

  openMerge(): void {
    const rows = this.selectedRows();
    if (rows.length < 2) return;
    this.mergingDuplicateKey = null;
    this.mergeCandidates.set(rows);
    this.mergeTargetId.set(rows[0].id);
    this.mergeDialog()?.nativeElement.showModal();
  }

  openMergeFor(group: DuplicateGroup): void {
    if (group.rows.length < 2) return;
    this.mergingDuplicateKey = group.key;
    this.mergeCandidates.set(group.rows);
    this.mergeTargetId.set(group.rows[0].id);
    this.mergeDialog()?.nativeElement.showModal();
  }

  closeMerge(): void {
    this.mergeDialog()?.nativeElement.close();
  }

  async confirmMerge(): Promise<void> {
    const targetId = this.mergeTargetId();
    const rows = this.mergeCandidates();
    if (targetId == null || rows.length < 2) return;
    const sourceIds = rows.map((r) => r.id).filter((id) => id !== targetId);
    this.bulkBusy.set(true);
    try {
      await this.api.mergeChannels({ targetChannelId: targetId, sourceChannelIds: sourceIds });
      this.toast.success(this.translate.instant('liveTv.admin.channels.merged_toast'));
      this.closeMerge();
      this.clearSelection();
      if (this.mergingDuplicateKey) {
        const key = this.mergingDuplicateKey;
        this.duplicateGroups.update((groups) => groups.filter((g) => g.key !== key));
        this.mergingDuplicateKey = null;
      }
      await this.load();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.bulkBusy.set(false);
    }
  }

  async loadDuplicates(): Promise<void> {
    this.showDuplicates.set(true);
    this.duplicatesLoading.set(true);
    try {
      const res = await this.api.listAdminChannels({
        enabled: true,
        page: 1,
        pageSize: DUPLICATE_SCAN_PAGE_SIZE,
      });
      const byKey = new Map<string, AdminChannel[]>();
      for (const row of res.items ?? []) {
        const key = normalizeChannelName(row.name);
        if (!key) continue;
        const bucket = byKey.get(key);
        if (bucket) bucket.push(row);
        else byKey.set(key, [row]);
      }
      this.duplicateGroups.set(
        [...byKey.entries()]
          .filter(([, rows]) => rows.length >= 2)
          .map(([key, rows]) => ({ key, rows }))
          .sort((a, b) => b.rows.length - a.rows.length),
      );
    } catch {
      // handled by the global error interceptor
    } finally {
      this.duplicatesLoading.set(false);
    }
  }

  async toggleEnabled(row: AdminChannel): Promise<void> {
    this.togglingId.set(row.id);
    try {
      await this.api.updateChannel(row.id, { enabled: !row.enabled });
      await this.load();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.togglingId.set(null);
    }
  }

  openEdit(row: AdminChannel): void {
    this.editingRow.set(row);
    this.editName.set(row.name);
    this.editNumber.set(row.number);
    this.editGroup.set(row.groupName ?? '');
    this.editEnabled.set(row.enabled);
    this.editGuideId.set(row.guideChannelId ?? '');
    this.editShiftMinutes.set(row.guideShiftMinutes);
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor(): void {
    this.editorDialog()?.nativeElement.close();
  }

  async saveEdit(): Promise<void> {
    const row = this.editingRow();
    if (!row) return;
    this.saving.set(true);
    try {
      await this.api.updateChannel(row.id, {
        name: this.editName().trim(),
        number: this.editNumber(),
        groupName: this.editGroup().trim() || undefined,
        enabled: this.editEnabled(),
        guideChannelId: this.editGuideId().trim() || undefined,
        guideShiftMinutes: this.editShiftMinutes(),
      });
      this.closeEditor();
      await this.load();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  matchLabel(kind: AdminChannel['guideMatchKind']): string {
    switch (kind) {
      case 'id': return this.translate.instant('liveTv.admin.channels.match_id');
      case 'name': return this.translate.instant('liveTv.admin.channels.match_name');
      case 'fuzzy': return this.translate.instant('liveTv.admin.channels.match_fuzzy');
      case 'manual': return this.translate.instant('liveTv.admin.channels.match_manual');
      default: return this.translate.instant('liveTv.admin.channels.match_none');
    }
  }
}

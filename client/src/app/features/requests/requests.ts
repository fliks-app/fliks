import {
  Component,
  signal,
  inject,
  computed,
  effect,
  OnInit,
  OnDestroy,
  viewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { TvSelectDirective } from '../../shared/directives/tv-select.directive';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import {
  RequestsService,
  FliksRequestRow,
  FliksRequestStatus,
  RequestKind,
} from '../../core/services/api/requests.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import {
  LibrariesApiService,
  LibrarySummary,
} from '../../core/services/api/libraries-api.service';
import { ToastService } from '../../core/services/toast.service';
import { AppResumeService } from '../../core/services/app-resume.service';
import { RequestPosterComponent } from './request-poster';
import { RequestDeclineModalComponent } from './request-decline-modal/request-decline-modal.component';
import { RequestViewDeclineModalComponent } from './request-view-decline-modal/request-view-decline-modal.component';
import { RequestEditModalComponent } from './request-edit-modal/request-edit-modal.component';
import { RequestDeclineFlow, RequestEditFlow } from './request-flows';
import { DropdownMenuComponent } from '../../shared/components/dropdown-menu';
import { SseService } from '../../core/services/sse.service';
import {
  DownloadProgressService,
  MediaDownloadProgress,
} from '../../core/services/download-progress.service';
import { RequestStatusBadgeComponent } from './request-status-badge/request-status-badge.component';
import { DownloadDetailModalComponent } from '../../shared/components/download-detail-modal/download-detail-modal';
import { LucideEllipsisVertical, LucidePencil, LucideTrash2 } from '@lucide/angular';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';
import { KIND_REGISTRY } from '../../core/media-kinds';

@Component({
  selector: 'app-requests',
  imports: [TvSelectDirective, 
    FormsModule,
    LocaleDatePipe,
    TranslatePipe,
    RouterLink,
    RequestPosterComponent,
    RequestDeclineModalComponent,
    RequestViewDeclineModalComponent,
    RequestEditModalComponent,
    DropdownMenuComponent,
    RequestStatusBadgeComponent,
    DownloadDetailModalComponent,
    LucideEllipsisVertical,
    LucidePencil,
    LucideTrash2,
  ],
  templateUrl: './requests.html',
})
export class RequestsComponent implements OnInit, OnDestroy {
  protected readonly kinds = KIND_REGISTRY;
  private readonly requestsService = inject(RequestsService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly appResume = inject(AppResumeService);
  private readonly sse = inject(SseService);
  private readonly downloadProgress = inject(DownloadProgressService);
  readonly auth = inject(AuthService);
  private resumeSub?: Subscription;

  /** When a download finishes, refetch so a monitored request flips to its
   *  downloaded state and the progress badge clears. */
  private readonly importEffect = effect(() => {
    const ev = this.sse.lastEvent();
    if (ev?.type === 'import.complete') void this.refreshStatuses();
  });

  private readonly declineModal = viewChild(RequestDeclineModalComponent);
  private readonly viewDeclineModal = viewChild(RequestViewDeclineModalComponent);
  private readonly editModal = viewChild(RequestEditModalComponent);
  private readonly detailModal = viewChild(DownloadDetailModalComponent);

  /** Media whose download-detail modal is open; its live progress is fed in. */
  readonly detailMediaId = signal<number | null>(null);
  readonly detailProgress = computed<MediaDownloadProgress | null>(() => {
    const id = this.detailMediaId();
    return id != null ? (this.downloadProgress.progress().get(id) ?? null) : null;
  });

  readonly rows = signal<FliksRequestRow[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly statusFilter = signal<FliksRequestStatus | ''>('');
  readonly kindFilter = signal<RequestKind | ''>('');
  /** Read-only modal: motif affiché après un refus. */
  readonly viewDeclineReasonModal = signal<{
    mediaTitle: string;
    reason: string;
  } | null>(null);
  readonly actionBusyId = signal<number | null>(null);

  // Edit modal
  readonly qualityProfiles = signal<{ id: number; name: string }[]>([]);
  readonly languageProfiles = signal<{ id: number; name: string }[]>([]);
  /** Libraries the caller can target — used by the edit modal's picker. */
  readonly libraries = signal<LibrarySummary[]>([]);

  readonly decline = new RequestDeclineFlow(() => this.declineModal());
  readonly edit = new RequestEditFlow(() => this.editModal(), () => this.libraries());

  private page = 1;

  readonly canLoadMore = computed(
    () => this.total() > this.rows().length,
  );

  async ngOnInit() {
    this.reload();
    // Native app-resume: this page only exists while it's the visible route
    // (no route reuse), so an unguarded reload is always the on-screen one.
    this.resumeSub = this.appResume.resume$.subscribe(() => {
      this.reload();
    });
    try {
      const [qp, lp, libs] = await Promise.all([
        this.profilesApi.getQualityProfiles(),
        this.profilesApi.getLanguageProfiles(),
        this.librariesApi.listMine(),
      ]);
      this.qualityProfiles.set(qp.map((p) => ({ id: p.id, name: p.name })));
      this.languageProfiles.set(lp.map((p) => ({ id: p.id, name: p.name })));
      this.libraries.set(libs);
    } catch { /* profiles optional */ }
  }

  ngOnDestroy() {
    this.resumeSub?.unsubscribe();
  }

  onStatusChange(value: string) {
    this.statusFilter.set(value as FliksRequestStatus | '');
    this.reload();
  }

  onKindChange(value: string) {
    this.kindFilter.set(value as RequestKind | '');
    this.reload();
  }

  loadMore() {
    this.page++;
    this.fetch(true);
  }

  reload() {
    this.page = 1;
    this.rows.set([]);
    this.fetch(false);
  }

  private async fetch(append: boolean, force = false) {
    this.loading.set(true);
    const status = this.statusFilter();
    const kind = this.kindFilter();
    try {
      const res = await this.requestsService.list(
        {
          page: this.page,
          limit: 25,
          ...(status ? { status } : {}),
          ...(kind ? { kind } : {}),
        },
        { force },
      );
      this.rows.update((prev) =>
        append ? [...prev, ...res.data] : res.data,
      );
      this.total.set(res.total);
    } finally {
      this.loading.set(false);
    }
  }

  /** Force-refetches the loaded rows so backend status transitions surface, preserving the loaded page depth. */
  private async refreshStatuses(): Promise<void> {
    const status = this.statusFilter();
    const kind = this.kindFilter();
    const limit = Math.max(25, this.rows().length);
    try {
      const res = await this.requestsService.list(
        { page: 1, limit, ...(status ? { status } : {}), ...(kind ? { kind } : {}) },
        { force: true },
      );
      this.rows.set(res.data);
      this.total.set(res.total);
      this.page = Math.max(1, Math.ceil(res.data.length / 25));
    } catch {
      /* ignore — next reload/resume refreshes */
    }
  }

  canCancel(row: FliksRequestRow): boolean {
    if (row.status !== 'pending') return false;
    const u = this.auth.user();
    if (!u) return false;
    // `row.user.id` is always populated by the join; the `@RelationId` `row.userId` can be missing depending on serialization.
    const ownerId = row.user?.id ?? row.userId;
    return ownerId === u.id;
  }

  /** Manager or owner of the pending request (same as `canCancel`); deletion requests carry no profiles, so nothing to edit. */
  canEdit(row: FliksRequestRow): boolean {
    if (row.kind === 'delete') return false;
    if (this.auth.hasPermission('requests.manage')) return true;
    return this.canCancel(row);
  }

  /** Colonne d’actions : supprimer seul (hors pending / refus avec motif gérés ailleurs). */
  showOrphanDeleteColumn(row: FliksRequestRow): boolean {
    if (!this.auth.hasPermission('requests.manage')) return false;
    if (row.status === 'pending') return false;
    if (row.status === 'declined' && row.declinedReason?.trim()) return false;
    return true;
  }

  /** Admin (or pending owner) can hard-delete the request. Distinct from
   *  `canCancel`, which is the owner-on-a-pending wording used in the UI. */
  canDeleteRequest(row: FliksRequestRow): boolean {
    return this.auth.hasPermission('requests.manage');
  }

  /** Whether the mobile kebab dropdown should render at all — hide it
   *  entirely on rows where no actionable item would appear. */
  mobileActionsAvailable(row: FliksRequestRow): boolean {
    return (
      this.canEdit(row) ||
      this.canDeleteRequest(row) ||
      this.canCancel(row)
    );
  }

  openViewDeclineReason(row: FliksRequestRow) {
    const reason = row.declinedReason?.trim();
    if (row.status !== 'declined' || !reason) return;
    this.viewDeclineReasonModal.set({ mediaTitle: row.title, reason });
    this.viewDeclineModal()?.showModal();
  }

  closeViewDeclineReason() {
    this.viewDeclineModal()?.close();
    this.viewDeclineReasonModal.set(null);
  }

  async submitDecline() {
    const id = this.decline.forId();
    if (id == null) return;
    this.actionBusyId.set(id);
    try {
      const updated = await this.requestsService.decline(id, this.decline.reasonText());
      this.patchRow(updated);
      this.decline.close();
    } finally {
      this.actionBusyId.set(null);
    }
  }

  async approve(id: number) {
    this.actionBusyId.set(id);
    try {
      const updated = await this.requestsService.approve(id);
      this.patchRow(updated);
    } finally {
      this.actionBusyId.set(null);
    }
  }

  async removeRequest(row: FliksRequestRow) {
    const manage = this.auth.hasPermission('requests.manage');
    const message = manage
      ? this.translate.instant('requests.confirm_delete')
      : this.translate.instant('requests.confirm_cancel');
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message,
        variant: 'danger',
      }))
    ) {
      return;
    }
    const id = row.id;
    this.actionBusyId.set(id);
    try {
      await this.requestsService.remove(id);
      this.rows.update((list) => list.filter((r) => r.id !== id));
      this.total.update((t) => Math.max(0, t - 1));
      this.toast.success(this.translate.instant('requests.delete_success'));
    } finally {
      this.actionBusyId.set(null);
    }
  }

  async saveEdit() {
    const row = this.edit.row();
    if (!row) return;
    this.edit.saving.set(true);
    try {
      const updated = await this.requestsService.update(row.id, this.edit.changes(row));
      this.patchRow(updated);
      this.toast.success(this.translate.instant('requests.edit_success'));
      this.edit.close();
    } catch {
      // error toast handled by interceptor
    } finally {
      this.edit.saving.set(false);
    }
  }

  private patchRow(updated: FliksRequestRow) {
    this.rows.update((list) =>
      list.map((r) => (r.id === updated.id ? updated : r)),
    );
  }

  mediaLink(row: FliksRequestRow): (string | number)[] {
    // `row.media` is resolved by (tmdbId, type), so it exists even when the request's `mediaId` FK is still null.
    const libraryId = row.media?.id;
    if (libraryId) {
      return ['/' + KIND_REGISTRY[row.mediaType].segment, libraryId];
    }
    return ['/add', KIND_REGISTRY[row.mediaType].providerSegment, row.tmdbId];
  }


  qualityProfileDisplay(id: number | null): string {
    if (id == null) return '-';
    return this.qualityProfiles().find((p) => p.id === id)?.name ?? `#${id}`;
  }

  languageProfileDisplay(id: number | null): string {
    if (id == null) return '-';
    return this.languageProfiles().find((p) => p.id === id)?.name ?? `#${id}`;
  }

  /** Open the download-detail modal for a request's media (badge click). */
  onBadgeClick(row: FliksRequestRow): void {
    const id = row.media?.id;
    if (id == null) return;
    this.detailMediaId.set(id);
    this.detailModal()?.open();
  }
}

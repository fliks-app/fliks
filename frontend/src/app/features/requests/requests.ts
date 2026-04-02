import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import {
  RequestsService,
  SuitarrRequestRow,
  SuitarrRequestStatus,
} from '../../core/services/api/requests.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { ToastService } from '../../core/services/toast.service';
import { RequestPosterComponent } from './request-poster';
import { RequestDeclineModalComponent } from './request-decline-modal/request-decline-modal.component';
import { RequestViewDeclineModalComponent } from './request-view-decline-modal/request-view-decline-modal.component';
import { RequestEditModalComponent } from './request-edit-modal/request-edit-modal.component';

@Component({
  selector: 'app-requests',
  imports: [
    FormsModule,
    DatePipe,
    TranslateModule,
    RouterLink,
    RequestPosterComponent,
    RequestDeclineModalComponent,
    RequestViewDeclineModalComponent,
    RequestEditModalComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './requests.html',
})
export class RequestsComponent implements OnInit {
  private readonly requestsService = inject(RequestsService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly rows = signal<SuitarrRequestRow[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly statusFilter = signal<SuitarrRequestStatus | ''>('');
  readonly declineForId = signal<number | null>(null);
  readonly declineReasonText = signal('');
  /** Read-only modal: motif affiché après un refus. */
  readonly viewDeclineReasonModal = signal<{
    mediaTitle: string;
    reason: string;
  } | null>(null);
  readonly actionBusyId = signal<number | null>(null);

  // Edit modal
  readonly qualityProfiles = signal<{ id: number; name: string }[]>([]);
  readonly languageProfiles = signal<{ id: number; name: string }[]>([]);
  readonly editingRequest = signal<SuitarrRequestRow | null>(null);
  readonly editQualityProfileId = signal<number | null>(null);
  readonly editLanguageProfileId = signal<number | null>(null);
  readonly editSaving = signal(false);

  private page = 1;

  readonly canLoadMore = computed(
    () => this.total() > this.rows().length,
  );

  async ngOnInit() {
    this.reload();
    try {
      const [qp, lp] = await Promise.all([
        this.profilesApi.getQualityProfiles(),
        this.profilesApi.getLanguageProfiles(),
      ]);
      this.qualityProfiles.set(qp.map((p) => ({ id: p.id, name: p.name })));
      this.languageProfiles.set(lp.map((p) => ({ id: p.id, name: p.name })));
    } catch { /* profiles optional */ }
  }

  onStatusChange(value: string) {
    this.statusFilter.set(value as SuitarrRequestStatus | '');
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

  private async fetch(append: boolean) {
    this.loading.set(true);
    const status = this.statusFilter();
    try {
      const res = await this.requestsService.list({
        page: this.page,
        limit: 25,
        ...(status ? { status } : {}),
      });
      this.rows.update((prev) =>
        append ? [...prev, ...res.data] : res.data,
      );
      this.total.set(res.total);
    } finally {
      this.loading.set(false);
    }
  }

  canCancel(row: SuitarrRequestRow): boolean {
    if (row.status !== 'pending') return false;
    const u = this.auth.user();
    return !!u && row.userId === u.id;
  }

  /** Colonne d’actions : supprimer seul (hors pending / refus avec motif gérés ailleurs). */
  showOrphanDeleteColumn(row: SuitarrRequestRow): boolean {
    if (!this.auth.hasPermission('requests.manage')) return false;
    if (row.status === 'pending') return false;
    if (row.status === 'declined' && row.declinedReason?.trim()) return false;
    return true;
  }

  openDecline(id: number) {
    this.declineForId.set(id);
    this.declineReasonText.set('');
  }

  closeDecline() {
    this.declineForId.set(null);
  }

  openViewDeclineReason(row: SuitarrRequestRow) {
    const reason = row.declinedReason?.trim();
    if (row.status !== 'declined' || !reason) return;
    this.viewDeclineReasonModal.set({ mediaTitle: row.title, reason });
  }

  closeViewDeclineReason() {
    this.viewDeclineReasonModal.set(null);
  }

  async submitDecline() {
    const id = this.declineForId();
    if (id == null) return;
    this.actionBusyId.set(id);
    try {
      const updated = await this.requestsService.decline(id, this.declineReasonText());
      this.patchRow(updated);
      this.closeDecline();
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

  async removeRequest(row: SuitarrRequestRow) {
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

  openEdit(row: SuitarrRequestRow) {
    this.editingRequest.set(row);
    this.editQualityProfileId.set(row.qualityProfileId);
    this.editLanguageProfileId.set(row.languageProfileId);
  }

  closeEdit() {
    this.editingRequest.set(null);
  }

  async saveEdit() {
    const row = this.editingRequest();
    if (!row) return;
    this.editSaving.set(true);
    try {
      const updated = await this.requestsService.update(row.id, {
        qualityProfileId: this.editQualityProfileId() ?? undefined,
        languageProfileId: this.editLanguageProfileId() ?? undefined,
      });
      this.patchRow(updated);
      this.toast.success(this.translate.instant('requests.edit_success'));
      this.closeEdit();
    } catch {
      // error toast handled by interceptor
    } finally {
      this.editSaving.set(false);
    }
  }

  private patchRow(updated: SuitarrRequestRow) {
    this.rows.update((list) =>
      list.map((r) => (r.id === updated.id ? updated : r)),
    );
  }

  mediaLink(row: SuitarrRequestRow): (string | number)[] {
    if (row.mediaId) {
      return row.mediaType === 'movie'
        ? ['/movies', row.mediaId]
        : ['/series', row.mediaId];
    }
    return row.mediaType === 'movie'
      ? ['/add', 'movie', row.tmdbId]
      : ['/add', 'tv', row.tmdbId];
  }

  statusBadgeClass(status: SuitarrRequestStatus): string {
    switch (status) {
      case 'pending':
        return 'badge-warning';
      case 'approved':
      case 'available':
        return 'badge-success';
      case 'declined':
      case 'failed':
        return 'badge-error';
      case 'processing':
        return 'badge-info';
      default:
        return 'badge-ghost';
    }
  }

  qualityProfileDisplay(id: number | null): string {
    if (id == null) return '—';
    return this.qualityProfiles().find((p) => p.id === id)?.name ?? `#${id}`;
  }

  languageProfileDisplay(id: number | null): string {
    if (id == null) return '—';
    return this.languageProfiles().find((p) => p.id === id)?.name ?? `#${id}`;
  }
}

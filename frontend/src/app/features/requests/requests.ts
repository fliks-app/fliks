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
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import {
  RequestsService,
  SuitarrRequestRow,
  SuitarrRequestStatus,
} from '../../core/services/api/requests.service';

@Component({
  selector: 'app-requests',
  imports: [FormsModule, DatePipe, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './requests.html',
})
export class RequestsComponent implements OnInit {
  private readonly requestsService = inject(RequestsService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  readonly auth = inject(AuthService);

  readonly rows = signal<SuitarrRequestRow[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly statusFilter = signal<SuitarrRequestStatus | ''>('');
  readonly declineForId = signal<number | null>(null);
  readonly declineReasonText = signal('');
  readonly actionBusyId = signal<number | null>(null);

  private page = 1;

  readonly canLoadMore = computed(
    () => this.total() > this.rows().length,
  );

  ngOnInit() {
    this.reload();
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

  openDecline(id: number) {
    this.declineForId.set(id);
    this.declineReasonText.set('');
  }

  closeDecline() {
    this.declineForId.set(null);
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

  async cancelRequest(row: SuitarrRequestRow) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('requests.confirm_cancel'), variant: 'danger' })) {
      return;
    }
    const id = row.id;
    this.actionBusyId.set(id);
    try {
      await this.requestsService.remove(id);
      this.rows.update((list) => list.filter((r) => r.id !== id));
      this.total.update((t) => Math.max(0, t - 1));
    } finally {
      this.actionBusyId.set(null);
    }
  }

  private patchRow(updated: SuitarrRequestRow) {
    this.rows.update((list) =>
      list.map((r) => (r.id === updated.id ? updated : r)),
    );
  }
}

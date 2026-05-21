import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  BlocklistApiService,
  BlocklistEntry,
} from '../../../core/services/api/blocklist-api.service';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';

@Component({
  selector: 'app-blocklist-settings',
  imports: [TranslateModule, DatePipe, PaginationComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './blocklist.html',
})
export class BlocklistSettingsComponent implements OnInit {
  private readonly api = inject(BlocklistApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly entries = signal<BlocklistEntry[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(true);
  readonly listError = signal('');

  ngOnInit() {
    this.load();
  }

  async load(page = 1) {
    this.loading.set(true);
    this.listError.set('');
    this.page.set(page);
    try {
      const res = await this.api.list(page, 20);
      this.entries.set(res.data);
      this.total.set(res.total);
    } catch {
      this.listError.set(this.translate.instant('settings.blocklist.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  async remove(entry: BlocklistEntry) {
    try {
      await this.api.remove(entry.id);
      await this.load(this.page());
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Error', variant: 'danger' });
    }
  }

  async clearAll() {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('settings.blocklist.confirm_clear'), variant: 'danger' })) return;
    try {
      await this.api.clear();
      await this.load(1);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Error', variant: 'danger' });
    }
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.total() / 20));
  }
}

import {
  Component, ChangeDetectionStrategy, signal, inject, OnInit,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';

@Component({
  selector: 'app-system-backups',
  imports: [TranslateModule, LocaleDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './backups.html',
})
export class SystemBackupsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly backups = signal<{ filename: string; size: number; date: string }[]>([]);
  readonly loading = signal(false);
  readonly creating = signal(false);

  ngOnInit() { this.load(); }

  async load() {
    this.loading.set(true);
    try {
      this.backups.set(await firstValueFrom(this.http.get<any[]>('/api/system/backups')));
    } finally { this.loading.set(false); }
  }

  async create() {
    this.creating.set(true);
    try {
      await firstValueFrom(this.http.post('/api/system/backup', {}));
      await this.load();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Backup failed', variant: 'danger' });
    } finally { this.creating.set(false); }
  }

  async restore(filename: string) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('system.confirm_restore'), variant: 'warning' })) return;
    try {
      await firstValueFrom(this.http.post('/api/system/restore', { filename }));
      void this.confirmation.alert({ title: this.translate.instant('common.success'), message: this.translate.instant('system.restore_ok'), variant: 'info' });
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Restore failed', variant: 'danger' });
    }
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
  }
}

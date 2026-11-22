import {
  Component, signal, inject, OnInit,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { formatBytes } from '../../../core/utils/format-bytes';
import { serverMessage } from '../../../core/utils/server-message';
import { waitForServer } from '../../../core/utils/wait-for-server';

interface NotRestored { schema: string; message: string; code?: string; }
interface RestoreResult { pluginsNotRestored: NotRestored[]; restarting: boolean; }

@Component({
  selector: 'app-system-backups',
  imports: [TranslatePipe, LocaleDatePipe],
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
      const made = await firstValueFrom(this.http.post<{ pluginsSkipped?: string[] }>('/api/system/backup', {}));
      await this.load();
      if (made.pluginsSkipped?.length) {
        void this.confirmation.alert({ title: this.translate.instant('system.create_backup'), message: this.translate.instant('system.backup_plugins_skipped', { plugins: made.pluginsSkipped.join(', ') }), variant: 'warning' });
      }
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? this.translate.instant('system.backup_failed'), variant: 'danger' });
    } finally { this.creating.set(false); }
  }

  async restore(filename: string) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('system.confirm_restore'), variant: 'warning' })) return;
    try {
      const result = await firstValueFrom(this.http.post<RestoreResult>('/api/system/restore', { filename }));
      const failed = result.pluginsNotRestored;
      if (failed.length) {
        const plugins = failed.map((p) => `${p.schema}: ${p.code ? this.translate.instant(`system.restore_${p.code}`) : p.message}`).join('; ');
        await this.confirmation.alert({ title: this.translate.instant('system.restore_backup'), message: this.translate.instant('system.restore_plugins_not_restored', { plugins }), variant: 'warning' });
      } else {
        void this.confirmation.alert({ title: this.translate.instant('common.success'), message: this.translate.instant(result.restarting ? 'system.restore_restarting' : 'system.restore_ok'), variant: 'info' });
      }
      if (result.restarting) {
        await waitForServer(this.http);
        location.reload();
      }
    } catch (err: unknown) {
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: serverMessage(err, this.translate, 'system.restore_failed'), variant: 'danger' });
    }
  }

  async remove(filename: string) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('system.confirm_delete_backup'), variant: 'danger' })) return;
    try {
      await firstValueFrom(this.http.delete(`/api/system/backups/${encodeURIComponent(filename)}`));
      await this.load();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? this.translate.instant('system.delete_backup_failed'), variant: 'danger' });
    }
  }

  protected readonly formatBytes = formatBytes;
}

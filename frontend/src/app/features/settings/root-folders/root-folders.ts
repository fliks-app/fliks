import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  RootFoldersApiService,
  RootFolder,
} from '../../../core/services/api/root-folders-api.service';

@Component({
  selector: 'app-root-folders-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './root-folders.html',
})
export class RootFoldersSettingsComponent implements OnInit {
  private readonly api = inject(RootFoldersApiService);
  private readonly translate = inject(TranslateService);

  readonly folders = signal<RootFolder[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly formOpen = signal(false);
  readonly formPath = signal('');
  readonly formLabel = signal('');
  readonly saving = signal(false);
  readonly saveError = signal('');

  ngOnInit() {
    this.reload();
  }

  async reload() {
    this.loading.set(true);
    try {
      const list = await this.api.list();
      this.folders.set(list);
    } catch {
      this.listError.set(this.translate.instant('settings.root_folders.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  openForm() {
    this.formPath.set('');
    this.formLabel.set('');
    this.saveError.set('');
    this.formOpen.set(true);
  }

  closeForm() {
    this.formOpen.set(false);
  }

  async save() {
    const path = this.formPath().trim();
    if (!path) {
      this.saveError.set(this.translate.instant('settings.root_folders.path_required'));
      return;
    }
    this.saving.set(true);
    this.saveError.set('');
    try {
      await this.api.create({ path, label: this.formLabel().trim() || undefined });
      this.closeForm();
      await this.reload();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.saveError.set(msg ?? this.translate.instant('settings.root_folders.save_error'));
    } finally {
      this.saving.set(false);
    }
  }

  async remove(folder: RootFolder) {
    if (!confirm(this.translate.instant('settings.root_folders.confirm_delete', { path: folder.path }))) return;
    try {
      await this.api.remove(folder.id);
      await this.reload();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      alert(httpErr.error?.message ?? 'Error');
    }
  }

  formatBytes(bytes: number): string {
    if (bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let val = bytes;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(1)} ${units[i]}`;
  }

  freePercent(folder: RootFolder): number {
    if (folder.totalSpace <= 0) return 0;
    return Math.round((folder.freeSpace / folder.totalSpace) * 100);
  }
}

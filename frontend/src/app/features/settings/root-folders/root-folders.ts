import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  computed,
  signal,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  RootFoldersApiService,
  RootFolder,
} from '../../../core/services/api/root-folders-api.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';

@Component({
  selector: 'app-root-folders-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './root-folders.html',
})
export class RootFoldersSettingsComponent implements OnInit {
  private readonly api = inject(RootFoldersApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly folders = signal<RootFolder[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  // Default root folder settings
  readonly defaultRootFolderMovie = signal('');
  readonly defaultRootFolderSeries = signal('');
  readonly savingDefaults = signal(false);
  readonly defaultsSaved = signal(false);

  readonly movieFolders = computed(() => this.folders().filter((f) => f.mediaTypes.includes('movie')));
  readonly seriesFolders = computed(() => this.folders().filter((f) => f.mediaTypes.includes('series')));

  // Editor modal
  readonly editingId = signal<number | null>(null);
  readonly formPath = signal('');
  readonly formLabel = signal('');
  readonly formMovies = signal(true);
  readonly formSeries = signal(true);
  readonly saving = signal(false);
  readonly saveError = signal('');

  ngOnInit() {
    this.reload();
  }

  async reload() {
    this.loading.set(true);
    try {
      const [list, settings] = await Promise.all([
        this.api.list(),
        this.settingsApi.getAll(),
      ]);
      this.folders.set(list);
      this.defaultRootFolderMovie.set(settings['default_root_folder_movie'] ?? '');
      this.defaultRootFolderSeries.set(settings['default_root_folder_series'] ?? '');
    } catch {
      this.listError.set(this.translate.instant('settings.root_folders.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  async saveDefaults() {
    this.savingDefaults.set(true);
    try {
      await this.settingsApi.setBulk({
        default_root_folder_movie: this.defaultRootFolderMovie(),
        default_root_folder_series: this.defaultRootFolderSeries(),
      });
      this.defaultsSaved.set(true);
      setTimeout(() => this.defaultsSaved.set(false), 3000);
    } catch {
      // error handled by interceptor
    } finally {
      this.savingDefaults.set(false);
    }
  }

  openCreate() {
    this.editingId.set(null);
    this.formPath.set('');
    this.formLabel.set('');
    this.formMovies.set(true);
    this.formSeries.set(true);
    this.saveError.set('');
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(folder: RootFolder) {
    this.editingId.set(folder.id);
    this.formPath.set(folder.path);
    this.formLabel.set(folder.label ?? '');
    this.formMovies.set(folder.mediaTypes.includes('movie'));
    this.formSeries.set(folder.mediaTypes.includes('series'));
    this.saveError.set('');
    this.editorDialog()?.nativeElement.showModal();
  }

  closeForm() {
    this.editorDialog()?.nativeElement.close();
  }

  async save() {
    const path = this.formPath().trim();
    if (!path) {
      this.saveError.set(this.translate.instant('settings.root_folders.path_required'));
      return;
    }
    const mediaTypes: ('movie' | 'series')[] = [];
    if (this.formMovies()) mediaTypes.push('movie');
    if (this.formSeries()) mediaTypes.push('series');
    if (mediaTypes.length === 0) {
      this.saveError.set(this.translate.instant('settings.root_folders.media_type_required'));
      return;
    }

    this.saving.set(true);
    this.saveError.set('');
    try {
      const id = this.editingId();
      if (id !== null) {
        await this.api.update(id, { path, label: this.formLabel().trim() || undefined, mediaTypes });
      } else {
        await this.api.create({ path, label: this.formLabel().trim() || undefined, mediaTypes });
      }
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
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('settings.root_folders.confirm_delete', { path: folder.path }), variant: 'danger' })) return;
    try {
      await this.api.remove(folder.id);
      await this.reload();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Error', variant: 'danger' });
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

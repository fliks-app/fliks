import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UpperCasePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  Library,
  LibrariesApiService,
} from '../../../core/services/api/libraries-api.service';
import { UsersApiService, UserRow } from '../../../core/services/api/users-api.service';
import {
  ProfilesService,
  QualityProfile,
  LanguageProfile,
} from '../../../core/services/api/profiles.service';
import { ToastService } from '../../../core/services/toast.service';
import { FolderPickerService } from '../../../core/services/folder-picker.service';
import {
  LIBRARY_COLOR_OPTIONS,
  LIBRARY_ICON_OPTIONS,
} from '../../../core/constants/library-appearance';
import { METADATA_PROVIDER_OPTIONS_LIBRARY } from '../../../core/constants/metadata-providers';

@Component({
  selector: 'app-libraries-settings',
  imports: [FormsModule, TranslateModule, UpperCasePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './libraries.html',
})
export class LibrariesSettingsComponent implements OnInit {
  private readonly api = inject(LibrariesApiService);
  private readonly usersApi = inject(UsersApiService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly folderPicker = inject(FolderPickerService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly libraries = signal<Library[]>([]);
  readonly users = signal<UserRow[]>([]);
  readonly qualityProfiles = signal<QualityProfile[]>([]);
  readonly languageProfiles = signal<LanguageProfile[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly saving = signal(false);

  // Create-editor state
  readonly formName = signal('');
  readonly formIcon = signal<string | null>(null);
  readonly formColor = signal<string | null>(null);
  readonly formMovies = signal(true);
  readonly formSeries = signal(true);
  readonly formProvider = signal<string | null>(null);
  readonly formQualityProfileId = signal<number | null>(null);
  readonly formLanguageProfileId = signal<number | null>(null);
  readonly formDefaultMovies = signal(false);
  readonly formDefaultSeries = signal(false);
  readonly formPath = signal('');
  readonly formUserIds = signal<Set<number>>(new Set());
  readonly saveError = signal('');

  readonly iconOptions = LIBRARY_ICON_OPTIONS;
  readonly colorOptions = LIBRARY_COLOR_OPTIONS;

  readonly providerOptions = METADATA_PROVIDER_OPTIONS_LIBRARY;

  ngOnInit() {
    void this.reload();
  }

  async reload() {
    this.loading.set(true);
    this.listError.set('');
    try {
      const [libs, users, qp, lp] = await Promise.all([
        this.api.list(),
        this.usersApi.list().catch(() => [] as UserRow[]),
        this.profilesApi.getQualityProfiles().catch(() => [] as QualityProfile[]),
        this.profilesApi.getLanguageProfiles().catch(() => [] as LanguageProfile[]),
      ]);
      this.libraries.set(libs);
      this.users.set(users);
      this.qualityProfiles.set(qp);
      this.languageProfiles.set(lp);
    } catch {
      this.listError.set(this.translate.instant('settings.libraries.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.formName.set('');
    this.formIcon.set(null);
    this.formColor.set(null);
    this.formMovies.set(true);
    this.formSeries.set(true);
    this.formProvider.set(null);
    this.formQualityProfileId.set(null);
    this.formLanguageProfileId.set(null);
    this.formDefaultMovies.set(false);
    this.formDefaultSeries.set(false);
    this.formPath.set('');
    this.formUserIds.set(new Set());
    this.saveError.set('');
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(lib: Library) {
    void this.router.navigate([lib.id], { relativeTo: this.route });
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  async browsePath() {
    const picked = await this.folderPicker.open(this.formPath().trim());
    if (picked) this.formPath.set(picked);
  }

  toggleUser(id: number) {
    this.formUserIds.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async save() {
    const name = this.formName().trim();
    if (!name) {
      this.saveError.set(this.translate.instant('settings.libraries.name_required'));
      return;
    }
    const mediaTypes: ('movie' | 'series')[] = [];
    if (this.formMovies()) mediaTypes.push('movie');
    if (this.formSeries()) mediaTypes.push('series');
    if (mediaTypes.length === 0) {
      this.saveError.set(this.translate.instant('settings.libraries.media_type_required'));
      return;
    }

    this.saving.set(true);
    this.saveError.set('');
    try {
      const path = this.formPath().trim();
      const payload = {
        name,
        icon: this.formIcon(),
        color: this.formColor(),
        mediaTypes,
        preferredProvider: this.formProvider(),
        defaultQualityProfileId: this.formQualityProfileId(),
        defaultLanguageProfileId: this.formLanguageProfileId(),
        isDefaultForMovies: this.formDefaultMovies(),
        isDefaultForSeries: this.formDefaultSeries(),
        path,
      };

      await this.api.create({
        ...payload,
        userIds: Array.from(this.formUserIds()),
      });

      this.closeEditor();
      this.toast.success(this.translate.instant('settings.libraries.saved'));
      await this.reload();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.saveError.set(msg ?? this.translate.instant('settings.libraries.save_error'));
    } finally {
      this.saving.set(false);
    }
  }

  formatBytes(bytes: number): string {
    if (bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let val = bytes;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(1)} ${units[i]}`;
  }

  freeSpace(lib: Library): number {
    const d = lib.disk;
    return d && d.freeSpace > 0 ? d.freeSpace : 0;
  }

  totalCapacity(lib: Library): number {
    const d = lib.disk;
    return d && d.totalSpace > 0 ? d.totalSpace : 0;
  }
}

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
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  Library,
  LibrariesApiService,
  StalledCleanupProfileKey,
} from '../../../core/services/api/libraries-api.service';
import { UsersApiService, UserRow } from '../../../core/services/api/users-api.service';
import {
  ProfilesService,
  QualityProfile,
  LanguageProfile,
} from '../../../core/services/api/profiles.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
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
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);

  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly libraries = signal<Library[]>([]);
  readonly users = signal<UserRow[]>([]);
  readonly qualityProfiles = signal<QualityProfile[]>([]);
  readonly languageProfiles = signal<LanguageProfile[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly saving = signal(false);

  // Editor state
  readonly editingId = signal<number | null>(null);
  readonly formName = signal('');
  readonly formIcon = signal<string | null>(null);
  readonly formColor = signal<string | null>(null);
  readonly formMovies = signal(true);
  readonly formSeries = signal(true);
  readonly formProvider = signal<string | null>(null);
  readonly formCleanup = signal<StalledCleanupProfileKey | null>(null);
  readonly formQualityProfileId = signal<number | null>(null);
  readonly formLanguageProfileId = signal<number | null>(null);
  readonly formDefaultMovies = signal(false);
  readonly formDefaultSeries = signal(false);
  readonly formPath = signal('');
  readonly formUserIds = signal<Set<number>>(new Set());
  readonly saveError = signal('');

  readonly iconOptions = [
    { value: null, label: 'Par défaut (bibliothèque)' },
    { value: 'film', label: 'Film' },
    { value: 'tv', label: 'TV' },
    { value: 'popcorn', label: 'Popcorn' },
    { value: 'clapperboard', label: 'Clap' },
    { value: 'book', label: 'Livre' },
    { value: 'gamepad-2', label: 'Jeux' },
    { value: 'music', label: 'Musique' },
    { value: 'heart', label: 'Cœur' },
    { value: 'star', label: 'Étoile' },
    { value: 'globe', label: 'Globe' },
    { value: 'monitor', label: 'Écran' },
    { value: 'users', label: 'Utilisateurs' },
    { value: 'folder', label: 'Dossier' },
    { value: 'swords', label: 'Épées' },
  ];

  readonly colorOptions = [
    { value: null, label: 'Par défaut (primary)' },
    { value: 'primary', label: 'Primary' },
    { value: 'secondary', label: 'Secondary' },
    { value: 'accent', label: 'Accent' },
    { value: 'info', label: 'Info' },
    { value: 'success', label: 'Success' },
    { value: 'warning', label: 'Warning' },
    { value: 'error', label: 'Error' },
  ];

  readonly providerOptions = METADATA_PROVIDER_OPTIONS_LIBRARY;
  readonly cleanupOptions: { value: StalledCleanupProfileKey | null; labelKey: string }[] = [
    { value: null, labelKey: 'settings.cleanup_profiles.none' },
    { value: 'fast', labelKey: 'settings.cleanup_profiles.profile_fast' },
    { value: 'medium', labelKey: 'settings.cleanup_profiles.profile_medium' },
    { value: 'slow', labelKey: 'settings.cleanup_profiles.profile_slow' },
  ];

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
    this.editingId.set(null);
    this.formName.set('');
    this.formIcon.set(null);
    this.formColor.set(null);
    this.formMovies.set(true);
    this.formSeries.set(true);
    this.formProvider.set(null);
    this.formCleanup.set(null);
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
    this.editingId.set(lib.id);
    this.formName.set(lib.name);
    this.formIcon.set(lib.icon);
    this.formColor.set(lib.color);
    this.formMovies.set(lib.mediaTypes.includes('movie'));
    this.formSeries.set(lib.mediaTypes.includes('series'));
    this.formProvider.set(lib.preferredProvider);
    this.formCleanup.set(lib.stalledCleanupProfile);
    this.formQualityProfileId.set(lib.defaultQualityProfileId);
    this.formLanguageProfileId.set(lib.defaultLanguageProfileId);
    this.formDefaultMovies.set(lib.isDefaultForMovies);
    this.formDefaultSeries.set(lib.isDefaultForSeries);
    this.formPath.set(lib.rootFolder?.path ?? '');
    this.formUserIds.set(new Set(lib.userIds));
    this.saveError.set('');
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
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
        stalledCleanupProfile: this.formCleanup(),
        defaultQualityProfileId: this.formQualityProfileId(),
        defaultLanguageProfileId: this.formLanguageProfileId(),
        isDefaultForMovies: this.formDefaultMovies(),
        isDefaultForSeries: this.formDefaultSeries(),
        path,
      };

      const id = this.editingId();
      let libraryId: number;
      if (id == null) {
        const created = await this.api.create({
          ...payload,
          userIds: Array.from(this.formUserIds()),
        });
        libraryId = created.id;
      } else {
        await this.api.update(id, payload);
        libraryId = id;
        await this.api.setAccess(libraryId, Array.from(this.formUserIds()));
      }

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

  async remove(lib: Library) {
    if (!(await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('settings.libraries.confirm_delete', { name: lib.name }),
      variant: 'danger',
    }))) return;
    try {
      await this.api.remove(lib.id);
      await this.reload();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({
        title: this.translate.instant('common.error'),
        message: httpErr.error?.message ?? 'Error',
        variant: 'danger',
      });
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
    const rf = lib.rootFolder;
    return rf && rf.freeSpace > 0 ? rf.freeSpace : 0;
  }

  totalCapacity(lib: Library): number {
    const rf = lib.rootFolder;
    return rf && rf.totalSpace > 0 ? rf.totalSpace : 0;
  }
}

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
  LibraryRootFolder,
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

interface DraftPath {
  id?: number; // undefined for new (unsaved) paths
  path: string;
  label: string;
}

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
  readonly formMovies = signal(true);
  readonly formSeries = signal(true);
  readonly formProvider = signal<string | null>(null);
  readonly formCleanup = signal<StalledCleanupProfileKey | null>(null);
  readonly formQualityProfileId = signal<number | null>(null);
  readonly formLanguageProfileId = signal<number | null>(null);
  readonly formDefaultMovies = signal(false);
  readonly formDefaultSeries = signal(false);
  readonly formPaths = signal<DraftPath[]>([]);
  readonly formUserIds = signal<Set<number>>(new Set());
  readonly saveError = signal('');

  readonly providerOptions = [
    { value: null, labelKey: 'settings.libraries.provider_auto' },
    { value: 'tmdb', label: 'TMDB' },
    { value: 'tvdb', label: 'TVDB' },
  ];
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
    this.formMovies.set(true);
    this.formSeries.set(true);
    this.formProvider.set(null);
    this.formCleanup.set(null);
    this.formQualityProfileId.set(null);
    this.formLanguageProfileId.set(null);
    this.formDefaultMovies.set(false);
    this.formDefaultSeries.set(false);
    this.formPaths.set([]);
    this.formUserIds.set(new Set());
    this.saveError.set('');
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(lib: Library) {
    this.editingId.set(lib.id);
    this.formName.set(lib.name);
    this.formMovies.set(lib.mediaTypes.includes('movie'));
    this.formSeries.set(lib.mediaTypes.includes('series'));
    this.formProvider.set(lib.preferredProvider);
    this.formCleanup.set(lib.stalledCleanupProfile);
    this.formQualityProfileId.set(lib.defaultQualityProfileId);
    this.formLanguageProfileId.set(lib.defaultLanguageProfileId);
    this.formDefaultMovies.set(lib.isDefaultForMovies);
    this.formDefaultSeries.set(lib.isDefaultForSeries);
    this.formPaths.set(
      lib.rootFolders.map((rf) => ({ id: rf.id, path: rf.path, label: rf.label ?? '' })),
    );
    this.formUserIds.set(new Set(lib.userIds));
    this.saveError.set('');
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  addDraftPath() {
    this.formPaths.update((p) => [...p, { path: '', label: '' }]);
  }

  updateDraftPath(idx: number, patch: Partial<DraftPath>) {
    this.formPaths.update((paths) =>
      paths.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    );
  }

  removeDraftPath(idx: number) {
    this.formPaths.update((paths) => paths.filter((_, i) => i !== idx));
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
      const payload = {
        name,
        mediaTypes,
        preferredProvider: this.formProvider(),
        stalledCleanupProfile: this.formCleanup(),
        defaultQualityProfileId: this.formQualityProfileId(),
        defaultLanguageProfileId: this.formLanguageProfileId(),
        isDefaultForMovies: this.formDefaultMovies(),
        isDefaultForSeries: this.formDefaultSeries(),
      };

      const id = this.editingId();
      let libraryId: number;
      if (id == null) {
        // CREATE: send paths + userIds inline.
        const created = await this.api.create({
          ...payload,
          paths: this.formPaths()
            .map((p) => p.path.trim())
            .filter((p) => !!p),
          userIds: Array.from(this.formUserIds()),
        });
        libraryId = created.id;
      } else {
        // UPDATE base fields, then sync paths + access through dedicated endpoints.
        await this.api.update(id, payload);
        libraryId = id;

        // Diff paths: remove those no longer present, add new ones.
        const before = (this.libraries().find((l) => l.id === id)?.rootFolders ?? []);
        const draft = this.formPaths();
        const draftIds = new Set(draft.map((p) => p.id).filter((x): x is number => x != null));
        for (const rf of before) {
          if (!draftIds.has(rf.id)) {
            await this.api.removePath(libraryId, rf.id);
          }
        }
        for (const p of draft) {
          if (p.id == null && p.path.trim()) {
            await this.api.addPath(libraryId, {
              path: p.path.trim(),
              label: p.label.trim() || undefined,
            });
          }
        }
        // User access
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

  totalFreeSpace(lib: Library): number {
    return lib.rootFolders.reduce(
      (sum, rf) => sum + (rf.freeSpace > 0 ? rf.freeSpace : 0),
      0,
    );
  }

  totalCapacity(lib: Library): number {
    return lib.rootFolders.reduce(
      (sum, rf) => sum + (rf.totalSpace > 0 ? rf.totalSpace : 0),
      0,
    );
  }
}

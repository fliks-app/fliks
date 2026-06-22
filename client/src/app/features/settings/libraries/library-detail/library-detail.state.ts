import { Injectable, inject, signal } from '@angular/core';
import {
  Library,
  LibrariesApiService,
  StalledCleanupProfileKey,
} from '../../../../core/services/api/libraries-api.service';
import { UserRow } from '../../../../core/services/api/users-api.service';
import {
  QualityProfile,
  LanguageProfile,
} from '../../../../core/services/api/profiles.service';
import { TranslateService } from '@ngx-translate/core';
import { ToastService } from '../../../../core/services/toast.service';

/** Shared state between the library-detail shell and its tab components. */
@Injectable()
export class LibraryDetailState {
  private readonly api = inject(LibrariesApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly library = signal<Library | null>(null);
  readonly users = signal<UserRow[]>([]);
  readonly qualityProfiles = signal<QualityProfile[]>([]);
  readonly languageProfiles = signal<LanguageProfile[]>([]);
  readonly libraryId = signal(0);
  readonly saving = signal(false);
  readonly saveError = signal('');

  // Editable form fields, shared across the General and Users tabs.
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
  readonly formUserIds = signal<ReadonlySet<number>>(new Set());

  /** Populate every form signal from a freshly loaded library. */
  hydrate(lib: Library) {
    this.library.set(lib);
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
    this.formPath.set(lib.path ?? '');
    this.formUserIds.set(new Set(lib.userIds));
    this.saveError.set('');
  }

  toggleUser(id: number) {
    const next = new Set(this.formUserIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.formUserIds.set(next);
  }

  async save(): Promise<boolean> {
    const id = this.libraryId();
    if (!id) return false;

    const name = this.formName().trim();
    if (!name) {
      this.saveError.set(this.translate.instant('settings.libraries.name_required'));
      return false;
    }
    const mediaTypes: ('movie' | 'series')[] = [];
    if (this.formMovies()) mediaTypes.push('movie');
    if (this.formSeries()) mediaTypes.push('series');
    if (mediaTypes.length === 0) {
      this.saveError.set(this.translate.instant('settings.libraries.media_type_required'));
      return false;
    }

    this.saving.set(true);
    this.saveError.set('');
    try {
      await this.api.update(id, {
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
        path: this.formPath().trim(),
      });
      await this.api.setAccess(id, [...this.formUserIds()]);
      this.library.set(await this.api.get(id));
      this.toast.success(this.translate.instant('settings.libraries.saved'));
      return true;
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.saveError.set(msg ?? this.translate.instant('settings.libraries.save_error'));
      return false;
    } finally {
      this.saving.set(false);
    }
  }
}

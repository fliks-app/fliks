import { Injectable, inject, signal } from '@angular/core';
import {
  Library,
  LibrariesApiService,
  UpdateLibraryBody,
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
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly saveError = signal('');

  // Editable form fields, shared by the detail tabs and the creation wizard.
  readonly formName = signal('');
  readonly formIcon = signal<string | null>(null);
  readonly formColor = signal<string | null>(null);
  readonly formMovies = signal(true);
  readonly formSeries = signal(true);
  readonly formProvider = signal<string | null>(null);
  readonly formMetadataLanguage = signal<string | null>(null);
  readonly formMetadataRegion = signal<string | null>(null);
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
    this.formMetadataLanguage.set(lib.metadataLanguage);
    this.formMetadataRegion.set(lib.metadataRegion);
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

  /** Reject an incomplete form, surfacing the reason in `saveError`. */
  validate(): boolean {
    if (!this.formName().trim()) {
      this.saveError.set(this.translate.instant('settings.libraries.name_required'));
      return false;
    }
    if (this.mediaTypes().length === 0) {
      this.saveError.set(this.translate.instant('settings.libraries.media_type_required'));
      return false;
    }
    this.saveError.set('');
    return true;
  }

  async create(): Promise<number | null> {
    if (!this.validate()) return null;

    this.saving.set(true);
    try {
      const lib = await this.api.create({
        ...this.payload(),
        name: this.formName().trim(),
        userIds: [...this.formUserIds()],
      });
      this.libraryId.set(lib.id);
      this.hydrate(lib);
      this.toast.success(this.translate.instant('settings.libraries.saved'));
      return lib.id;
    } catch (err: unknown) {
      this.saveError.set(this.httpMessage(err));
      return null;
    } finally {
      this.saving.set(false);
    }
  }

  async save(): Promise<boolean> {
    const id = this.libraryId();
    if (!id) return false;
    if (!this.validate()) return false;

    this.saving.set(true);
    try {
      await this.api.update(id, this.payload());
      await this.api.setAccess(id, [...this.formUserIds()]);
      this.library.set(await this.api.get(id));
      this.toast.success(this.translate.instant('settings.libraries.saved'));
      return true;
    } catch (err: unknown) {
      this.saveError.set(this.httpMessage(err));
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  mediaTypes(): ('movie' | 'series')[] {
    const types: ('movie' | 'series')[] = [];
    if (this.formMovies()) types.push('movie');
    if (this.formSeries()) types.push('series');
    return types;
  }

  private payload(): UpdateLibraryBody {
    return {
      name: this.formName().trim(),
      icon: this.formIcon(),
      color: this.formColor(),
      mediaTypes: this.mediaTypes(),
      preferredProvider: this.formProvider(),
      metadataLanguage: this.formMetadataLanguage(),
      metadataRegion: this.formMetadataRegion(),
      defaultQualityProfileId: this.formQualityProfileId(),
      defaultLanguageProfileId: this.formLanguageProfileId(),
      isDefaultForMovies: this.formDefaultMovies(),
      isDefaultForSeries: this.formDefaultSeries(),
      path: this.formPath().trim(),
    };
  }

  private httpMessage(err: unknown): string {
    const httpErr = err as { error?: { message?: string | string[] } };
    const msg = Array.isArray(httpErr.error?.message)
      ? httpErr.error.message.join(', ')
      : httpErr.error?.message;
    return msg ?? this.translate.instant('settings.libraries.save_error');
  }
}

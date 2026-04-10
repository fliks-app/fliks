import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { MetadataService } from '../../../../core/services/api/metadata.service';
import { ProfilesService } from '../../../../core/services/api/profiles.service';
import { RootFoldersApiService, RootFolder } from '../../../../core/services/api/root-folders-api.service';
import { SettingsApiService } from '../../../../core/services/api/settings-api.service';
import { ToastService } from '../../../../core/services/toast.service';
import { MediaType } from '../../../../core/enums/media-type.enum';

@Component({
  selector: 'app-import-modal',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import-modal.component.html',
})
export class ImportModalComponent {
  private readonly metadata = inject(MetadataService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly rootFoldersApi = inject(RootFoldersApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);

  readonly imported = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly title = signal('');
  readonly mediaType = signal<MediaType>('movie');
  readonly tmdbId = signal(0);
  readonly provider = signal('tmdb');
  readonly externalId = signal('');
  readonly importing = signal(false);
  readonly error = signal('');
  readonly loading = signal(false);

  readonly qualityProfiles = signal<{ id: number; name: string }[]>([]);
  readonly languageProfiles = signal<{ id: number; name: string }[]>([]);
  readonly rootFolders = signal<RootFolder[]>([]);
  readonly selectedQualityProfileId = signal<number | null>(null);
  readonly selectedLanguageProfileId = signal<number | null>(null);
  readonly selectedRootFolderId = signal<number | null>(null);

  readonly compatibleFolders = computed(() =>
    this.rootFolders().filter((f) => f.mediaTypes.includes(this.mediaType())),
  );

  async open(params: { title: string; mediaType: MediaType; tmdbId: number; provider?: string; externalId?: string }) {
    this.title.set(params.title);
    this.mediaType.set(params.mediaType);
    this.tmdbId.set(params.tmdbId);
    this.provider.set(params.provider ?? 'tmdb');
    this.externalId.set(params.externalId ?? String(params.tmdbId));
    this.error.set('');
    this.importing.set(false);
    this.dialogEl()?.nativeElement.showModal();

    this.loading.set(true);
    try {
      const [qp, lp, folders, settings] = await Promise.all([
        this.profilesApi.getQualityProfiles(),
        this.profilesApi.getLanguageProfiles(),
        this.rootFoldersApi.list(),
        this.settingsApi.getAll(),
      ]);
      this.qualityProfiles.set(qp.map((p) => ({ id: p.id, name: p.name })));
      this.languageProfiles.set(lp.map((p) => ({ id: p.id, name: p.name })));
      this.rootFolders.set(folders);

      if (qp.length) this.selectedQualityProfileId.set(qp[0].id);
      if (lp.length) this.selectedLanguageProfileId.set(lp[0].id);

      const compatible = folders.filter((f) => f.mediaTypes.includes(params.mediaType));
      const defaultKey = params.mediaType === 'series' ? 'default_root_folder_series' : 'default_root_folder_movie';
      const defaultId = Number(settings[defaultKey]);
      if (defaultId && compatible.some((f) => f.id === defaultId)) {
        this.selectedRootFolderId.set(defaultId);
      } else if (compatible.length) {
        this.selectedRootFolderId.set(compatible[0].id);
      }
    } catch {
      /* ignore — selects will just be empty */
    } finally {
      this.loading.set(false);
    }
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }

  async confirm() {
    this.importing.set(true);
    this.error.set('');
    try {
      const saved = await this.metadata.importMedia({
        type: this.mediaType(),
        externalId: this.externalId(),
        provider: this.provider(),
        qualityProfileId: this.selectedQualityProfileId() ?? undefined,
        languageProfileId: this.selectedLanguageProfileId() ?? undefined,
        rootFolderId: this.selectedRootFolderId() ?? undefined,
      });
      this.toast.success(this.translate.instant('discover.import_success'));
      this.close();
      this.imported.emit();
      const prefix = saved.type === 'movie' ? '/movies' : '/series';
      void this.router.navigate([prefix, saved.id]);
    } catch (err: unknown) {
      const httpErr = err as { status?: number; error?: { message?: string } };
      if (httpErr?.status === 400) {
        this.error.set(httpErr.error?.message ?? this.translate.instant('discover.tmdb_not_configured'));
      } else if (httpErr?.status === 403) {
        this.error.set(this.translate.instant('discover.forbidden'));
      } else {
        this.error.set(this.translate.instant('discover.import_error'));
      }
    } finally {
      this.importing.set(false);
    }
  }
}

import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  OnInit,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import {
  MetadataService,
  MetadataDetails,
} from '../../core/services/api/metadata.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { RootFoldersApiService, RootFolder } from '../../core/services/api/root-folders-api.service';
import { SettingsApiService } from '../../core/services/api/settings-api.service';

@Component({
  selector: 'app-tmdb-preview',
  imports: [FormsModule, CurrencyPipe, DatePipe, DecimalPipe, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tmdb-preview.html',
})
export class TmdbPreviewComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly metadata = inject(MetadataService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly rootFoldersApi = inject(RootFoldersApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  readonly auth = inject(AuthService);

  readonly media = signal<MetadataDetails | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly importing = signal(false);

  readonly qualityProfiles = signal<{ id: number; name: string }[]>([]);
  readonly selectedQualityProfileId = signal<number | null>(null);
  readonly rootFolders = signal<RootFolder[]>([]);
  readonly selectedRootFolderId = signal<number | null>(null);

  readonly type = computed(() => {
    const url = this.router.url;
    return url.startsWith('/add/tv') ? 'series' : 'movie';
  });

  readonly canImport = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'admin' || r === 'user';
  });

  async ngOnInit() {
    const tmdbId = Number(this.route.snapshot.paramMap.get('tmdbId'));
    const type = this.type();

    const r = this.auth.user()?.role;
    if (r === 'admin' || r === 'user') {
      const [profiles, folders, settings] = await Promise.all([
        this.profilesApi.getQualityProfiles(),
        this.rootFoldersApi.list(),
        this.settingsApi.getAll(),
      ]);
      this.qualityProfiles.set(profiles.map((p) => ({ id: p.id, name: p.name })));
      if (profiles.length) this.selectedQualityProfileId.set(profiles[0].id);
      this.rootFolders.set(folders);

      // Use default root folder for this media type, or fallback to first folder
      const defaultKey = type === 'series' ? 'default_root_folder_series' : 'default_root_folder_movie';
      const defaultId = Number(settings[defaultKey]);
      if (defaultId && folders.some((f) => f.id === defaultId)) {
        this.selectedRootFolderId.set(defaultId);
      } else if (folders.length) {
        this.selectedRootFolderId.set(folders[0].id);
      }
    }

    try {
      const details = type === 'series'
        ? await this.metadata.getTvDetails(tmdbId)
        : await this.metadata.getMovieDetails(tmdbId);
      this.media.set(details);
    } catch {
      this.error.set(this.translate.instant('discover.preview_error'));
    } finally {
      this.loading.set(false);
    }
  }

  async addToLibrary() {
    const m = this.media();
    if (!m || !this.canImport()) return;
    this.importing.set(true);
    this.error.set('');
    try {
      const saved = await this.metadata.importFromTmdb(
        this.type(),
        m.tmdbId,
        this.selectedQualityProfileId() ?? undefined,
        this.selectedRootFolderId() ?? undefined,
      );
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

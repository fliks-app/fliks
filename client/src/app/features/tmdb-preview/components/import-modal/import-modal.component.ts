import {
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
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { MetadataService, SeasonStub } from '../../../../core/services/api/metadata.service';
import { ProfilesService } from '../../../../core/services/api/profiles.service';
import { LibrariesApiService, Library } from '../../../../core/services/api/libraries-api.service';
import { SettingsApiService } from '../../../../core/services/api/settings-api.service';
import { ToastService } from '../../../../core/services/toast.service';
import { MediaType } from '../../../../core/enums/media-type.enum';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';
import { SeasonPickerComponent } from '../../../../shared/components/season-picker/season-picker.component';

@Component({
  selector: 'app-import-modal',
  imports: [
    TvSelectDirective,
    ModalFooterComponent,
    ModalHeaderComponent,
    SeasonPickerComponent,
    FormsModule,
    TranslatePipe,
  ],
  templateUrl: './import-modal.component.html',
})
export class ImportModalComponent {
  private readonly metadata = inject(MetadataService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly librariesApi = inject(LibrariesApiService);
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
  readonly libraries = signal<Library[]>([]);
  readonly selectedQualityProfileId = signal<number | null>(null);
  readonly selectedLanguageProfileId = signal<number | null>(null);
  readonly selectedLibraryId = signal<number | null>(null);

  readonly seasons = signal<SeasonStub[]>([]);
  readonly selectedSeasons = signal<Set<number>>(new Set());
  readonly seasonsLoading = signal(false);
  /** The season list is what the picker picks from: without it there is nothing
   *  to tick, so the import falls back to the server-side default instead of
   *  leaving the confirm button dead. */
  readonly seasonsFailed = signal(false);

  readonly compatibleLibraries = computed(() =>
    this.libraries().filter((l) => l.mediaTypes.includes(this.mediaType())),
  );

  /** A series with no season monitored would import and then sit idle, so the
   *  confirm button waits for a pick, same rule as the request modal. */
  protected readonly nothingToMonitor = computed(
    () =>
      this.mediaType() === 'series' && !this.seasonsFailed() && this.selectedSeasons().size === 0,
  );

  async open(params: {
    title: string;
    mediaType: MediaType;
    tmdbId: number;
    provider?: string;
    externalId?: string;
  }) {
    this.title.set(params.title);
    this.mediaType.set(params.mediaType);
    this.tmdbId.set(params.tmdbId);
    this.provider.set(params.provider ?? 'tmdb');
    this.externalId.set(params.externalId ?? String(params.tmdbId));
    this.error.set('');
    this.importing.set(false);
    this.seasons.set([]);
    this.selectedSeasons.set(new Set());
    this.seasonsFailed.set(false);
    this.dialogEl()?.nativeElement.showModal();

    if (params.mediaType === 'series') this.loadSeasons();

    this.loading.set(true);
    try {
      const [qp, lp, libs] = await Promise.all([
        this.profilesApi.getQualityProfiles(),
        this.profilesApi.getLanguageProfiles(),
        this.librariesApi.list(),
      ]);
      this.qualityProfiles.set(qp.map((p) => ({ id: p.id, name: p.name })));
      this.languageProfiles.set(lp.map((p) => ({ id: p.id, name: p.name })));
      this.libraries.set(libs);

      if (qp.length) this.selectedQualityProfileId.set(qp[0].id);
      if (lp.length) this.selectedLanguageProfileId.set(lp[0].id);

      // Pick the library flagged as default for this media type, falling back
      // to the first compatible one.
      const compatible = libs.filter((l) => l.mediaTypes.includes(params.mediaType));
      const defaultLib =
        compatible.find((l) =>
          params.mediaType === 'series' ? l.isDefaultForSeries : l.isDefaultForMovies,
        ) ?? compatible[0];
      if (defaultLib) this.selectedLibraryId.set(defaultLib.id);
    } catch {
      /* ignore — selects will just be empty */
    } finally {
      this.loading.set(false);
    }
  }

  /** Specials start unticked: season 0 is only ever monitored on purpose, which
   *  is also what the backend does when no season list is sent. */
  private loadSeasons() {
    this.seasonsLoading.set(true);
    this.metadata
      .getSeasonStubs(this.provider(), this.externalId())
      .then((stubs) => {
        this.seasons.set(stubs);
        this.selectedSeasons.set(new Set(stubs.map((s) => s.seasonNumber).filter((n) => n > 0)));
      })
      .catch(() => this.seasonsFailed.set(true))
      .finally(() => this.seasonsLoading.set(false));
  }

  toggleSeason(n: number) {
    this.selectedSeasons.update((set) => {
      const next = new Set(set);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  }

  toggleAllSeasons() {
    const all = this.seasons().map((s) => s.seasonNumber);
    this.selectedSeasons.set(this.selectedSeasons().size === all.length ? new Set() : new Set(all));
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
        libraryId: this.selectedLibraryId() ?? undefined,
        ...(this.mediaType() === 'series' && !this.seasonsFailed()
          ? {
              monitoredSeasons: [...this.selectedSeasons()].sort((a, b) => a - b),
            }
          : {}),
      });
      this.toast.success(this.translate.instant('discover.import_success'));
      this.close();
      this.imported.emit();
      const prefix = saved.type === 'movie' ? '/movies' : '/series';
      void this.router.navigate([prefix, saved.id]);
    } catch (err: unknown) {
      const httpErr = err as { status?: number; error?: { message?: string } };
      if (httpErr?.status === 400) {
        this.error.set(
          httpErr.error?.message ?? this.translate.instant('discover.tmdb_not_configured'),
        );
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

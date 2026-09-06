import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  effect,
  ElementRef,
  OnInit,
  OnDestroy,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CurrencyPipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import {
  MetadataService,
  MetadataDetails,
  MetadataCredit,
} from '../../core/services/api/metadata.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { ToastService } from '../../core/services/toast.service';
import { TvService } from '../../core/services/tv.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import {
  RequestsService,
  TitleRequestState,
  FliksRequestRow,
} from '../../core/services/api/requests.service';
import { RequestDeclineModalComponent } from '../requests/request-decline-modal/request-decline-modal.component';
import { RequestEditModalComponent } from '../requests/request-edit-modal/request-edit-modal.component';
import { RequestModalComponent } from './components/request-modal/request-modal.component';
import { ImportModalComponent } from './components/import-modal/import-modal.component';
import { MediaType } from '../../core/enums/media-type.enum';
import { LucideFilm, LucideUser, LucidePlay, LucidePlus } from '@lucide/angular';
import { MobileFanartHeroComponent } from '../../shared/components/mobile-fanart-hero';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';
import { localizeLanguage } from '../../core/utils/language.utils';
import { ClampToggleDirective } from '../../shared/directives/clamp-toggle.directive';
import { CollapsibleSectionComponent } from '../../shared/components/collapsible-section/collapsible-section';
import { PreviewSeasonsComponent } from './components/preview-seasons/preview-seasons.component';

@Component({
  selector: 'app-tmdb-preview',
  imports: [FormsModule, CurrencyPipe, DecimalPipe, NgTemplateOutlet, TranslatePipe, ResolveUrlPipe, LocaleDatePipe, RequestModalComponent, ImportModalComponent, MobileFanartHeroComponent, HorizontalScrollerComponent, ClampToggleDirective, CollapsibleSectionComponent, PreviewSeasonsComponent, RequestDeclineModalComponent, RequestEditModalComponent, LucideFilm, LucideUser, LucidePlay, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tmdb-preview.html',
})
export class TmdbPreviewComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly metadata = inject(MetadataService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly requestsApi = inject(RequestsService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  protected readonly navbar = inject(NavbarService);
  protected readonly tv = inject(TvService);
  private readonly backgroundService = inject(BackgroundService);
  readonly auth = inject(AuthService);

  /** Page-wide fanart background — same plumbing as media-detail. The
   *  inline bleed div is gone; `app-background` (mounted in layout)
   *  picks the URL up from the service and renders it under the page. */
  private readonly backgroundEffect = effect(() => {
    const m = this.media();
    if (!m?.fanartUrl) {
      this.backgroundService.clear();
      return;
    }
    this.backgroundService.setBackgrounds([m.fanartUrl]);
  });

  readonly media = signal<MetadataDetails | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');

  readonly qualityProfiles = signal<{ id: number; name: string }[]>([]);
  readonly languageProfiles = signal<{ id: number; name: string }[]>([]);
  readonly libraries = signal<LibrarySummary[]>([]);

  readonly type = computed(() => {
    const url = this.router.url;
    return url.startsWith('/add/tv') ? 'series' : 'movie';
  });

  /** Provider from route param (e.g. /add/movie/tvdb/123) or default to 'tmdb' */
  readonly provider = computed(() => {
    return this.route.snapshot.paramMap.get('provider') ?? 'tmdb';
  });

  /** External ID from route: `:externalId` on the provider-aware routes, `:tmdbId` on the TMDB-only ones. */
  readonly externalId = computed(() => {
    return this.route.snapshot.paramMap.get('externalId')
      ?? this.route.snapshot.paramMap.get('tmdbId')
      ?? '';
  });

  readonly canImport = computed(() => this.auth.hasPermission('media.create'));
  readonly canRequest = computed(() => !this.canImport() && this.auth.hasPermission('requests.create'));

  /** Global active-request state for this title (any user), populated after
   *  the media loads. Null until fetched / when the user can't request. */
  readonly titleState = signal<TitleRequestState | null>(null);

  /** True when a request blocks re-requesting (globally):
   *   - movies: any active request on this tmdbId
   *   - series: an active *whole-series* request (no `seasons` scope) */
  readonly hasBlockingRequest = computed(
    () => this.titleState()?.requested ?? false,
  );

  /** Season numbers already covered by an active per-season request
   *  (globally). Empty for movies. Drives the inline badge and pre-disables
   *  seasons in the request modal. */
  readonly requestedSeasons = computed<number[]>(
    () => this.titleState()?.requestedSeasons ?? [],
  );

  readonly canManageRequests = computed(() =>
    this.auth.hasPermission('requests.manage'),
  );

  /** Pending requests on this title, for a manager. Importing while one is
   *  open can leave it stranded: the lifecycle only adopts a request whose
   *  profiles the imported envelope covers, so a narrower import leaves it
   *  PENDING with the media already in the library. */
  readonly pendingRequests = signal<FliksRequestRow[]>([]);

  /** Any pending request makes a raw import the wrong move, a per-season one
   *  included: importing the whole series would satisfy a scope nobody asked
   *  for, and the request only gets adopted if the profiles happen to cover it.
   *  Approving it is the way in. */
  readonly pendingBlocksImport = computed(() => this.pendingRequests().length > 0);

  /** The import button stands down while a pending request would be bypassed —
   *  kept apart from `canImport`, which `canRequest` negates as a role test. */
  readonly showImportButton = computed(
    () => this.canImport() && !this.pendingBlocksImport(),
  );

  readonly declineForId = signal<number | null>(null);
  readonly declineReasonText = signal('');
  readonly actionBusyId = signal<number | null>(null);

  readonly editingRequest = signal<FliksRequestRow | null>(null);
  readonly editQualityProfileId = signal<number | null>(null);
  readonly editLanguageProfileId = signal<number | null>(null);
  readonly editLibraryId = signal<number | null>(null);
  readonly editSaving = signal(false);

  readonly compatibleLibraries = computed(() => {
    const row = this.editingRequest();
    if (!row) return [];
    return this.libraries().filter((l) => l.mediaTypes.includes(row.mediaType));
  });

  private readonly requestModal = viewChild(RequestModalComponent);
  private readonly importModal = viewChild(ImportModalComponent);
  private readonly declineModal = viewChild(RequestDeclineModalComponent);
  private readonly editModal = viewChild(RequestEditModalComponent);
  private readonly trailerDialog =
    viewChild<ElementRef<HTMLDialogElement>>('trailerDialog');
  private readonly sanitizer = inject(DomSanitizer);

  /** Top-billed cast (capped) for the credits row. */
  readonly topCast = computed<MetadataCredit[]>(() =>
    (this.media()?.cast ?? []).slice(0, 15),
  );

  /** Directors (movies) or creators (series) from the crew. */
  readonly directors = computed<MetadataCredit[]>(() => {
    const crew = this.media()?.crew ?? [];
    const dirs = crew.filter((c) => c.job === 'Director' || c.job === 'Creator');
    // Dedupe by name (a person can hold several jobs).
    return [...new Map(dirs.map((d) => [d.name, d])).values()];
  });
  readonly directorsLabel = computed(() =>
    this.directors().map((d) => d.name).join(', '),
  );

  readonly typeLabelKey = computed(() =>
    this.type() === 'series' ? 'requests.type_series' : 'requests.type_movie',
  );

  readonly seasonsLabel = computed(() => {
    const m = this.media();
    if (this.type() !== 'series' || !m?.seasonCount) return '';
    const plural = (key: string, count: number) =>
      this.translate.instant(
        `media_detail.${key}_${count <= 1 ? 'one' : 'other'}`,
        { count },
      );
    const seasons = plural('season_count', m.seasonCount);
    return m.episodeCount
      ? `${seasons} · ${plural('episode_count', m.episodeCount)}`
      : seasons;
  });

  readonly originalLanguageLabel = computed(() =>
    localizeLanguage(this.media()?.originalLanguage, this.translate),
  );

  /** i18n key for the provider status (lowercased, spaces → underscores). */
  readonly statusKey = computed(() => {
    const s = this.media()?.status;
    return s ? 'discover.status_' + s.replace(/[\s-]+/g, '_') : '';
  });

  /** Best trailer key: a YouTube Trailer, else Teaser, else any YouTube video. */
  readonly trailerKey = computed<string | null>(() => {
    const vids = (this.media()?.videos ?? []).filter((v) => v.site === 'YouTube');
    const pick =
      vids.find((v) => v.type === 'Trailer') ??
      vids.find((v) => v.type === 'Teaser') ??
      vids[0];
    return pick?.key ?? null;
  });

  /** Sanitized embed URL, set only while the trailer dialog is open so the
   *  player stops (and stops fetching) when it closes. */
  readonly trailerEmbedUrl = signal<SafeResourceUrl | null>(null);

  openTrailer() {
    const key = this.trailerKey();
    if (!key) return;
    this.trailerEmbedUrl.set(
      this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube.com/embed/${key}?autoplay=1`,
      ),
    );
    this.trailerDialog()?.nativeElement.showModal();
  }

  closeTrailer() {
    this.trailerDialog()?.nativeElement.close();
    this.trailerEmbedUrl.set(null);
  }

  ngOnDestroy() {
    this.navbar.leaveHeroPage();
    this.backgroundService.clear();
  }

  async ngOnInit() {
    const type = this.type();
    const provider = this.provider();
    const externalId = this.externalId();

    // Feeds the request form and the manager's edit modal; the import modal
    // loads its own data on open.
    if (this.canRequest() || this.canManageRequests()) {
      const [qp, lp, libs] = await Promise.all([
        this.profilesApi.getQualityProfiles(),
        this.profilesApi.getLanguageProfiles(),
        this.librariesApi.listMine(),
      ]);
      this.qualityProfiles.set(qp.map((p) => ({ id: p.id, name: p.name })));
      this.languageProfiles.set(lp.map((p) => ({ id: p.id, name: p.name })));
      this.libraries.set(libs);
    }

    try {
      const details = await this.metadata.getDetails(provider, type, externalId);
      this.media.set(details);
      this.navbar.enterHeroPage(details.title, details.logoUrl);
      // Only relevant when the Request button could show: admins who can
      // import never see the "déjà demandé" badge anyway.
      if (this.canRequest()) {
        await this.loadTitleState(details.tmdbId);
      }
      if (this.canManageRequests()) {
        await this.loadPendingRequests(details.tmdbId);
      }
    } catch {
      this.error.set(this.translate.instant('discover.preview_error'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Global active-request state for this title — drives the "déjà demandé"
   *  gate (any user) and the series profile lock. */
  private async loadTitleState(tmdbId: number) {
    try {
      this.titleState.set(
        await this.requestsApi.getTitleState(tmdbId, this.type() as MediaType),
      );
    } catch { /* ignore */ }
  }

  /** Called by the request modal after a successful POST so the page
   *  flips to the "déjà demandé" state without a manual refresh. */
  protected refreshExistingRequests() {
    const m = this.media();
    if (m) void this.loadTitleState(m.tmdbId);
  }

  openImportModal() {
    const m = this.media();
    if (!m) return;
    this.importModal()?.open({
      title: m.title,
      mediaType: this.type() as MediaType,
      tmdbId: m.tmdbId,
      provider: this.provider(),
      externalId: this.externalId(),
    });
  }

  /** Pending requests on this title, so a manager acts on the request instead
   *  of importing past it. Bypasses the cache: an approve/decline here has to
   *  be reflected on the next visit. */
  private async loadPendingRequests(tmdbId: number) {
    try {
      const page = await this.requestsApi.list(
        {
          tmdbId,
          mediaType: this.type() as MediaType,
          status: 'pending',
          kind: 'add',
          limit: 50,
        },
        { force: true },
      );
      this.pendingRequests.set(page.data);
    } catch {
      /* a failed lookup must not block the page — the Add button stays */
    }
  }

  private refreshPendingRequests() {
    const m = this.media();
    if (m) void this.loadPendingRequests(m.tmdbId);
  }

  async approveRequest(id: number) {
    this.actionBusyId.set(id);
    try {
      await this.requestsApi.approve(id);
      this.refreshPendingRequests();
    } finally {
      this.actionBusyId.set(null);
    }
  }

  openDecline(id: number) {
    this.declineForId.set(id);
    this.declineReasonText.set('');
    this.declineModal()?.showModal();
  }

  closeDecline() {
    this.declineModal()?.close();
    this.declineForId.set(null);
  }

  async submitDecline() {
    const id = this.declineForId();
    if (id == null) return;
    this.actionBusyId.set(id);
    try {
      await this.requestsApi.decline(id, this.declineReasonText());
      this.closeDecline();
      this.refreshPendingRequests();
    } finally {
      this.actionBusyId.set(null);
    }
  }

  openEdit(row: FliksRequestRow) {
    this.editingRequest.set(row);
    this.editQualityProfileId.set(row.qualityProfileId);
    this.editLanguageProfileId.set(row.languageProfileId);
    this.editLibraryId.set(row.libraryId);
    this.editModal()?.showModal();
  }

  closeEdit() {
    this.editModal()?.close();
    this.editingRequest.set(null);
  }

  async saveEdit() {
    const row = this.editingRequest();
    if (!row) return;
    this.editSaving.set(true);
    try {
      // Only send libraryId when it actually changed: re-sending an unchanged
      // value would re-run the backend access check on a plain profile edit.
      const libraryChanged = this.editLibraryId() !== row.libraryId;
      await this.requestsApi.update(row.id, {
        qualityProfileId: this.editQualityProfileId() ?? undefined,
        languageProfileId: this.editLanguageProfileId() ?? undefined,
        ...(libraryChanged ? { libraryId: this.editLibraryId() } : {}),
      });
      this.toast.success(this.translate.instant('requests.edit_success'));
      this.closeEdit();
      this.refreshPendingRequests();
    } finally {
      this.editSaving.set(false);
    }
  }

  /** Season scope of a per-season request; empty for a whole-title one. */
  seasonScope(row: FliksRequestRow): string {
    return (row.seasons ?? []).join(', ');
  }

  /** Quality profile the requester picked. `#id` when the profile is gone —
   *  losing the value entirely would hide what the request actually asks for. */
  qualityProfileName(row: FliksRequestRow): string {
    return this.profileName(this.qualityProfiles(), row.qualityProfileId);
  }

  languageProfileName(row: FliksRequestRow): string {
    return this.profileName(this.languageProfiles(), row.languageProfileId);
  }

  private profileName(
    profiles: { id: number; name: string }[],
    id: number | null,
  ): string {
    if (id == null) return '';
    return profiles.find((p) => p.id === id)?.name ?? `#${id}`;
  }

  openRequestModal() {
    const m = this.media();
    if (!m) return;
    const state = this.titleState();
    this.requestModal()?.open({
      title: m.title,
      mediaType: this.type() as 'movie' | 'series',
      tmdbId: m.tmdbId,
      alreadyRequestedSeasons: this.requestedSeasons(),
      profilesLocked: state?.profilesLocked ?? false,
      lockedQualityProfileId: state?.lockedQualityProfileId ?? null,
      lockedLanguageProfileId: state?.lockedLanguageProfileId ?? null,
    });
  }
}

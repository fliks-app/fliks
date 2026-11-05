import { Component, signal, inject, computed, effect, input, OnInit, OnDestroy, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucidePlay, LucidePlus } from '@lucide/angular';
import { AuthService } from '../../../../core/services/auth.service';
import { MetadataService, MetadataDetails, MetadataCredit } from '../../../../core/services/api/metadata.service';
import { ProfilesService } from '../../../../core/services/api/profiles.service';
import { LibrariesApiService, LibrarySummary } from '../../../../core/services/api/libraries-api.service';
import { ToastService } from '../../../../core/services/toast.service';
import { NavbarService } from '../../../../core/services/navbar.service';
import { RequestsService, TitleKey, TitleRequestState, FliksRequestRow, VideoMediaType } from '../../../../core/services/api/requests.service';
import { RequestDeclineModalComponent } from '../../../requests/request-decline-modal/request-decline-modal.component';
import { RequestEditModalComponent } from '../../../requests/request-edit-modal/request-edit-modal.component';
import { RequestDeclineFlow, RequestEditFlow } from '../../../requests/request-flows';
import { RequestModalComponent } from '../request-modal/request-modal.component';
import { ImportModalComponent } from '../import-modal/import-modal.component';
import { PreviewSeasonsComponent } from '../preview-seasons/preview-seasons.component';
import { localizeLanguage } from '../../../../core/utils/language.utils';
import { TvRowDirective } from '../../../../shared/directives/tv-row.directive';
import { DetailSectionComponent } from '../../../../shared/components/detail-section/detail-section';
import { FactsGridComponent, type Fact } from '../../../../shared/components/facts-grid/facts-grid';
import { HeroBaseComponent, type HeroChip } from '../../../../shared/components/hero-base/hero-base';
import { TrailerDialogComponent } from '../../../../shared/components/trailer-dialog/trailer-dialog';
import { MediaCastComponent, providerCast } from '../../../media-detail/components/media-cast/media-cast.component';
import { bestTrailerKey } from '../../../../shared/utils/trailer.util';
import { previewPosterName } from '../../../../shared/utils/view-transition';
import { KIND_REGISTRY, mediaDetailLink } from '../../../../core/media-kinds';
import { PREVIEW_HOST, type PreviewSeed } from '../../preview-host';

/** The add preview of a movie or a series: its facts, seasons and cast, and Add, Request or the manager's pending requests. */
@Component({
  selector: 'app-video-preview',
  imports: [NgTemplateOutlet, TranslatePipe, RequestModalComponent, ImportModalComponent, TvRowDirective, DetailSectionComponent, FactsGridComponent, HeroBaseComponent, MediaCastComponent, PreviewSeasonsComponent, RequestDeclineModalComponent, RequestEditModalComponent, TrailerDialogComponent, LucidePlay, LucidePlus],
  templateUrl: './video-preview.component.html',
  host: { class: 'block' },
})
export class VideoPreviewComponent implements OnInit, OnDestroy {
  protected readonly kinds = KIND_REGISTRY;
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly metadata = inject(MetadataService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly requestsApi = inject(RequestsService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly navbar = inject(NavbarService);
  private readonly host = inject(PREVIEW_HOST);
  readonly auth = inject(AuthService);

  readonly provider = input.required<string>();
  readonly externalId = input.required<string>();
  readonly seed = input<PreviewSeed | null>(null);

  /** Page-wide fanart background, same plumbing as media-detail (`app-background` renders it from the service). */
  private readonly backgroundEffect = effect(() => this.host.setBackground(this.media()?.fanartUrl ?? null));

  readonly media = signal<MetadataDetails | null>(null);
  readonly error = signal('');

  readonly qualityProfiles = signal<{ id: number; name: string }[]>([]);
  readonly languageProfiles = signal<{ id: number; name: string }[]>([]);
  readonly libraries = signal<LibrarySummary[]>([]);

  readonly type = computed(() => this.route.snapshot.data['kind'] as VideoMediaType);

  /** Title and artwork: the card's until the details land. */
  readonly hero = computed(() => {
    const m = this.media();
    if (m) return { title: m.title, posterUrl: m.posterUrl, fanartUrl: m.fanartUrl ?? m.posterUrl };
    const s = this.seed();
    return s ? { title: s.title, posterUrl: s.posterUrl, fanartUrl: s.fanartUrl ?? s.posterUrl } : null;
  });

  /** A film fills more of the facts grid (release dates, budget, revenue) than a series. */
  readonly skeletonFacts = computed(() =>
    Array.from({ length: KIND_REGISTRY[this.type()].hasSeasons ? 4 : 8 }, (_, i) => i),
  );

  readonly posterTransitionName = computed(() =>
    previewPosterName(KIND_REGISTRY[this.type()].providerSegment, this.provider(), this.externalId()),
  );

  readonly canImport = computed(() => this.auth.hasPermission('media.create'));
  readonly canRequest = computed(() => !this.canImport() && this.auth.hasPermission('requests.create'));

  /** Global active-request state for this title (any user), populated after
   *  the media loads. Null until fetched / when the user can't request. */
  readonly titleState = signal<TitleRequestState | null>(null);

  /** True when a request blocks re-requesting: any active request for a movie, an active whole-series (no `seasons`) one for a series. */
  readonly hasBlockingRequest = computed(
    () => this.titleState()?.requested ?? false,
  );

  /** Season numbers covered by an active per-season request (empty for movies); drives the badge and pre-disables seasons in the modal. */
  readonly requestedSeasons = computed<number[]>(
    () => this.titleState()?.requestedSeasons ?? [],
  );

  readonly canManageRequests = computed(() =>
    this.auth.hasPermission('requests.manage'),
  );

  /** Pending requests on this title, for a manager: importing narrower than the request's profiles leaves it PENDING with the media already imported. */
  readonly pendingRequests = signal<FliksRequestRow[]>([]);

  /** Any pending request (per-season included) makes a raw import the wrong move; approving it is the way in. */
  readonly pendingBlocksImport = computed(() => this.pendingRequests().length > 0);

  /** The import button stands down while a pending request would be bypassed -
   *  kept apart from `canImport`, which `canRequest` negates as a role test. */
  readonly showImportButton = computed(
    () => this.canImport() && !this.pendingBlocksImport(),
  );

  readonly actionBusyId = signal<number | null>(null);


  private readonly requestModal = viewChild(RequestModalComponent);
  private readonly importModal = viewChild(ImportModalComponent);
  private readonly declineModal = viewChild(RequestDeclineModalComponent);
  private readonly editModal = viewChild(RequestEditModalComponent);
  readonly decline = new RequestDeclineFlow(() => this.declineModal());
  readonly edit = new RequestEditFlow(() => this.editModal(), () => this.libraries());
  private readonly trailerDialog = viewChild(TrailerDialogComponent);

  // Guards navbar/navigate writes from a slow await that outlives the component.
  private destroyed = false;

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
    KIND_REGISTRY[this.type()].requestLabelKey,
  );

  readonly seasonsLabel = computed(() => {
    const m = this.media();
    if (!KIND_REGISTRY[this.type()].hasSeasons || !m?.seasonCount) return '';
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

  /** The original title, when it differs from the localized one. */
  readonly subtitle = computed(() => {
    const m = this.media();
    return m?.originalTitle && m.originalTitle !== m.title ? m.originalTitle : null;
  });

  readonly metaParts = computed(() => {
    const m = this.media();
    if (!m) return [];
    const status = m.status && m.status !== 'unknown' ? this.statusKey() : '';
    return [m.year ? String(m.year) : '', m.runtime ? `${m.runtime}min` : '', this.seasonsLabel(), status].filter(Boolean);
  });

  readonly chips = computed<HeroChip[]>(() => [
    { label: this.typeLabelKey(), cls: 'badge badge-outline badge-sm md:badge-md' },
  ]);

  readonly castMembers = computed(() => providerCast(this.topCast()));

  readonly facts = computed<Fact[]>(() => {
    const m = this.media();
    if (!m) return [];
    return [
      { label: 'discover.preview_director', value: this.directorsLabel() },
      { label: 'discover.preview_original_language', value: m.originalLanguage ? this.originalLanguageLabel() : null },
      { label: 'discover.preview_release_date', value: m.releaseDate, format: 'date' },
      { label: 'discover.preview_in_cinemas', value: m.inCinemas, format: 'date' },
      { label: 'discover.preview_digital', value: m.digitalRelease, format: 'date' },
      { label: 'discover.preview_physical', value: m.physicalRelease, format: 'date' },
      { label: 'discover.preview_budget', value: m.budget, format: 'currency' },
      { label: 'discover.preview_revenue', value: m.revenue, format: 'currency' },
      { label: 'discover.preview_countries', value: m.productionCountries.join(', ') },
      { label: 'discover.preview_studios', value: m.productionCompanies.join(', ') },
      { label: 'IMDB', translate: false, value: m.imdbId },
      { label: 'TMDB', translate: false, value: m.tmdbId },
    ];
  });

  readonly trailerKey = computed(() => bestTrailerKey(this.media()?.videos));

  openTrailer() {
    const key = this.trailerKey();
    if (key) this.trailerDialog()?.open(key);
  }

  ngOnDestroy() {
    this.destroyed = true;
  }

  async ngOnInit() {
    // Feeds the request form and the manager's edit modal; the import modal
    // loads its own data on open.
    if (this.canRequest() || this.canManageRequests()) void this.loadProfiles();

    try {
      const details = await this.metadata.getDetails(this.provider(), this.type(), this.externalId());
      if (this.destroyed) return;
      this.media.set(details);
      this.host.setTitle(details.title, details.logoUrl);
      this.tmdbReady =
        this.provider() === 'tmdb' ||
        (!!details.tmdbId && (await this.metadata.isTmdbAvailable().catch(() => false)));
      // Only relevant when the Request button could show: admins who can
      // import never see the "déjà demandé" badge anyway.
      if (this.canRequest()) {
        await this.loadTitleState(this.titleKey(details));
      }
      if (this.canManageRequests()) {
        await this.loadPendingRequests(this.titleKey(details));
      }
    } catch {
      this.error.set(this.translate.instant('discover.preview_error'));
    }
  }

  private async loadProfiles() {
    const [qp, lp, libs] = await Promise.all([
      this.profilesApi.getQualityProfiles(),
      this.profilesApi.getLanguageProfiles(),
      this.librariesApi.listMine(),
    ]);
    this.qualityProfiles.set(qp.map((p) => ({ id: p.id, name: p.name })));
    this.languageProfiles.set(lp.map((p) => ({ id: p.id, name: p.name })));
    this.libraries.set(libs);
  }

  /** Whether the TMDB id can key the title: the provider is TMDB, or TMDB answers. */
  private tmdbReady = false;

  /** The TMDB id when the details carry one and TMDB answers, else the page's own provider and id. */
  private titleKey(m: MetadataDetails): TitleKey {
    return this.tmdbReady && m.tmdbId && m.tmdbId > 0
      ? { tmdbId: m.tmdbId }
      : { provider: this.provider(), externalId: this.externalId() };
  }

  private async loadTitleState(key: TitleKey) {
    try {
      this.titleState.set(
        await this.requestsApi.getTitleState(key, this.type()),
      );
    } catch { /* ignore */ }
  }

  /** Called by the request modal after a successful POST so the page
   *  flips to the "déjà demandé" state without a manual refresh. */
  protected refreshExistingRequests() {
    const m = this.media();
    if (m) void this.loadTitleState(this.titleKey(m));
  }

  openImportModal() {
    const m = this.media();
    if (!m) return;
    this.importModal()?.open({
      title: m.title,
      mediaType: this.type(),
      tmdbId: m.tmdbId,
      provider: this.provider(),
      externalId: this.externalId(),
    });
  }

  /** Pending requests on this title; bypasses the cache so an approve/decline shows on the next visit. */
  private async loadPendingRequests(key: TitleKey) {
    try {
      const page = await this.requestsApi.list(
        {
          ...key,
          mediaType: this.type(),
          status: 'pending',
          kind: 'add',
          limit: 50,
        },
        { force: true },
      );
      this.pendingRequests.set(page.data);
    } catch {
      /* a failed lookup must not block the page, the Add button stays */
    }
  }

  private refreshPendingRequests() {
    const m = this.media();
    if (m) void this.loadPendingRequests(this.titleKey(m));
  }

  /** Approval imports the title, so this page's "not in the library yet" view
   *  is stale: replace it with the media, so Back can't return to it. */
  async approveRequest(id: number) {
    this.actionBusyId.set(id);
    try {
      const approved = await this.requestsApi.approve(id);
      if (this.destroyed) return;
      const mediaId = approved.media?.id;
      if (mediaId == null) {
        this.refreshPendingRequests();
        return;
      }
      // Both histories: the browser's (replaceUrl) and the in-app back stack.
      this.navbar.markAsBackNavigation();
      void this.router.navigate(mediaDetailLink(approved.mediaType, mediaId), { replaceUrl: true });
    } catch {
      /* surfaced by the global HTTP error interceptor */
    } finally {
      this.actionBusyId.set(null);
    }
  }

  async submitDecline() {
    const id = this.decline.forId();
    if (id == null) return;
    this.actionBusyId.set(id);
    try {
      await this.requestsApi.decline(id, this.decline.reasonText());
      if (this.destroyed) return;
      this.decline.close();
      this.refreshPendingRequests();
    } finally {
      this.actionBusyId.set(null);
    }
  }

  async saveEdit() {
    const row = this.edit.row();
    if (!row) return;
    this.edit.saving.set(true);
    try {
      await this.requestsApi.update(row.id, this.edit.changes(row));
      if (this.destroyed) return;
      this.toast.success(this.translate.instant('requests.edit_success'));
      this.edit.close();
      this.refreshPendingRequests();
    } finally {
      this.edit.saving.set(false);
    }
  }

  /** Season scope of a per-season request; empty for a whole-title one. */
  seasonScope(row: FliksRequestRow): string {
    return (row.seasons ?? []).join(', ');
  }

  /** Quality profile the requester picked. `#id` when the profile is gone -
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
    const type = this.type();
    if (!m) return;
    const state = this.titleState();
    this.requestModal()?.open({
      title: m.title,
      mediaType: type,
      titleKey: this.titleKey(m),
      alreadyRequestedSeasons: this.requestedSeasons(),
      profilesLocked: state?.profilesLocked ?? false,
      lockedQualityProfileId: state?.lockedQualityProfileId ?? null,
      lockedLanguageProfileId: state?.lockedLanguageProfileId ?? null,
    });
  }
}

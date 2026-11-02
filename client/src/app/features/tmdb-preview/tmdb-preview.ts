import {
  Component,
  signal,
  inject,
  computed,
  effect,
  OnInit,
  OnDestroy,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CurrencyPipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
import { RequestDeclineFlow, RequestEditFlow } from '../requests/request-flows';
import { RequestModalComponent } from './components/request-modal/request-modal.component';
import { ImportModalComponent } from './components/import-modal/import-modal.component';
import { BookPreviewComponent } from './components/book-preview/book-preview.component';
import { MediaType } from '../../core/enums/media-type.enum';
import { LucideFilm, LucideUser, LucidePlay, LucidePlus } from '@lucide/angular';
import { MobileFanartHeroComponent } from '../../shared/components/mobile-fanart-hero';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';
import { localizeLanguage } from '../../core/utils/language.utils';
import { ClampToggleDirective } from '../../shared/directives/clamp-toggle.directive';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { CollapsibleSectionComponent } from '../../shared/components/collapsible-section/collapsible-section';
import { PreviewSeasonsComponent } from './components/preview-seasons/preview-seasons.component';
import { MD_BREAKPOINT_QUERY, mediaQuerySignal } from '../../core/utils/viewport';
import { bestTrailerKey } from '../../shared/utils/trailer.util';
import { TrailerDialogComponent } from '../../shared/components/trailer-dialog/trailer-dialog';
import { previewPosterName } from '../../shared/utils/view-transition';
import { ImgFadeInDirective } from '../../shared/directives/img-fade-in.directive';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';
import { KIND_REGISTRY, mediaDetailLink } from '../../core/media-kinds';

/** What the card that opened the page already knows, handed over in router state. */
interface PreviewSeed {
  externalId: string;
  title: string;
  posterUrl: string | null;
  fanartUrl: string | null;
}

@Component({
  selector: 'app-tmdb-preview',
  imports: [FormsModule, CurrencyPipe, DecimalPipe, NgTemplateOutlet, TranslatePipe, ResolveUrlPipe, LocaleDatePipe, RequestModalComponent, ImportModalComponent, BookPreviewComponent, MobileFanartHeroComponent, HorizontalScrollerComponent, ClampToggleDirective, DefaultFocusDirective, TvRowDirective, TvSectionDirective, CollapsibleSectionComponent, PreviewSeasonsComponent, ImgFadeInDirective, CachedSrcDirective, RequestDeclineModalComponent, RequestEditModalComponent, TrailerDialogComponent, LucideFilm, LucideUser, LucidePlay, LucidePlus],
  templateUrl: './tmdb-preview.html',
})
export class TmdbPreviewComponent implements OnInit, OnDestroy {
  protected readonly kinds = KIND_REGISTRY;
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

  /** Page-wide fanart background, same plumbing as media-detail (`app-background` renders it from the service). */
  private readonly backgroundEffect = effect(() => {
    const m = this.media();
    this.backgroundService.set(this, m?.fanartUrl ?? null);
  });

  readonly media = signal<MetadataDetails | null>(null);
  readonly error = signal('');

  readonly qualityProfiles = signal<{ id: number; name: string }[]>([]);
  readonly languageProfiles = signal<{ id: number; name: string }[]>([]);
  readonly libraries = signal<LibrarySummary[]>([]);

  readonly type = computed(() => this.route.snapshot.data['kind'] as MediaType);

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

  /** Read before the first render, so the poster the card stamped has its pair. */
  private readonly seed: PreviewSeed | null = (() => {
    const seed = (history.state as { preview?: PreviewSeed } | null)?.preview;
    return seed?.externalId === this.externalId() ? seed : null;
  })();

  /** Title and artwork: the card's until the details land. */
  readonly hero = computed(() => {
    const m = this.media();
    if (m) return { title: m.title, posterUrl: m.posterUrl, fanartUrl: m.fanartUrl ?? m.posterUrl };
    const s = this.seed;
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

  /** The import button stands down while a pending request would be bypassed —
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
  protected readonly desktopLayout = mediaQuerySignal(MD_BREAKPOINT_QUERY);

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

  readonly trailerKey = computed(() => bestTrailerKey(this.media()?.videos));

  openTrailer() {
    const key = this.trailerKey();
    if (key) this.trailerDialog()?.open(key);
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.backgroundService.release(this);
    this.navbar.leaveHeroPage();
  }

  async ngOnInit() {
    if (this.type() === 'book') return;
    // Hero chrome from the first frame, so the skeleton sits where the page will.
    this.navbar.enterHeroPage(this.seed?.title ?? '');
    // Feeds the request form and the manager's edit modal; the import modal
    // loads its own data on open.
    if (this.canRequest() || this.canManageRequests()) void this.loadProfiles();

    try {
      const details = await this.metadata.getDetails(this.provider(), this.type(), this.externalId());
      if (this.destroyed) return;
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

  /** Global active-request state for this title — drives the "déjà demandé"
   *  gate (any user) and the series profile lock. */
  private async loadTitleState(tmdbId: number) {
    try {
      this.titleState.set(
        await this.requestsApi.getTitleState(tmdbId, this.type()),
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
      mediaType: this.type(),
      tmdbId: m.tmdbId,
      provider: this.provider(),
      externalId: this.externalId(),
    });
  }

  /** Pending requests on this title; bypasses the cache so an approve/decline shows on the next visit. */
  private async loadPendingRequests(tmdbId: number) {
    try {
      const page = await this.requestsApi.list(
        {
          tmdbId,
          mediaType: this.type(),
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
      mediaType: this.type(),
      tmdbId: m.tmdbId,
      alreadyRequestedSeasons: this.requestedSeasons(),
      profilesLocked: state?.profilesLocked ?? false,
      lockedQualityProfileId: state?.lockedQualityProfileId ?? null,
      lockedLanguageProfileId: state?.lockedLanguageProfileId ?? null,
    });
  }
}

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
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import {
  MetadataService,
  MetadataDetails,
  MetadataCredit,
} from '../../core/services/api/metadata.service';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import { RequestsService, TitleRequestState } from '../../core/services/api/requests.service';
import { RequestModalComponent } from './components/request-modal/request-modal.component';
import { ImportModalComponent } from './components/import-modal/import-modal.component';
import { MediaType } from '../../core/enums/media-type.enum';
import { LucideFilm, LucideUser, LucidePlay } from '@lucide/angular';
import { MobileFanartHeroComponent } from '../../shared/components/mobile-fanart-hero';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

@Component({
  selector: 'app-tmdb-preview',
  imports: [FormsModule, CurrencyPipe, DatePipe, DecimalPipe, TranslateModule, ResolveUrlPipe, RequestModalComponent, ImportModalComponent, MobileFanartHeroComponent, LucideFilm, LucideUser, LucidePlay],
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
  private readonly translate = inject(TranslateService);
  protected readonly navbar = inject(NavbarService);
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

  /** External ID from route — either :externalId or legacy :tmdbId */
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

  private readonly requestModal = viewChild(RequestModalComponent);
  private readonly importModal = viewChild(ImportModalComponent);
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

    // Only the request flow needs profiles+libraries pre-loaded on the page
    // (the import modal loads its own data on open).
    if (this.canRequest()) {
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

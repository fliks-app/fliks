import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
  effect,
  OnInit,
  OnDestroy,
  viewChild,
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
import { LibrariesApiService, Library } from '../../core/services/api/libraries-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import { FliksRequestRow, RequestsService } from '../../core/services/api/requests.service';
import { RequestModalComponent } from './components/request-modal/request-modal.component';
import { ImportModalComponent } from './components/import-modal/import-modal.component';
import { MediaType } from '../../core/enums/media-type.enum';
import { LucideFilm, LucideChevronLeft } from '@lucide/angular';
import { MobileFanartHeroComponent } from '../../shared/components/mobile-fanart-hero';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

@Component({
  selector: 'app-tmdb-preview',
  imports: [FormsModule, CurrencyPipe, DatePipe, DecimalPipe, TranslateModule, ResolveUrlPipe, RequestModalComponent, ImportModalComponent, MobileFanartHeroComponent, LucideFilm, LucideChevronLeft],
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

  /** Back to the previous in-app URL — falls back to `/` when no history.
   *  Same contract as media-detail's back button on desktop. */
  goBack() {
    this.navbar.goBack(['/']);
  }

  readonly media = signal<MetadataDetails | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');

  readonly qualityProfiles = signal<{ id: number; name: string }[]>([]);
  readonly languageProfiles = signal<{ id: number; name: string }[]>([]);
  readonly libraries = signal<Library[]>([]);

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

  /** Existing requests for this tmdbId — populated after the media loads.
   *  Empty when the user has no `requests.create` permission (we don't
   *  fetch unless the Request button could otherwise show). */
  readonly existingRequests = signal<FliksRequestRow[]>([]);

  /** Statuses that fully consume the "can request again" right. Declined /
   *  failed remain re-requestable; available is the "added to library"
   *  case which the page surfaces via `existingMediaId` anyway. */
  private static readonly ACTIVE_STATUSES = new Set<string>([
    'pending', 'approved', 'processing', 'available',
  ]);

  /** True when a request blocks re-requesting:
   *   - movies: any active request on this tmdbId
   *   - series: an active *whole-series* request (no `seasons` scope) */
  readonly hasBlockingRequest = computed(() => {
    const isSeries = this.type() === 'series';
    return this.existingRequests().some((r) => {
      if (!TmdbPreviewComponent.ACTIVE_STATUSES.has(r.status)) return false;
      return isSeries ? !r.seasons || r.seasons.length === 0 : true;
    });
  });

  /** Season numbers already covered by an active per-season request.
   *  Empty for movies. Used both for the inline badge and to pre-disable
   *  seasons in the request modal. */
  readonly requestedSeasons = computed<number[]>(() => {
    if (this.type() !== 'series') return [];
    const set = new Set<number>();
    for (const r of this.existingRequests()) {
      if (!TmdbPreviewComponent.ACTIVE_STATUSES.has(r.status)) continue;
      if (r.seasons?.length) {
        for (const n of r.seasons) set.add(n);
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  });

  private readonly requestModal = viewChild(RequestModalComponent);
  private readonly importModal = viewChild(ImportModalComponent);

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
        this.librariesApi.list(),
      ]);
      this.qualityProfiles.set(qp.map((p) => ({ id: p.id, name: p.name })));
      this.languageProfiles.set(lp.map((p) => ({ id: p.id, name: p.name })));
      this.libraries.set(libs);
    }

    try {
      const details = await this.metadata.getDetails(provider, type, externalId);
      this.media.set(details);
      this.navbar.enterHeroPage(details.title);
      // Only relevant when the Request button could show: admins who can
      // import never see the "déjà demandé" badge anyway.
      if (this.canRequest()) {
        await this.loadExistingRequests(details.tmdbId);
      }
    } catch {
      this.error.set(this.translate.instant('discover.preview_error'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Load every active request and keep the ones tied to this tmdbId.
   *  Server-side filter on tmdbId would be cleaner but the endpoint
   *  doesn't expose it yet — mirrors the search page pattern. */
  private async loadExistingRequests(tmdbId: number) {
    try {
      const res = await this.requestsApi.list({ limit: 200 });
      this.existingRequests.set(
        res.data.filter((r) => r.tmdbId === tmdbId && r.mediaType === this.type()),
      );
    } catch { /* ignore */ }
  }

  /** Called by the request modal after a successful POST so the page
   *  flips to the "déjà demandé" state without a manual refresh. */
  protected refreshExistingRequests() {
    const m = this.media();
    if (m) void this.loadExistingRequests(m.tmdbId);
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
    this.requestModal()?.open({
      title: m.title,
      mediaType: this.type() as 'movie' | 'series',
      tmdbId: m.tmdbId,
      alreadyRequestedSeasons: this.requestedSeasons(),
    });
  }
}

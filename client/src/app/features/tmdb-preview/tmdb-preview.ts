import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  computed,
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
import { RequestModalComponent } from './components/request-modal/request-modal.component';
import { ImportModalComponent } from './components/import-modal/import-modal.component';
import { MediaType } from '../../core/enums/media-type.enum';
import { LucideFilm } from '@lucide/angular';
import { MobileFanartHeroComponent } from '../../shared/components/mobile-fanart-hero';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

@Component({
  selector: 'app-tmdb-preview',
  imports: [FormsModule, CurrencyPipe, DatePipe, DecimalPipe, TranslateModule, ResolveUrlPipe, RequestModalComponent, ImportModalComponent, MobileFanartHeroComponent, LucideFilm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tmdb-preview.html',
})
export class TmdbPreviewComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly metadata = inject(MetadataService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly translate = inject(TranslateService);
  private readonly navbar = inject(NavbarService);
  readonly auth = inject(AuthService);

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

  private readonly requestModal = viewChild(RequestModalComponent);
  private readonly importModal = viewChild(ImportModalComponent);

  ngOnDestroy() {
    this.navbar.leaveHeroPage();
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
    } catch {
      this.error.set(this.translate.instant('discover.preview_error'));
    } finally {
      this.loading.set(false);
    }
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
    });
  }
}

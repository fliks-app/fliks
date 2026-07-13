import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe, CurrencyPipe } from '@angular/common';
import { Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucidePlay } from '@lucide/angular';
import { Media } from '../../../core/services/api/media.service';
import { localizeLanguage } from '../../../core/utils/language.utils';

/**
 * "Extra info" panel rendered on the media-detail page above the cast,
 * matching the Jellyseerr-style key/value table. Backed by `Media` +
 * `Media.metadata`. Every row is hidden when its source field is empty,
 * so the panel collapses to nothing on freshly imported media that
 * haven't pulled extended TMDB data yet.
 */
@Component({
  selector: 'app-media-info-extra',
  imports: [DatePipe, CurrencyPipe, TranslateModule, LucidePlay],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-info-extra.html',
})
export class MediaInfoExtraComponent {
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly trailerDialog =
    viewChild<ElementRef<HTMLDialogElement>>('trailerDialog');

  /** Best YouTube trailer key from the stored TMDB videos (Trailer → Teaser →
   *  any). Null when the imported metadata carries no video. */
  readonly trailerKey = computed<string | null>(() => {
    const vids = (this.media().metadata?.videos ?? []).filter(
      (v) => v.site === 'YouTube',
    );
    const pick =
      vids.find((v) => v.type === 'Trailer') ??
      vids.find((v) => v.type === 'Teaser') ??
      vids[0];
    return pick?.key ?? null;
  });

  /** Sanitized embed URL, set only while the dialog is open so playback stops
   *  on close. */
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

  readonly media = input.required<Media>();
  /** Director names. Sourced from `Media.crew` filtered by job — kept as a
   *  separate input because crew isn't exposed on the Media interface yet. */
  readonly directors = input<string[]>([]);

  readonly directorsLabel = computed(() => this.directors().join(', '));

  /** TMDB user-score expressed as a percentage. `null` if missing. */
  readonly tmdbScore = computed(() => {
    const r = this.media().rating;
    return r != null && r > 0 ? Math.round(r * 10) : null;
  });

  /** Translated status label (`media_detail.info_status_<value>`), or the
   *  raw enum value if no translation exists. */
  readonly statusLabel = computed(() => {
    const s = this.media().status;
    if (!s) return '';
    const key = `media_detail.info_status_${s}`;
    const t = this.translate.instant(key);
    return typeof t === 'string' && t !== key ? t : s;
  });

  /** Original title as returned by the provider; shown whenever present. */
  readonly originalTitle = computed(() => this.media().originalTitle ?? '');

  readonly originalLanguage = computed(() =>
    localizeLanguage(this.media().metadata?.originalLanguage, this.translate),
  );

  readonly productionCountries = computed(() =>
    (this.media().metadata?.productionCountries ?? []).join(', '),
  );

  readonly productionCompanies = computed(() =>
    (this.media().metadata?.productionCompanies ?? []).join(', '),
  );

  readonly tagline = computed(() => this.media().metadata?.tagline ?? '');

  readonly budget = computed(() => this.media().metadata?.budget ?? null);

  readonly revenue = computed(() => this.media().metadata?.revenue ?? null);

  readonly genres = computed(() => this.media().genres ?? []);

  navigateToGenre(genre: string) {
    const libraryName = this.media().library?.name;
    if (!libraryName) return;
    void this.router.navigate(['/libraries', libraryName], { queryParams: { genre } });
  }

  /** True when at least one row has content — keeps the parent template
   *  from rendering an empty wrapper / divider. */
  readonly hasAnyContent = computed(() => {
    const m = this.media();
    return !!(
      this.tmdbScore() != null ||
      this.originalTitle() ||
      m.status ||
      m.releaseDate ||
      this.originalLanguage() !== 'und' ||
      this.productionCountries() ||
      this.productionCompanies() ||
      this.tagline() ||
      this.budget() ||
      this.revenue() ||
      this.genres().length > 0 ||
      this.directorsLabel() ||
      this.trailerKey()
    );
  });
}

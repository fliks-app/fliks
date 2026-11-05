import {
  Component,
  computed,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucidePlay } from '@lucide/angular';
import { Media } from '../../../core/services/api/media.service';
import { localizeLanguage } from '../../../core/utils/language.utils';
import { FactsGridComponent, type Fact } from '../facts-grid/facts-grid';
import { DetailSectionComponent } from '../detail-section/detail-section';
import { bestTrailerKey } from '../../utils/trailer.util';
import { TrailerDialogComponent } from '../trailer-dialog/trailer-dialog';

/** Jellyseerr-style "Extra info" table on the media-detail page; rows with an empty source hide, so freshly imported media collapse to nothing. */
@Component({
  selector: 'app-media-info-extra',
  imports: [FactsGridComponent, TranslatePipe, DetailSectionComponent, LucidePlay, TrailerDialogComponent],
  templateUrl: './media-info-extra.html',
})
export class MediaInfoExtraComponent {
  private readonly translate = inject(TranslateService);
  private readonly trailerDialog = viewChild(TrailerDialogComponent);

  /** Best YouTube trailer key from the stored TMDB videos (Trailer → Teaser →
   *  any). Null when the imported metadata carries no video. */
  readonly trailerKey = computed(() => bestTrailerKey(this.media().metadata?.videos));

  openTrailer() {
    const key = this.trailerKey();
    if (key) this.trailerDialog()?.open(key);
  }

  readonly media = input.required<Media>();
  /** Director names. Sourced from `Media.crew` filtered by job, kept as a
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

  readonly facts = computed<Fact[]>(() => [
    { label: 'discover.preview_original_title', value: this.originalTitle() },
    { label: 'discover.preview_release_date', value: this.media().releaseDate, format: 'date' },
    { label: 'discover.preview_original_language', value: this.originalLanguage() !== 'und' ? this.originalLanguage() : null },
    { label: 'discover.preview_countries', value: this.productionCountries() },
    { label: 'discover.preview_studios', value: this.productionCompanies() },
    { label: 'media_info.directors', value: this.directorsLabel() },
    { label: 'discover.preview_budget', value: this.budget(), format: 'currency' },
    { label: 'discover.preview_revenue', value: this.revenue(), format: 'currency' },
  ]);

  /** True when at least one row has content, keeps the parent template
   *  from rendering an empty wrapper / divider. */
  readonly hasAnyContent = computed(() => {
    const m = this.media();
    return !!(
      this.tmdbScore() != null ||
      this.originalTitle() ||
      m.releaseDate ||
      this.originalLanguage() !== 'und' ||
      this.productionCountries() ||
      this.productionCompanies() ||
      this.tagline() ||
      this.budget() ||
      this.revenue() ||
      this.directorsLabel() ||
      this.trailerKey()
    );
  });
}

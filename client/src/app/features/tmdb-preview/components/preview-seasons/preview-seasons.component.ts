import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  MetadataSeason,
  MetadataService,
} from '../../../../core/services/api/metadata.service';
import { LocaleDatePipe } from '../../../../core/pipes/locale-date.pipe';
import { SeasonLabelPipe } from '../../../../core/pipes/season-label.pipe';
import { ImgFadeInDirective } from '../../../../shared/directives/img-fade-in.directive';
import { ClampToggleDirective } from '../../../../shared/directives/clamp-toggle.directive';
import { TvRowDirective } from '../../../../shared/directives/tv-row.directive';

@Component({
  selector: 'app-preview-seasons',
  imports: [
    TranslateModule,
    LocaleDatePipe,
    SeasonLabelPipe,
    ImgFadeInDirective,
    ClampToggleDirective,
    TvRowDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './preview-seasons.component.html',
  host: { class: 'block' },
})
export class PreviewSeasonsComponent {
  private readonly metadata = inject(MetadataService);

  readonly provider = input.required<string>();
  readonly externalId = input.required<string>();

  readonly seasons = signal<MetadataSeason[]>([]);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly activeSeasonNumber = signal<number | null>(null);

  readonly activeSeason = computed(
    () =>
      this.seasons().find((s) => s.seasonNumber === this.activeSeasonNumber()) ??
      null,
  );

  /**
   * One provider call per season upstream, so it waits for the section to be
   * opened rather than firing on every series preview.
   */
  private readonly loadEffect = effect(() => {
    const id = this.externalId();
    const provider = this.provider();
    if (!id) return;
    this.seasons.set([]);
    this.activeSeasonNumber.set(null);
    this.failed.set(false);
    this.loading.set(true);
    this.metadata
      .getSeasons(provider, id)
      .then((seasons) => {
        this.seasons.set(seasons);
        this.activeSeasonNumber.set(seasons[0]?.seasonNumber ?? null);
      })
      .catch(() => this.failed.set(true))
      .finally(() => this.loading.set(false));
  });

  selectSeason(seasonNumber: number) {
    this.activeSeasonNumber.set(seasonNumber);
  }
}

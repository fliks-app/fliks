import { Pipe, PipeTransform, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

/**
 * Season heading: "Specials" for season 0, "Season N" otherwise.
 *
 * Impure because the translation table loads asynchronously and changes when
 * the user switches locale.
 */
@Pipe({ name: 'seasonLabel', pure: false })
export class SeasonLabelPipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(seasonNumber: number | null | undefined): string {
    if (seasonNumber === 0) return this.translate.instant('media_detail.specials');
    return this.translate.instant('media_detail.season_number', { number: seasonNumber });
  }
}

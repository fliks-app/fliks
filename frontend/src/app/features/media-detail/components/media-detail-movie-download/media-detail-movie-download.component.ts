import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { Media } from '../../../../core/services/api/media.service';

@Component({
  selector: 'app-media-detail-movie-download',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-movie-download.component.html',
})
export class MediaDetailMovieDownloadComponent {
  readonly media = input.required<Media>();
  readonly showUpgradeSection = input(false);
  readonly showDownloadSection = input(true);
  readonly canGrab = input(false);
  readonly upgradeReleasesLoading = input(false);
  readonly upgradeGrabBusy = input<string | null>(null);
  readonly releasesLoading = input(false);
  readonly grabBusy = input<string | null>(null);

  readonly loadUpgradeReleases = output<void>();
  readonly grabUpgradeBest = output<void>();
  readonly loadReleases = output<void>();
  readonly grabBest = output<void>();
}

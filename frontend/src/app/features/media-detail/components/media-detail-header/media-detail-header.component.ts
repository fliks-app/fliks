import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Media } from '../../../../core/services/api/media.service';

@Component({
  selector: 'app-media-detail-header',
  imports: [DecimalPipe, RouterLink, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-header.component.html',
})
export class MediaDetailHeaderComponent {
  readonly media = input.required<Media>();
  readonly backRoute = input<string[]>(['/']);
  readonly canEditProfiles = input(false);
  readonly isAdmin = input(false);
  readonly refreshLoading = input(false);
  readonly monitoredLoading = input(false);
  readonly deleteLoading = input(false);

  readonly openProfiles = output<void>();
  readonly openRootFolder = output<void>();
  readonly refreshMetadata = output<void>();
  readonly toggleMonitored = output<void>();
  readonly deleteMedia = output<void>();
}

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { Media } from '../../../../core/services/api/media.service';

@Component({
  selector: 'app-media-detail-library-info',
  imports: [DecimalPipe, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-library-info.component.html',
})
export class MediaDetailLibraryInfoComponent {
  readonly media = input.required<Media>();
}

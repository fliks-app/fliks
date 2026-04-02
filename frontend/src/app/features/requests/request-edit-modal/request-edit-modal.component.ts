import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { SuitarrRequestRow } from '../../../core/services/api/requests.service';

@Component({
  selector: 'app-request-edit-modal',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './request-edit-modal.component.html',
})
export class RequestEditModalComponent {
  readonly row = input<SuitarrRequestRow | null>(null);
  readonly qualityProfiles = input<{ id: number; name: string }[]>([]);
  readonly languageProfiles = input<{ id: number; name: string }[]>([]);
  readonly qualityProfileId = input<number | null>(null);
  readonly languageProfileId = input<number | null>(null);
  readonly saving = input(false);

  readonly qualityProfileIdChange = output<number | null>();
  readonly languageProfileIdChange = output<number | null>();
  readonly dismissed = output<void>();
  readonly save = output<void>();
}

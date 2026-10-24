import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PartyService } from '../../../core/services/party/party.service';

/** Chat bubbles (panel closed) and reactions rising over the video; never takes a pointer event. */
@Component({
  selector: 'app-party-floaters',
  imports: [TranslatePipe],
  templateUrl: './party-floaters.html',
  styleUrl: './party-floaters.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyFloatersComponent {
  protected readonly party = inject(PartyService);
}

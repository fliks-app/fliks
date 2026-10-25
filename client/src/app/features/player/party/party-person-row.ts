import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideMic, LucideMicOff } from '@lucide/angular';
import { UserAvatarComponent } from '../../../shared/components/user-avatar/user-avatar';
import { type PartyPerson } from './party-people';

/** One person of the party, in the party page and in the player panel; projected content sits after the badges. */
@Component({
  selector: 'app-party-person-row',
  imports: [TranslatePipe, LucideMic, LucideMicOff, UserAvatarComponent],
  templateUrl: './party-person-row.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex items-center gap-3 rounded-lg p-2' },
})
export class PartyPersonRowComponent {
  readonly person = input.required<PartyPerson>();
}

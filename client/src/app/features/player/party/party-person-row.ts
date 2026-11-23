import { Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../../shared/icons';
import { UserAvatarComponent } from '../../../shared/components/user-avatar/user-avatar';
import { type PartyPerson } from './party-people';

/** One person of the party, in the party page and in the player panel; projected content sits after the badges. */
@Component({
  selector: 'app-party-person-row',
  imports: [TranslatePipe, UserAvatarComponent, LucideDynamicIcon],
  templateUrl: './party-person-row.html',
  host: { class: 'flex items-center gap-3 rounded-lg p-2' },
})
export class PartyPersonRowComponent {
  protected readonly icons = icons;

  readonly person = input.required<PartyPerson>();
}

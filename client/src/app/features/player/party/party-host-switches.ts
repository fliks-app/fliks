import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { type PartySwitches } from '../../../core/services/api/party-api.service';
import { TvSectionDirective } from '../../../shared/directives/tv-section.directive';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';

const KEYS = ['policy', 'reactionsEnabled', 'chatEnabled', 'linkSharing', 'public'] as const;

/** The switches of `to` that differ from `from`. */
export function switchesPatch(from: PartySwitches, to: PartySwitches): Partial<PartySwitches> {
  return Object.fromEntries(KEYS.filter((k) => from[k] !== to[k]).map((k) => [k, to[k]]));
}

/** The host's party-wide switches, shared by the player's settings dialog and the party page. */
@Component({
  selector: 'app-party-host-switches',
  imports: [TranslatePipe, TvSectionDirective, ToggleFieldComponent],
  templateUrl: './party-host-switches.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyHostSwitchesComponent {
  readonly value = input.required<PartySwitches>();
  readonly disabled = input(false);
  readonly changed = output<Partial<PartySwitches>>();
}

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideSmilePlus } from '@lucide/angular';
import { PARTY_EMOJIS } from '../../../core/services/api/party-api.service';
import { PartyService } from '../../../core/services/party/party.service';

/** Floating reaction button over the video: opens a row of emojis to its left, one tap sends and folds it back. */
@Component({
  selector: 'app-party-reaction-dock',
  imports: [TranslatePipe, LucideSmilePlus],
  templateUrl: './party-reaction-dock.html',
  styleUrl: './party-reaction-dock.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The player wakes its controls on any click or pointer move; the dock is used without them.
  host: { '(click)': '$event.stopPropagation()', '(mousemove)': '$event.stopPropagation()' },
})
export class PartyReactionDockComponent {
  protected readonly party = inject(PartyService);
  protected readonly emojis = PARTY_EMOJIS;
  protected readonly open = signal(false);

  protected send(emoji: string): void {
    this.party.react(emoji);
    this.open.set(false);
  }
}

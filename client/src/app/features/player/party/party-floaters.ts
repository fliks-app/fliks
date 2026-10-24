import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PartyEmojiComponent } from './party-emoji';
import { PartyService, REACTION_MS } from '../../../core/services/party/party.service';

/** Chat bubbles (panel closed) and reactions rising over the video; never takes a pointer event. */
@Component({
  selector: 'app-party-floaters',
  imports: [TranslatePipe, PartyEmojiComponent],
  templateUrl: './party-floaters.html',
  styleUrl: './party-floaters.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.--reaction-ms]': 'reactionMs' },
})
export class PartyFloatersComponent {
  protected readonly party = inject(PartyService);
  protected readonly reactionMs = `${REACTION_MS}ms`;
}

import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { CastService } from '../cast.service';
import { PartyService } from './party.service';
import { ReactionsService } from './reactions.service';

/** Relays the party's floating reactions and chat to the Chromecast receiver, wherever the phone is in the app. */
@Injectable({ providedIn: 'root' })
export class CastPartyRelayService {
  private readonly party = inject(PartyService);
  private readonly reactions = inject(ReactionsService);
  private readonly cast = inject(CastService);
  private readonly translate = inject(TranslateService);

  constructor() {
    this.party.floated.subscribe((f) => {
      if (!this.cast.isConnected()) return;
      if (f.kind === 'reaction') {
        if (!this.reactions.enabled() || !this.party.reactionsEnabled()) return;
        const path = this.reactions.animationPath(f.emoji);
        const base = this.cast.castStreamBaseUrl();
        this.cast.sendFliks({
          kind: 'party_reaction',
          emoji: f.emoji,
          username: f.username,
          img: path && base ? base + path : null,
        });
      } else if (this.party.chatEnabled()) {
        const m = f.message;
        this.cast.sendFliks({
          kind: 'party_chat',
          id: m.id,
          username: m.username ?? '',
          text: m.text,
          sep: this.translate.instant('party.chat_name_sep'),
        });
      }
    });
  }
}

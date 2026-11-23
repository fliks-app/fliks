import { Component, computed, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../../shared/icons';
import { VoiceService } from '../../../core/services/party/voice.service';
import { PartyService } from '../../../core/services/party/party.service';
import { TranslatePluralPipe } from '../../../core/pipes/translate-plural.pipe';

/** Join/leave voice and mic mute (`full`, the lobby), or its two halves for the player panel header; ducking lives in the player's party settings. */
@Component({
  selector: 'app-party-voice-bar',
  imports: [TranslatePipe, TranslatePluralPipe, LucideDynamicIcon],
  templateUrl: './party-voice-bar.html',
  host: { '[class.hidden]': '!shown()' },
})
export class PartyVoiceBarComponent {
  protected readonly icons = icons;

  protected readonly voice = inject(VoiceService);
  private readonly party = inject(PartyService);
  protected readonly shown = computed(
    () => this.voice.supported && (this.variant() !== 'hint' || this.voice.joined() || this.voice.blocked()),
  );
  /** People in the voice channel, a user with two devices counted once. */
  protected readonly inVoice = computed(
    () => new Set(this.party.members().filter((m) => m.voice && m.status !== 'away').map((m) => m.userId)).size,
  );
  readonly variant = input<'full' | 'controls' | 'hint'>('full');
}

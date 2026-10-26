import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideMic, LucideMicOff, LucideUser, LucideVolume2 } from '@lucide/angular';
import { VoiceService } from '../../../core/services/party/voice.service';
import { PartyService } from '../../../core/services/party/party.service';
import { TranslatePluralPipe } from '../../../core/pipes/translate-plural.pipe';

/** Join/leave voice and mic mute (`full`, the lobby), or its two halves for the player panel header; ducking lives in the player's party settings. */
@Component({
  selector: 'app-party-voice-bar',
  imports: [TranslatePipe, TranslatePluralPipe, LucideMic, LucideMicOff, LucideUser, LucideVolume2],
  templateUrl: './party-voice-bar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyVoiceBarComponent {
  protected readonly voice = inject(VoiceService);
  private readonly party = inject(PartyService);
  /** People in the voice channel, a user with two devices counted once. */
  protected readonly inVoice = computed(
    () => new Set(this.party.members().filter((m) => m.voice && m.status !== 'away').map((m) => m.userId)).size,
  );
  readonly variant = input<'full' | 'controls' | 'hint'>('full');
}

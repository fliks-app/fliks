import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideHeadphones, LucideMic, LucideMicOff, LucideVolume1 } from '@lucide/angular';
import { VoiceService } from '../../../core/services/party/voice.service';

/** Join/leave voice, mic mute and ducking (`full`, the lobby), or its two halves for the player panel header. */
@Component({
  selector: 'app-party-voice-bar',
  imports: [TranslatePipe, LucideHeadphones, LucideMic, LucideMicOff, LucideVolume1],
  templateUrl: './party-voice-bar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyVoiceBarComponent {
  protected readonly voice = inject(VoiceService);
  readonly variant = input<'full' | 'controls' | 'hint'>('full');
}

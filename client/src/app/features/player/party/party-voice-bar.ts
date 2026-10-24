import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideHeadphones, LucideMic, LucideMicOff } from '@lucide/angular';
import { VoiceService } from '../../../core/services/party/voice.service';

/** Join/leave voice, mic mute and ducking, shared by the player panel and the lobby. */
@Component({
  selector: 'app-party-voice-bar',
  imports: [TranslatePipe, LucideHeadphones, LucideMic, LucideMicOff],
  templateUrl: './party-voice-bar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyVoiceBarComponent {
  protected readonly voice = inject(VoiceService);

  protected setDuck(event: Event): void {
    this.voice.setDuck((event.target as HTMLInputElement).checked);
  }
}

import { ChangeDetectionStrategy, Component, effect, inject, output, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCrown, LucideMic, LucideMicOff, LucideSettings, LucideUsers, LucideX } from '@lucide/angular';
import { DeviceService } from '../../../core/services/device.service';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { DismissableStackService } from '../../../core/services/dismissable-stack.service';
import { VoiceService } from '../../../core/services/party/voice.service';
import { PartyService } from '../../../core/services/party/party.service';
import { TvSectionDirective } from '../../../shared/directives/tv-section.directive';
import { PartyChatComponent } from './party-chat';
import { PartyVoiceBarComponent } from './party-voice-bar';

@Component({
  selector: 'app-party-panel',
  imports: [TranslatePipe, LucideCrown, LucideMic, LucideMicOff, LucideSettings, LucideUsers, LucideX, TvSectionDirective, PartyChatComponent, PartyVoiceBarComponent],
  templateUrl: './party-panel.html',
  styleUrl: './party-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-dock]': 'party.dock()', '[class.party-tv]': 'isTv()', '[style.padding-bottom.px]': 'keyboard.height()' },
})
export class PartyPanelComponent {
  protected readonly party = inject(PartyService);
  protected readonly voice = inject(VoiceService);
  private readonly dismissStack = inject(DismissableStackService);
  protected readonly isTv = inject(DeviceService).isTv;
  protected readonly keyboard = inject(KeyboardOverlayService);
  readonly openSettings = output<void>();

  protected readonly showMembers = signal(false);

  constructor() {
    // Back closes the panel before it leaves the player.
    effect((onCleanup) => {
      if (!this.party.panelOpen()) return;
      const close = () => this.party.setPanelOpen(false);
      this.dismissStack.push(close);
      onCleanup(() => this.dismissStack.remove(close));
    });
  }

  protected close(): void {
    this.party.setPanelOpen(false);
  }
}

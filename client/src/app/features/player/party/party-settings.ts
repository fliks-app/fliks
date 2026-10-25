import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, inject, output, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideRefreshCw } from '@lucide/angular';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { VoiceService } from '../../../core/services/party/voice.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { PartyService } from '../../../core/services/party/party.service';
import { PartyController } from '../party-controller';
import { PartyHostSwitchesComponent } from './party-host-switches';

/** Party settings, opened from the party panel; lives in the player so it shows in fullscreen. */
@Component({
  selector: 'app-party-settings',
  imports: [TranslatePipe, LucideRefreshCw, ModalHeaderComponent, PartyHostSwitchesComponent, ToggleFieldComponent],
  templateUrl: './party-settings.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartySettingsComponent {
  protected readonly party = inject(PartyService);
  protected readonly voice = inject(VoiceService);
  protected readonly keyboard = inject(KeyboardOverlayService);
  private readonly controller = inject(PartyController);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  /** The player mounts the dialog to open it and drops it on close. */
  readonly closed = output<void>();

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
    });
  }

  protected resync(): void {
    this.controller.resync();
    this.dialog().nativeElement.close();
  }

}

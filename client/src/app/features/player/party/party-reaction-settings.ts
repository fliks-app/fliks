import { ChangeDetectionStrategy, Component, ElementRef, inject, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PartyService } from '../../../core/services/party/party.service';
import { EnabledSwitchComponent } from '../../../shared/components/enabled-switch';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';

/** Reaction settings, opened from the player's top-bar reaction button; lives in the player so it shows in fullscreen. */
@Component({
  selector: 'app-party-reaction-settings',
  imports: [TranslatePipe, EnabledSwitchComponent, ModalHeaderComponent],
  templateUrl: './party-reaction-settings.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyReactionSettingsComponent {
  protected readonly party = inject(PartyService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  show(): void {
    this.dialog().nativeElement.showModal();
  }
}

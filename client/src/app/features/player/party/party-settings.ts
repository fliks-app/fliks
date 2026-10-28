import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, output, signal, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideRefreshCw } from '@lucide/angular';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { VoiceService } from '../../../core/services/party/voice.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { TvSectionDirective } from '../../../shared/directives/tv-section.directive';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { PartyService } from '../../../core/services/party/party.service';
import { PartySync } from '../../../core/services/party/party-sync';
import type { PartySwitches } from '../../../core/services/api/party-api.service';
import { PartyHostSwitchesComponent, switchesPatch } from './party-host-switches';

/** Party settings, opened from the party panel; lives in the player so it shows in fullscreen. */
@Component({
  selector: 'app-party-settings',
  imports: [TranslatePipe, LucideRefreshCw, ModalHeaderComponent, TvSectionDirective, PartyHostSwitchesComponent, ToggleFieldComponent],
  templateUrl: './party-settings.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartySettingsComponent {
  protected readonly party = inject(PartyService);
  protected readonly voice = inject(VoiceService);
  protected readonly keyboard = inject(KeyboardOverlayService);
  private readonly confirm = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly controller = inject(PartySync);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  /** The player mounts the dialog to open it and drops it on close. */
  readonly closed = output<void>();
  /** The host's unsaved switches; null until one is touched. */
  protected readonly draft = signal<PartySwitches | null>(null);
  private readonly patch = computed(() => {
    const p = this.party.party();
    const d = this.draft();
    return p && d ? switchesPatch(p, d) : {};
  });
  protected readonly dirty = computed(() => Object.keys(this.patch()).length > 0);

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
    });
  }

  protected async save(): Promise<void> {
    await this.party.updateSettings(this.patch());
    this.draft.set(null);
  }

  protected resync(): void {
    this.controller.resync();
    this.dialog().nativeElement.close();
  }

  protected async leave(): Promise<void> {
    this.dialog().nativeElement.close();
    await this.controller.leave();
  }

  protected async end(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('party.end_title'),
      message: this.translate.instant('party.end_message', { name: this.party.party()?.name }),
      variant: 'danger',
    });
    if (!ok) return;
    this.dialog().nativeElement.close();
    await this.party.end();
  }
}

import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideTrash2 } from '@lucide/angular';
import {
  PlayerSettings,
  PlayerSettingsService,
} from '../../../core/services/player-settings.service';
import { BrowserDeviceProfileService } from '../../../core/services/browser-device-profile.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import { persistOnChange } from '../../../core/utils/persist-on-change';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';
import { AUDIO_SELECTION_MODE_OPTIONS, LANGUAGE_OPTIONS } from '../playback-options';

@Component({
  selector: 'app-player-settings',
  imports: [
    FormsModule,
    TranslatePipe,
    LucideTrash2,
    ToggleFieldComponent,
    SelectFieldComponent,
  ],
  templateUrl: './player-settings.html',
})
export class PlayerSettingsPageComponent {
  private readonly ps = inject(PlayerSettingsService);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly languageOptions = LANGUAGE_OPTIONS;
  readonly audioModeOptions = AUDIO_SELECTION_MODE_OPTIONS;

  private readonly initial = this.ps.get();
  readonly preferredAudioLanguage = signal(this.initial.preferredAudioLanguage);
  readonly audioSelectionMode = signal<PlayerSettings['audioSelectionMode']>(
    this.initial.audioSelectionMode,
  );
  readonly rememberAudioSelections = signal(this.initial.rememberAudioSelections);
  readonly forceDisableHdr = signal(this.initial.forceDisableHdr);
  readonly showEcoQualities = signal(this.initial.showEcoQualities);
  readonly autoSkipIntro = signal(this.initial.autoSkipIntro);
  readonly autoPlayNext = signal(this.initial.autoPlayNext);
  readonly showHdrToggle = signal(this.deviceProfile.hardwareSupportsHdr);

  constructor() {
    persistOnChange(
      () => ({
        preferredAudioLanguage: this.preferredAudioLanguage(),
        audioSelectionMode: this.audioSelectionMode(),
        rememberAudioSelections: this.rememberAudioSelections(),
        forceDisableHdr: this.forceDisableHdr(),
        showEcoQualities: this.showEcoQualities(),
        autoSkipIntro: this.autoSkipIntro(),
        autoPlayNext: this.autoPlayNext(),
      }),
      // Spread first: other pages own fields of this store.
      (values) => this.ps.save({ ...this.ps.get(), ...values }),
    );
  }

  async clearAudioSelections() {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('playback_settings.player_clear_saved'),
      message: this.translate.instant('playback_settings.player_clear_saved_confirm'),
      confirmLabel: this.translate.instant('common.clear'),
      variant: 'danger',
    });
    if (!confirmed) return;
    this.ps.clearRememberedAudioTracks();
    this.toast.success(this.translate.instant('common.selections_cleared'));
  }
}

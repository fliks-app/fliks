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
import { DeviceService } from '../../../core/services/device.service';
import { UsersApiService } from '../../../core/services/api/users-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { persistOnChange } from '../../../core/utils/persist-on-change';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';
import { AUDIO_SELECTION_MODE_OPTIONS, LANGUAGE_CODE_OPTIONS } from '../playback-options';
import { LocalizeLanguagePipe } from '../../../core/pipes/localize-language.pipe';

@Component({
  selector: 'app-player-settings',
  imports: [
    FormsModule,
    TranslatePipe,
    LocalizeLanguagePipe,
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
  private readonly device = inject(DeviceService);
  private readonly usersApi = inject(UsersApiService);
  private readonly auth = inject(AuthService);

  readonly languageOptions = LANGUAGE_CODE_OPTIONS;
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
  readonly backgroundAudio = signal(this.initial.backgroundAudio);
  readonly landscapeOnOpen = signal(this.initial.landscapeOnOpen);
  readonly edlEnabled = signal(this.auth.user()?.edlEnabled ?? true);
  readonly edlAutoSkip = signal(this.auth.user()?.edlAutoSkipCommercials !== false);
  readonly showBackgroundAudio =
    (this.device.isAndroidNative() || this.device.isIosNative()) && !this.device.isTv();
  // Shortest screen side, not the viewport: stays a phone when held in landscape.
  readonly showLandscapeOnOpen =
    this.showBackgroundAudio && Math.min(screen.width, screen.height) < 600;
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
        backgroundAudio: this.backgroundAudio(),
        landscapeOnOpen: this.landscapeOnOpen(),
      }),
      // Spread first: other pages own fields of this store.
      (values) => this.ps.save({ ...this.ps.get(), ...values }),
    );
  }

  async onEdlEnabledChange(value: boolean): Promise<void> {
    this.edlEnabled.set(value);
    const user = this.auth.user();
    if (!user) return;
    try {
      await this.usersApi.update(user.id, { edlEnabled: value });
      this.auth.patchUser({ edlEnabled: value });
      this.toast.success(this.translate.instant('playback_settings.player_edl_saved'));
    } catch {
      this.edlEnabled.set(user.edlEnabled ?? true);
    }
  }

  async onEdlAutoSkipChange(value: boolean): Promise<void> {
    this.edlAutoSkip.set(value);
    const user = this.auth.user();
    if (!user) return;
    try {
      await this.usersApi.update(user.id, { edlAutoSkipCommercials: value });
      this.auth.patchUser({ edlAutoSkipCommercials: value });
      this.toast.success(this.translate.instant('playback_settings.player_edl_saved'));
    } catch {
      this.edlAutoSkip.set(user.edlAutoSkipCommercials !== false);
    }
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
